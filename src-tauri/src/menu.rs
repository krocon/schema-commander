//! The native menu bar of macOS (prompt 004; prompt 018 builds the full menu from the actions).
//!
//! Tauri's default menu has „Close Window“ on `Cmd+W`, which would close the window before the app sees the
//! key: here `Cmd+W` closes a tab. So the menu is built by hand, with what macOS needs for its own shortcuts
//! to work in text fields (Edit menu) and nothing that takes a key of the app.

use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// The words of the menu in one language (prompt 017). The items themselves are the system's.
struct Words {
    edit: &'static str,
    window: &'static str,
    about: &'static str,
    services: &'static str,
    hide: &'static str,
    hide_others: &'static str,
    show_all: &'static str,
    quit: &'static str,
    undo: &'static str,
    redo: &'static str,
    cut: &'static str,
    copy: &'static str,
    paste: &'static str,
    select_all: &'static str,
    minimize: &'static str,
    zoom: &'static str,
    fullscreen: &'static str,
}

const EN: Words = Words {
    edit: "Edit",
    window: "Window",
    about: "About",
    services: "Services",
    hide: "Hide",
    hide_others: "Hide Others",
    show_all: "Show All",
    quit: "Quit",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    select_all: "Select All",
    minimize: "Minimize",
    zoom: "Zoom",
    fullscreen: "Enter Full Screen",
};

const DE: Words = Words {
    edit: "Bearbeiten",
    window: "Fenster",
    about: "Über",
    services: "Dienste",
    hide: "Ausblenden",
    hide_others: "Andere ausblenden",
    show_all: "Alle einblenden",
    quit: "Beenden",
    undo: "Widerrufen",
    redo: "Wiederholen",
    cut: "Ausschneiden",
    copy: "Kopieren",
    paste: "Einsetzen",
    select_all: "Alles auswählen",
    minimize: "Im Dock ablegen",
    zoom: "Zoomen",
    fullscreen: "Vollbild",
};

/// The languages the window knows; anything else is English.
pub fn known_language(language: &str) -> &'static str {
    if language == "de" { "de" } else { "en" }
}

fn words(language: &str) -> &'static Words {
    if known_language(language) == "de" {
        &DE
    } else {
        &EN
    }
}

pub fn macos_menu<R: Runtime>(app: &AppHandle<R>, language: &str) -> tauri::Result<Menu<R>> {
    let w = words(language);
    let name = app.package_info().name.clone();
    let named = |word: &str| format!("{word} {name}");
    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&named(w.about)), Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some(w.services))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&named(w.hide)))?,
            &PredefinedMenuItem::hide_others(app, Some(w.hide_others))?,
            &PredefinedMenuItem::show_all(app, Some(w.show_all))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(&named(w.quit)))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        w.edit,
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(w.undo))?,
            &PredefinedMenuItem::redo(app, Some(w.redo))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(w.cut))?,
            &PredefinedMenuItem::copy(app, Some(w.copy))?,
            &PredefinedMenuItem::paste(app, Some(w.paste))?,
            &PredefinedMenuItem::select_all(app, Some(w.select_all))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        w.window,
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(w.minimize))?,
            &PredefinedMenuItem::maximize(app, Some(w.zoom))?,
            &PredefinedMenuItem::fullscreen(app, Some(w.fullscreen))?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_two_languages_and_falls_back_to_english() {
        assert_eq!(known_language("de"), "de");
        assert_eq!(known_language("en"), "en");
        assert_eq!(known_language("fr"), "en");
        assert_eq!(known_language(""), "en");
        assert_eq!(words("de").edit, "Bearbeiten");
        assert_eq!(words("xx").edit, "Edit");
    }
}
