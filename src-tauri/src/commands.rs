//! The command layer: thin, the logic lives in pure modules (`demo_db`).

use crate::demo_db::{DemoDb, MAX_ROWS, QueryResult};
use crate::error::{AppError, AppResult, ErrorCode};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// The demo database of the walking skeleton, created on first use.
#[derive(Default)]
pub struct DemoState(Mutex<Option<DemoDb>>);

/// Runs one statement on the demo database. `async`: off the main thread, the window stays responsive.
#[tauri::command(async)]
pub fn run_demo_query(state: State<'_, DemoState>, sql: String) -> AppResult<QueryResult> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Io, "demo database is not available"))?;
    if guard.is_none() {
        *guard = Some(DemoDb::new()?);
    }
    match guard.as_ref() {
        Some(db) => db.run(&sql, MAX_ROWS),
        None => Err(AppError::new(
            ErrorCode::Io,
            "demo database is not available",
        )),
    }
}

/// `#rrggbb` → channels.
pub fn parse_hex_rgb(color: &str) -> Option<(u8, u8, u8)> {
    let hex = color.strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
    Some((channel(0)?, channel(2)?, channel(4)?))
}

/// The window frame follows the colour scheme. `dark` forces the frame's appearance; `None` (follow
/// the system) leaves it to the system, because the frame's appearance also sets the webview's
/// `prefers-color-scheme` and a forced one would no longer follow the system. The window starts
/// hidden (`visible: false`) so a light scheme does not flash dark; the first call shows it.
#[tauri::command]
pub fn set_window_chrome(app: AppHandle, color: String, dark: Option<bool>) -> AppResult<()> {
    let (r, g, b) = parse_hex_rgb(&color)
        .ok_or_else(|| AppError::new(ErrorCode::Unsupported, "not a #rrggbb colour"))?;
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let io = |e: tauri::Error| AppError::new(ErrorCode::Io, e.to_string());
    let theme = dark.map(|d| {
        if d {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }
    });
    window.set_theme(theme).map_err(io)?;
    window
        .set_background_color(Some(tauri::window::Color(r, g, b, 255)))
        .map_err(io)?;
    show_main(&app);
    Ok(())
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main")
        && !window.is_visible().unwrap_or(true)
    {
        let _ = window.show();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_six_digit_hex() {
        assert_eq!(parse_hex_rgb("#14171c"), Some((0x14, 0x17, 0x1c)));
        assert_eq!(parse_hex_rgb("#FFF"), None);
        assert_eq!(parse_hex_rgb("14171c"), None);
        assert_eq!(parse_hex_rgb("#14171g"), None);
        assert_eq!(parse_hex_rgb("#ééé"), None);
    }
}
