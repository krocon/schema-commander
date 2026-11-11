//! Schema Commander – the Rust side: database access behind Tauri commands; the web view only ever
//! shows a window of the data.

pub mod commands;
pub mod copy;
pub mod db;
pub mod error;
pub mod export;
pub mod extract;
pub mod history;
pub mod menu;
pub mod results;
pub mod session;
pub mod ssh;
pub mod textfile;
pub mod themes;

/// The window starts hidden and is shown with the first colour scheme; at the latest then.
const SHOW_FALLBACK: std::time::Duration = std::time::Duration::from_secs(1);

pub fn run() {
    let builder = tauri::Builder::default();
    // Windows and Linux have no menu bar yet (prompt 018).
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::macos_menu);
    builder
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
            app.manage(session::SessionDir::new(app.path().app_data_dir()?));
            app.manage(results::ResultStore::new(&app.path().app_cache_dir()?));
            app.manage(commands::ClipState::default());
            app.manage(commands::Jobs::default());
            app.manage(history::History::new(app.path().app_data_dir()?));
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
            commands::ssh_config_hosts,
            commands::end_transaction,
            commands::tx_state,
            commands::close_session,
            commands::check_statements,
            commands::confirm_statements,
            commands::copy_result,
            commands::cancel_copy,
            commands::copy_text,
            commands::export_result,
            commands::export_query,
            commands::cancel_job,
            commands::export_preview,
            commands::reveal_export,
            commands::history_add,
            commands::history_list,
            commands::history_text,
            commands::history_delete,
            commands::meta_schemas,
            commands::meta_objects,
            commands::meta_table,
            commands::meta_search,
            commands::result_window,
            commands::free_results,
            commands::load_session,
            commands::save_session,
            commands::load_tab_text,
            commands::save_tab_text,
            commands::delete_tab_text,
            commands::read_text_file,
            commands::write_text_file,
            commands::set_window_chrome,
            commands::load_themes,
            commands::save_themes,
            commands::import_theme,
            commands::export_theme,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Schema Commander");
}
