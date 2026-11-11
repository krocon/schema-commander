//! Schema Commander – the Rust side: database access behind Tauri commands; the web view only ever
//! shows a window of the data.

pub mod app_menu;
pub mod commands;
pub mod copy;
pub mod data_import;
pub mod db;
pub mod error;
pub mod export;
pub mod extract;
pub mod format;
pub mod history;
pub mod image_info;
pub mod menu;
pub mod results;
pub mod saved;
pub mod search;
pub mod session;
pub mod ssh;
pub mod stats;
pub mod textfile;
pub mod themes;

/// The window starts hidden and is shown with the first colour scheme; at the latest then.
const SHOW_FALLBACK: std::time::Duration = std::time::Duration::from_secs(1);

pub fn run() {
    // The PostgreSQL driver reads libpq's environment variables (password, options, certificates). A
    // connection is what its profile says, nothing else (review 014 L1). Before any thread exists.
    db::import::capture_environment();
    for name in [
        "PGHOST",
        "PGHOSTADDR",
        "PGPORT",
        "PGUSER",
        "PGPASSWORD",
        "PGPASSFILE",
        "PGDATABASE",
        "PGOPTIONS",
        "PGAPPNAME",
        "PGSSLMODE",
        "PGSSLROOTCERT",
        "PGSSLCERT",
        "PGSSLKEY",
        "PGSERVICE",
        "PGSERVICEFILE",
    ] {
        // SAFETY: the first statement of the program; no other thread reads the environment yet.
        unsafe { std::env::remove_var(name) };
    }
    let builder = tauri::Builder::default();
    // Windows and Linux draw the menu bar in the window (design 018 E2).
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::macos_menu);
    builder
        .on_menu_event(|app, event| commands::forward_menu_event(app, event.id().as_ref()))
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
            app.manage(commands::MenuState::default());
            app.manage(commands::NameIndexes::default());
            app.manage(commands::Jobs::default());
            app.manage(saved::SavedDir::new(&app.path().app_data_dir()?));
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
            commands::parse_connection_url,
            commands::import_preview,
            commands::import_connections,
            commands::export_connections,
            commands::end_transaction,
            commands::tx_state,
            commands::close_session,
            commands::check_statements,
            commands::confirm_statements,
            commands::copy_result,
            commands::cancel_copy,
            commands::copy_text,
            commands::read_clipboard_text,
            commands::export_result,
            commands::export_query,
            commands::cancel_job,
            commands::format_sql,
            commands::saved_use_folder,
            commands::saved_list,
            commands::saved_stamp,
            commands::saved_read,
            commands::saved_save,
            commands::saved_rename,
            commands::saved_create_folder,
            commands::saved_delete,
            commands::saved_search,
            commands::export_preview,
            commands::reveal_export,
            commands::history_add,
            commands::history_list,
            commands::history_text,
            commands::history_delete,
            commands::meta_schemas,
            commands::meta_objects,
            commands::meta_table,
            commands::meta_relations,
            commands::edit_preview,
            commands::edit_apply,
            commands::load_preview,
            commands::load_table_ddl,
            commands::load_statements,
            commands::load_run,
            commands::meta_details,
            commands::names_refresh,
            commands::names_query,
            commands::meta_search,
            commands::result_window,
            commands::result_view,
            commands::result_stats,
            commands::result_search,
            commands::result_seek,
            commands::table_query,
            commands::cell_value,
            commands::save_cell_value,
            commands::copy_cell_value,
            commands::free_results,
            commands::load_session,
            commands::save_session,
            commands::load_tab_text,
            commands::save_tab_text,
            commands::delete_tab_text,
            commands::read_text_file,
            commands::write_text_file,
            commands::set_window_chrome,
            commands::set_app_menu,
            commands::set_menu_state,
            commands::subscribe_menu,
            commands::load_themes,
            commands::save_themes,
            commands::import_theme,
            commands::export_theme,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Schema Commander");
}
