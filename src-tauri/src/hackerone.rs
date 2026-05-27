use crate::credentials::{CredentialStore, Credentials};
use crate::error::{AppError, AppResult};
use async_trait::async_trait;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

pub const BASE_URL: &str = "https://api.hackerone.com/v1";

#[derive(Debug, Clone, Serialize)]
pub struct Organization {
    pub id: String,
    pub handle: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Program {
    pub id: String,
    pub handle: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReportSummary {
    pub id: String,
    pub title: String,
    pub state: String,
    pub severity_rating: Option<String>,
    pub created_at: String,
    pub asset: Option<AssetRef>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReportPage {
    pub items: Vec<ReportSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UserRef {
    pub id: String,
    pub username: String,
    pub name: Option<String>,
    pub profile_picture_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WeaknessRef {
    pub id: String,
    pub name: String,
    pub external_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AssetRef {
    pub id: String,
    pub asset_identifier: String,
    pub asset_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Asset {
    pub id: String,
    pub identifier: String,
    pub asset_type: Option<String>,
    pub in_scope: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Activity {
    Comment {
        id: String,
        created_at: String,
        message: String,
        internal: bool,
        actor: Option<UserRef>,
    },
    Event {
        id: String,
        created_at: String,
        kind: String,
        message: Option<String>,
        internal: bool,
        actor: Option<UserRef>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ReportDetail {
    pub id: String,
    pub title: String,
    pub state: String,
    pub main_state: String,
    pub severity_rating: Option<String>,
    pub created_at: String,
    pub submitted_at: Option<String>,
    pub vulnerability_information: String,
    pub reporter: Option<UserRef>,
    pub weakness: Option<WeaknessRef>,
    pub asset: Option<AssetRef>,
    pub activities: Vec<Activity>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ReportQuery {
    pub program_handle: String,
    #[serde(default)]
    pub states: Vec<String>,
    #[serde(default)]
    pub severities: Vec<String>,
    #[serde(default)]
    pub asset_ids: Vec<String>,
    #[serde(default)]
    pub page_cursor: Option<String>,
}

#[async_trait]
pub trait HackerOneApi: Send + Sync {
    async fn validate(&self) -> AppResult<()>;
    async fn list_organizations(&self) -> AppResult<Vec<Organization>>;
    async fn list_programs(&self, org_id: &str) -> AppResult<Vec<Program>>;
    async fn list_assets(&self, org_id: &str) -> AppResult<Vec<Asset>>;
    async fn list_reports(&self, query: ReportQuery) -> AppResult<ReportPage>;
    async fn get_report(&self, report_id: &str) -> AppResult<ReportDetail>;
}

pub struct ReqwestClient {
    http: reqwest::Client,
    creds: Arc<dyn CredentialStore>,
}

impl ReqwestClient {
    pub fn new(creds: Arc<dyn CredentialStore>) -> AppResult<Self> {
        let http = reqwest::Client::builder()
            .user_agent("macaroni/0.1")
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(AppError::from)?;
        Ok(Self { http, creds })
    }

    fn auth_header(creds: &Credentials) -> String {
        let raw = format!("{}:{}", creds.username, creds.token);
        let encoded = base64::engine::general_purpose::STANDARD.encode(raw);
        format!("Basic {encoded}")
    }

    async fn get_json(&self, url: &str) -> AppResult<serde_json::Value> {
        let creds = self
            .creds
            .load()?
            .ok_or(AppError::Unauthorized { message: "No credentials saved".into() })?;

        let res = self
            .http
            .get(url)
            .header("Authorization", Self::auth_header(&creds))
            .header("Accept", "application/json")
            .send()
            .await?;

        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(AppError::from_status(status.as_u16(), &body));
        }
        Ok(res.json::<serde_json::Value>().await?)
    }
}

#[async_trait]
impl HackerOneApi for ReqwestClient {
    async fn validate(&self) -> AppResult<()> {
        self.get_json(&format!("{BASE_URL}/me/organizations")).await?;
        Ok(())
    }

    async fn list_organizations(&self) -> AppResult<Vec<Organization>> {
        let body = self.get_json(&format!("{BASE_URL}/me/organizations?page%5Bsize%5D=100")).await?;
        let data = body.get("data").and_then(|v| v.as_array()).ok_or_else(|| {
            AppError::Other { message: "Unexpected response shape from /me/organizations".into() }
        })?;
        Ok(data
            .iter()
            .filter_map(|item| {
                Some(Organization {
                    id: item.get("id")?.as_str()?.to_string(),
                    handle: item.get("attributes")?.get("handle")?.as_str()?.to_string(),
                })
            })
            .collect())
    }

    async fn list_programs(&self, org_id: &str) -> AppResult<Vec<Program>> {
        let url =
            format!("{BASE_URL}/organizations/{org_id}/programs?page%5Bsize%5D=100");
        let body = self.get_json(&url).await?;
        let data = body.get("data").and_then(|v| v.as_array()).ok_or_else(|| {
            AppError::Other { message: "Unexpected response shape from /programs".into() }
        })?;
        Ok(data
            .iter()
            .filter_map(|item| {
                Some(Program {
                    id: item.get("id")?.as_str()?.to_string(),
                    handle: item.get("attributes")?.get("handle")?.as_str()?.to_string(),
                })
            })
            .collect())
    }

    async fn list_assets(&self, org_id: &str) -> AppResult<Vec<Asset>> {
        let url =
            format!("{BASE_URL}/organizations/{org_id}/assets?page%5Bsize%5D=100");
        let body = self.get_json(&url).await?;
        let data = body.get("data").and_then(|v| v.as_array()).ok_or_else(|| {
            AppError::Other { message: "Unexpected response shape from /assets".into() }
        })?;
        Ok(data
            .iter()
            .filter_map(|item| {
                let attrs = item.get("attributes")?;
                Some(Asset {
                    id: item.get("id")?.as_str()?.to_string(),
                    identifier: attrs.get("identifier")?.as_str()?.to_string(),
                    asset_type: attrs.get("asset_type").and_then(|v| v.as_str()).map(String::from),
                    in_scope: attrs
                        .get("coverage")
                        .and_then(|v| v.as_str())
                        .map(|s| s == "in_scope")
                        .unwrap_or(false),
                })
            })
            .collect())
    }

    async fn list_reports(&self, query: ReportQuery) -> AppResult<ReportPage> {
        let url = match query.page_cursor.as_deref() {
            Some(cursor) => cursor.to_string(),
            None => {
                let mut params = vec![
                    ("filter[program][]".to_string(), query.program_handle.clone()),
                    ("sort".to_string(), "-reports.created_at".to_string()),
                    ("page[size]".to_string(), "100".to_string()),
                ];
                for state in &query.states {
                    params.push(("filter[state][]".to_string(), state.clone()));
                }
                for severity in &query.severities {
                    params.push(("filter[severity][]".to_string(), severity.clone()));
                }
                for asset_id in &query.asset_ids {
                    params.push(("filter[asset_ids][]".to_string(), asset_id.clone()));
                }
                let qs = serde_urlencoded::to_string(&params).map_err(AppError::other)?;
                format!("{BASE_URL}/reports?{qs}")
            }
        };

        #[cfg(debug_assertions)]
        println!("[reports] GET {url}");

        let body = self.get_json(&url).await?;
        let data = body.get("data").and_then(|v| v.as_array()).ok_or_else(|| {
            AppError::Other { message: "Unexpected response shape from /reports".into() }
        })?;

        let items = data
            .iter()
            .filter_map(|item| {
                let attrs = item.get("attributes")?;
                let rel = item.get("relationships");
                Some(ReportSummary {
                    id: item.get("id")?.as_str()?.to_string(),
                    title: attrs.get("title")?.as_str()?.to_string(),
                    state: attrs.get("state").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    severity_rating: parse_severity_rating(rel),
                    created_at: attrs
                        .get("created_at")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    asset: rel
                        .and_then(|r| r.get("structured_scope"))
                        .and_then(parse_asset_ref),
                })
            })
            .collect();

        let next_cursor = body
            .get("links")
            .and_then(|l| l.get("next"))
            .and_then(|n| n.as_str())
            .map(String::from);

        Ok(ReportPage { items, next_cursor })
    }

    async fn get_report(&self, report_id: &str) -> AppResult<ReportDetail> {
        let body = self.get_json(&format!("{BASE_URL}/reports/{report_id}")).await?;
        parse_report_detail(&body).ok_or_else(|| AppError::Other {
            message: format!("Could not parse report {report_id}"),
        })
    }
}

fn parse_user_ref(rel: &serde_json::Value) -> Option<UserRef> {
    let data = rel.get("data")?;
    let attrs = data.get("attributes")?;
    let profile_picture_url = attrs
        .get("profile_picture")
        .and_then(|p| p.get("62x62"))
        .and_then(|v| v.as_str())
        .map(String::from);
    Some(UserRef {
        id: data.get("id")?.as_str()?.to_string(),
        username: attrs.get("username")?.as_str()?.to_string(),
        name: attrs.get("name").and_then(|v| v.as_str()).and_then(|s| {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }),
        profile_picture_url,
    })
}

fn parse_weakness_ref(rel: &serde_json::Value) -> Option<WeaknessRef> {
    let data = rel.get("data")?;
    let attrs = data.get("attributes")?;
    Some(WeaknessRef {
        id: data.get("id")?.as_str()?.to_string(),
        name: attrs.get("name")?.as_str()?.to_string(),
        external_id: attrs
            .get("external_id")
            .and_then(|v| v.as_str())
            .map(String::from),
    })
}

fn parse_severity_rating(relationships: Option<&serde_json::Value>) -> Option<String> {
    relationships?
        .get("severity")?
        .get("data")?
        .get("attributes")?
        .get("rating")?
        .as_str()
        .map(String::from)
}

fn parse_asset_ref(rel: &serde_json::Value) -> Option<AssetRef> {
    let data = rel.get("data")?;
    let attrs = data.get("attributes")?;
    Some(AssetRef {
        id: data.get("id")?.as_str()?.to_string(),
        asset_identifier: attrs.get("asset_identifier")?.as_str()?.to_string(),
        asset_type: attrs.get("asset_type").and_then(|v| v.as_str()).map(String::from),
    })
}

fn parse_activity(item: &serde_json::Value) -> Option<Activity> {
    let id = item.get("id")?.as_str()?.to_string();
    let kind = item.get("type")?.as_str()?.to_string();
    let attrs = item.get("attributes")?;
    let created_at = attrs.get("created_at")?.as_str()?.to_string();
    let internal = attrs.get("internal").and_then(|v| v.as_bool()).unwrap_or(false);
    let message = attrs.get("message").and_then(|v| v.as_str()).map(String::from);
    let actor = item.get("relationships").and_then(|r| r.get("actor")).and_then(parse_user_ref);

    if kind == "activity-comment" {
        Some(Activity::Comment {
            id,
            created_at,
            message: message.unwrap_or_default(),
            internal,
            actor,
        })
    } else {
        let kind_short = kind.strip_prefix("activity-").unwrap_or(&kind).to_string();
        Some(Activity::Event {
            id,
            created_at,
            kind: kind_short,
            message,
            internal,
            actor,
        })
    }
}

fn parse_report_detail(body: &serde_json::Value) -> Option<ReportDetail> {
    let data = body.get("data")?;
    let attrs = data.get("attributes")?;
    let rel = data.get("relationships");

    let activities = rel
        .and_then(|r| r.get("activities"))
        .and_then(|a| a.get("data"))
        .and_then(|d| d.as_array())
        .map(|arr| arr.iter().filter_map(parse_activity).collect())
        .unwrap_or_default();

    Some(ReportDetail {
        id: data.get("id")?.as_str()?.to_string(),
        title: attrs.get("title")?.as_str()?.to_string(),
        state: attrs.get("state").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        main_state: attrs
            .get("main_state")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        severity_rating: parse_severity_rating(rel),
        created_at: attrs
            .get("created_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        submitted_at: attrs.get("submitted_at").and_then(|v| v.as_str()).map(String::from),
        vulnerability_information: attrs
            .get("vulnerability_information")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        reporter: rel.and_then(|r| r.get("reporter")).and_then(parse_user_ref),
        weakness: rel.and_then(|r| r.get("weakness")).and_then(parse_weakness_ref),
        asset: rel.and_then(|r| r.get("structured_scope")).and_then(parse_asset_ref),
        activities,
    })
}
