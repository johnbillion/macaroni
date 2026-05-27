use crate::credentials::{CredentialStore, Credentials};
use crate::error::{AppError, AppResult};
use crate::hackerone::{
    Asset, HackerOneApi, Organization, Program, ReportDetail, ReportPage, ReportQuery, TeamMember,
};
use crate::local_db::ReportStore;
use std::sync::Arc;
use tauri::State;

pub struct AppContext {
    pub creds: Arc<dyn CredentialStore>,
    pub api: Arc<dyn HackerOneApi>,
    pub reports: Arc<dyn ReportStore>,
}

#[derive(serde::Serialize)]
pub struct CredentialsStatus {
    pub has_credentials: bool,
    pub username: Option<String>,
}

#[tauri::command]
pub async fn credentials_status(ctx: State<'_, AppContext>) -> AppResult<CredentialsStatus> {
    let loaded = ctx.creds.load()?;
    Ok(CredentialsStatus {
        has_credentials: loaded.is_some(),
        username: loaded.map(|c| c.username),
    })
}

#[tauri::command]
pub async fn credentials_save(
    ctx: State<'_, AppContext>,
    username: String,
    token: String,
) -> AppResult<()> {
    let creds = Credentials { username, token };
    ctx.creds.save(&creds)?;
    if let Err(e) = ctx.api.validate().await {
        let _ = ctx.creds.clear();
        return Err(match e {
            AppError::Unauthorized { .. } => AppError::Unauthorized {
                message: "Invalid username or token".into(),
            },
            other => other,
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn credentials_clear(ctx: State<'_, AppContext>) -> AppResult<()> {
    ctx.creds.clear()
}

#[tauri::command]
pub async fn list_organizations(ctx: State<'_, AppContext>) -> AppResult<Vec<Organization>> {
    ctx.api.list_organizations().await
}

#[tauri::command]
pub async fn list_programs(
    ctx: State<'_, AppContext>,
    org_id: String,
) -> AppResult<Vec<Program>> {
    ctx.api.list_programs(&org_id).await
}

#[tauri::command]
pub async fn list_assets(
    ctx: State<'_, AppContext>,
    org_id: String,
) -> AppResult<Vec<Asset>> {
    ctx.api.list_assets(&org_id).await
}

#[tauri::command]
pub async fn list_program_members(
    ctx: State<'_, AppContext>,
    program_id: String,
) -> AppResult<Vec<TeamMember>> {
    ctx.api.list_program_members(&program_id).await
}

#[tauri::command]
pub async fn list_reports(
    ctx: State<'_, AppContext>,
    query: ReportQuery,
) -> AppResult<ReportPage> {
    let page = ctx.api.list_reports(query).await?;
    let ids: Vec<&str> = page.items.iter().map(|r| r.id.as_str()).collect();
    ctx.reports.upsert(&ids)?;
    Ok(page)
}

#[tauri::command]
pub async fn mark_report_read(ctx: State<'_, AppContext>, report_id: String) -> AppResult<()> {
    ctx.reports.mark_read(&report_id)
}

#[tauri::command]
pub async fn mark_reports_read(
    ctx: State<'_, AppContext>,
    report_ids: Vec<String>,
) -> AppResult<()> {
    let refs: Vec<&str> = report_ids.iter().map(String::as_str).collect();
    ctx.reports.mark_read_many(&refs)
}

#[tauri::command]
pub async fn get_read_ids(
    ctx: State<'_, AppContext>,
    report_ids: Vec<String>,
) -> AppResult<Vec<String>> {
    let refs: Vec<&str> = report_ids.iter().map(String::as_str).collect();
    ctx.reports.list_read(&refs)
}

#[tauri::command]
pub async fn get_report(
    ctx: State<'_, AppContext>,
    report_id: String,
) -> AppResult<ReportDetail> {
    ctx.api.get_report(&report_id).await
}

// Show a native save-file dialog for an attachment and, if the user confirms a path,
// fetch the bytes from the (presigned) URL on the Rust side and write them to disk.
// Returns true if a file was written, false if the user cancelled.
#[tauri::command]
pub async fn save_attachment(
    app: tauri::AppHandle,
    url: String,
    suggested_filename: String,
) -> AppResult<bool> {
    use tauri_plugin_dialog::DialogExt;

    #[cfg(debug_assertions)]
    println!("[attachments] save dialog for {suggested_filename}");

    let path = app
        .dialog()
        .file()
        .set_file_name(&suggested_filename)
        .blocking_save_file();
    let Some(path) = path else {
        return Ok(false);
    };
    let path = path.into_path().map_err(AppError::other)?;

    #[cfg(debug_assertions)]
    println!("[attachments] GET {url}");
    let res = reqwest::get(&url).await?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(AppError::from_status(status.as_u16(), &body));
    }
    let bytes = res.bytes().await?;
    std::fs::write(&path, &bytes).map_err(AppError::other)?;
    Ok(true)
}
