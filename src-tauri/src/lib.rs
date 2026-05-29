mod commands;
mod credentials;
mod error;
mod hackerone;
mod local_db;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use commands::AppContext;
use credentials::KeyringStore;
use hackerone::ReqwestClient;
use local_db::SqliteStore;
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
            let data_dir = app.path().app_data_dir().expect("app data dir");
            std::fs::create_dir_all(&data_dir).expect("create app data dir");

            let creds = Arc::new(KeyringStore::new());
            let api = Arc::new(
                ReqwestClient::new(creds.clone()).expect("failed to build HackerOne HTTP client"),
            );
            let reports = Arc::new(
                SqliteStore::open(&data_dir.join("macaroni.db")).expect("open local db"),
            );

            let triages = Arc::new(Mutex::new(HashMap::new()));

            app.manage(AppContext { creds, api, reports, triages });
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
