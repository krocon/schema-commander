//! Schema Commander – the Rust side: database access behind Tauri commands; the web view only ever
//! shows a window of the data.

pub mod commands;
pub mod db;
pub mod error;
pub mod themes;

/// The window starts hidden and is shown with the first colour scheme; at the latest then.
const SHOW_FALLBACK: std::time::Duration = std::time::Duration::from_secs(1);

pub fn run() {
    tauri::Builder::default()
        // Native file dialogs: the only way a path gets into a command (design 001 E4).
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        // The window starts hidden until its colour scheme is on: restoring "visible" would show it
        // before that.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .setup(|app| {
            use tauri::Manager;
            let file = app.path().app_config_dir()?.join(db::profiles::FILE_NAME);
            let store: std::sync::Arc<dyn db::secrets::SecretStore> =
                std::sync::Arc::new(db::secrets::SystemStore);
            app.manage(db::manager::ConnectionManager::new(file, store));
            // A frontend that never applies a scheme must not leave the window hidden.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(SHOW_FALLBACK);
                commands::show_main(&handle);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::test_connection,
            commands::open_connection,
            commands::close_connection,
            commands::run_query,
            commands::cancel_query,
            commands::set_window_chrome,
            commands::load_themes,
            commands::save_themes,
            commands::import_theme,
            commands::export_theme,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Schema Commander");
}
