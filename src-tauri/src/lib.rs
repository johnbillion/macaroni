mod commands;
mod credentials;
mod error;
mod hackerone;
mod local_db;
mod settings;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use commands::AppContext;
use credentials::KeyringStore;
use hackerone::ReqwestClient;
use local_db::SqliteStore;
use settings::FileSettingsStore;
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // builder is reassigned only inside the debug-only block below, so the `mut`
    // looks unnecessary in release builds.
    #[cfg_attr(not(debug_assertions), allow(unused_mut))]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::new().build());

    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(
            tauri_plugin_log::Builder::new()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .level(log::LevelFilter::Error)
                .build(),
        );
    }

    builder
        .setup(|app| {
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128@2x.png"))?;

            let about = AboutMetadataBuilder::new()
                .name(Some("Macaroni"))
                .version(Some(env!("CARGO_PKG_VERSION")))
                .copyright(Some("© 2026 John Blackbourn"))
                .icon(Some(icon))
                .credits(Some(
                    "A desktop inbox for HackerOne bug bounty programs",
                ))
                .build();

            let app_menu = SubmenuBuilder::new(app, "Macaroni")
                .about(Some(about))
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            // Rebuild the standard Edit and Window submenus so the usual
            // editing shortcuts keep working alongside the custom app menu.
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .separator()
                .close_window()
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&app_menu)
                .item(&edit_menu)
                .item(&window_menu)
                .build()?;

            app.set_menu(menu)?;

            let data_dir = app.path().app_data_dir().expect("app data dir");
            std::fs::create_dir_all(&data_dir).expect("create app data dir");

            let creds = Arc::new(KeyringStore::new());
            let api = Arc::new(
                ReqwestClient::new(creds.clone()).expect("failed to build HackerOne HTTP client"),
            );
            let reports = Arc::new(
                SqliteStore::open(&data_dir.join("macaroni.db")).expect("open local db"),
            );
            let settings = Arc::new(FileSettingsStore::new(data_dir.join("settings.json")));

            let triages = Arc::new(Mutex::new(HashMap::new()));

            app.manage(AppContext { creds, api, reports, settings, triages });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::credentials_status,
            commands::credentials_save,
            commands::credentials_clear,
            commands::list_organizations,
            commands::list_programs,
            commands::list_assets,
            commands::list_program_members,
            commands::list_reports,
            commands::get_report,
            commands::update_report_asset,
            commands::save_attachment,
            commands::save_text_file,
            commands::save_zip_file,
            commands::get_settings,
            commands::set_triage_working_dir,
            commands::pick_directory,
            commands::mark_report_read,
            commands::mark_reports_read,
            commands::get_read_ids,
            commands::get_triage,
            commands::get_triage_prompt,
            commands::list_triage_validity,
            commands::run_triage,
            commands::stop_triage,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
