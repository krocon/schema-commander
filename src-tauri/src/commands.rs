//! The command layer: thin, the logic lives in pure modules (`db`, `themes`).

use crate::db::Profile;
use crate::db::manager::{ConnectionInfo, ConnectionManager};
use crate::db::profiles::LoadedProfiles;
use crate::db::secrets::Secret;
use crate::db::value::QueryResult;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::session::{LoadedSession, SessionDir, SessionFile};
use crate::textfile::{self, TextFile};
use crate::themes::{self, LoadedThemes, ThemesFile, UserTheme};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

/// The stored connections, the demo database first (prompt 003). Never a secret.
#[tauri::command(async)]
pub fn list_connections(manager: State<'_, ConnectionManager>) -> LoadedProfiles {
    manager.list()
}

/// Stores a profile; `password` goes into the keychain when the profile says so, never into a file.
#[tauri::command(async)]
pub fn save_connection(
    manager: State<'_, ConnectionManager>,
    profile: Profile,
    password: Option<Secret>,
) -> AppResult<Profile> {
    manager.save(profile, password)
}

#[tauri::command(async)]
pub fn delete_connection(manager: State<'_, ConnectionManager>, id: String) -> AppResult<()> {
    manager.delete(&id)
}

/// Tries a profile without keeping the connection; answers with the server's version.
#[tauri::command(async)]
pub fn test_connection(
    manager: State<'_, ConnectionManager>,
    profile: Profile,
    password: Option<Secret>,
) -> AppResult<String> {
    manager.test(&profile, password)
}

/// Connects. `secret_required` asks the frontend for a password.
#[tauri::command(async)]
pub fn open_connection(
    manager: State<'_, ConnectionManager>,
    id: String,
    password: Option<Secret>,
) -> AppResult<ConnectionInfo> {
    manager.open(&id, password)
}

#[tauri::command(async)]
pub fn close_connection(manager: State<'_, ConnectionManager>, id: String) {
    manager.close(&id);
}

/// Runs one statement on an open connection. `async`: off the main thread, the window stays responsive.
#[tauri::command(async)]
pub fn run_query(
    manager: State<'_, ConnectionManager>,
    id: String,
    sql: String,
) -> AppResult<QueryResult> {
    manager.run(&id, &sql)
}

/// Stops the statement that runs on a connection.
#[tauri::command(async)]
pub fn cancel_query(manager: State<'_, ConnectionManager>, id: String) {
    manager.cancel(&id);
}

/// The open tabs of the last run (prompt 004). Text files no tab owns any more are removed.
#[tauri::command(async)]
pub fn load_session(dir: State<'_, SessionDir>) -> LoadedSession {
    let loaded = dir.load();
    let keep: Vec<&str> = loaded.session.tabs.iter().map(|t| t.id.as_str()).collect();
    dir.sweep(&keep);
    loaded
}

#[tauri::command(async)]
pub fn save_session(dir: State<'_, SessionDir>, session: SessionFile) -> AppResult<()> {
    dir.save(&session)
}

#[tauri::command(async)]
pub fn load_tab_text(dir: State<'_, SessionDir>, id: String) -> AppResult<String> {
    dir.load_text(&id)
}

/// The running backup of a tab's text.
#[tauri::command(async)]
pub fn save_tab_text(dir: State<'_, SessionDir>, id: String, text: String) -> AppResult<()> {
    dir.save_text(&id, &text)
}

#[tauri::command(async)]
pub fn delete_tab_text(dir: State<'_, SessionDir>, id: String) -> AppResult<()> {
    dir.delete_text(&id)
}

/// Reads a text file the user chose (native dialog, or dropped onto the window).
#[tauri::command(async)]
pub fn read_text_file(path: String) -> AppResult<TextFile> {
    textfile::read(Path::new(&path))
}

/// Writes a text to the path the user chose in the native dialog, in the given encoding.
#[tauri::command(async)]
pub fn write_text_file(path: String, text: String, encoding: String) -> AppResult<()> {
    textfile::write(Path::new(&path), &text, &encoding)
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

/// `themes.json` in the app's config folder.
fn themes_path(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(themes::FILE_NAME))
        .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))
}

/// The user's own colour schemes (design 001). Never fails: a broken file gives none and a notice.
#[tauri::command(async)]
pub fn load_themes(app: AppHandle) -> AppResult<LoadedThemes> {
    Ok(themes::load(&themes_path(&app)?))
}

#[tauri::command(async)]
pub fn save_themes(app: AppHandle, file: ThemesFile) -> AppResult<()> {
    themes::save(&themes_path(&app)?, &file)
}

/// Reads a scheme file the user chose in the native dialog; the frontend checks its content.
#[tauri::command(async)]
pub fn import_theme(path: String) -> AppResult<serde_json::Value> {
    themes::import(Path::new(&path))
}

/// Writes one scheme to the path the user chose in the native dialog.
#[tauri::command(async)]
pub fn export_theme(path: String, theme: UserTheme) -> AppResult<()> {
    themes::export(Path::new(&path), &theme)
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
