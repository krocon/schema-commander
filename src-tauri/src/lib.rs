//! Schema Commander – the Rust side: database access behind Tauri commands; the web view only ever
//! shows a window of the data.

pub mod commands;
pub mod demo_db;
pub mod error;

/// The window starts hidden and is shown with the first colour scheme; at the latest then.
const SHOW_FALLBACK: std::time::Duration = std::time::Duration::from_secs(1);

pub fn run() {
    tauri::Builder::default()
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
        .manage(commands::DemoState::default())
        .setup(|app| {
            // A frontend that never applies a scheme must not leave the window hidden.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(SHOW_FALLBACK);
                commands::show_main(&handle);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::run_demo_query,
            commands::set_window_chrome,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Schema Commander");
}
