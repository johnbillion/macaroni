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
    pub last_activity_at: Option<String>,
    pub issue_tracker_reference_id: Option<String>,
    pub issue_tracker_reference_url: Option<String>,
    pub asset: Option<AssetRef>,
    pub reporter: UserRef,
    pub assignee: Option<AssigneeRef>,
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
pub struct AssigneeRef {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
    pub username: Option<String>,
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
pub struct TeamMember {
    pub id: String,
    pub username: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Attachment {
    pub id: String,
    pub file_name: String,
    pub content_type: Option<String>,
    pub file_size: Option<u64>,
    pub expiring_url: String,
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
        attachments: Vec<Attachment>,
    },
    Event {
        id: String,
        created_at: String,
        kind: String,
        message: Option<String>,
        internal: bool,
        actor: Option<UserRef>,
        /// `email` attr on `activity-external-user-invited` — actually a username string.
        invitee: Option<String>,
        /// `duplicate_report_id` attr on `activity-external-user-joined` when the user
        /// joined as a result of filing a duplicate report.
        duplicate_report_id: Option<String>,
        /// `old_scope` / `new_scope` asset identifiers on `activity-changed-scope`.
        old_scope: Option<String>,
        new_scope: Option<String>,
        /// `new_weakness` name on `activity-report-vulnerability-types-updated`.
        new_weakness: Option<String>,
        /// `group` name on `activity-group-assigned-to-bug` (sometimes null).
        group_name: Option<String>,
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
    pub issue_tracker_reference_id: Option<String>,
    pub issue_tracker_reference_url: Option<String>,
    pub reporter: UserRef,
    pub weakness: Option<WeaknessRef>,
    pub asset: Option<AssetRef>,
    pub activities: Vec<Activity>,
    pub attachments: Vec<Attachment>,
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
    pub keyword: Option<String>,
    #[serde(default)]
    pub page_cursor: Option<String>,
}

#[async_trait]
pub trait HackerOneApi: Send + Sync {
    async fn validate(&self) -> AppResult<()>;
    async fn list_organizations(&self) -> AppResult<Vec<Organization>>;
    async fn list_programs(&self, org_id: &str) -> AppResult<Vec<Program>>;
    async fn list_assets(&self, org_id: &str) -> AppResult<Vec<Asset>>;
    async fn list_program_members(&self, program_id: &str) -> AppResult<Vec<TeamMember>>;
    async fn list_reports(&self, query: ReportQuery) -> AppResult<ReportPage>;
    async fn get_report(&self, report_id: &str) -> AppResult<ReportDetail>;
    async fn update_report_asset(&self, report_id: &str, asset_id: &str) -> AppResult<()>;
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

    async fn list_program_members(&self, program_id: &str) -> AppResult<Vec<TeamMember>> {
        let mut url = format!("{BASE_URL}/programs/{program_id}/members?page%5Bsize%5D=100");
        let mut members: Vec<TeamMember> = Vec::new();
        loop {
            let body = self.get_json(&url).await?;
            let data = body.get("data").and_then(|v| v.as_array()).ok_or_else(|| {
                AppError::Other {
                    message: "Unexpected response shape from /programs/.../members".into(),
                }
            })?;
            for item in data {
                let Some(attrs) = item.get("attributes") else { continue };
                let Some(user_id) = attrs.get("user_id").and_then(|v| {
                    v.as_str().map(String::from).or_else(|| v.as_u64().map(|n| n.to_string()))
                }) else {
                    continue;
                };
                let Some(username) = attrs.get("username").and_then(|v| v.as_str()) else {
                    continue;
                };
                members.push(TeamMember { id: user_id, username: username.to_string() });
            }
            match body.get("links").and_then(|l| l.get("next")).and_then(|n| n.as_str()) {
                Some(next) => url = next.to_string(),
                None => break,
            }
        }
        Ok(members)
    }

    async fn list_reports(&self, query: ReportQuery) -> AppResult<ReportPage> {
        let url = match query.page_cursor.as_deref() {
            Some(cursor) => cursor.to_string(),
            None => {
                let mut params = vec![
                    ("filter[program][]".to_string(), query.program_handle.clone()),
                    ("sort".to_string(), "-reports.created_at".to_string()),
                    ("page[size]".to_string(), "50".to_string()),
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
                if let Some(keyword) = query.keyword.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    params.push(("filter[keyword]".to_string(), keyword.to_string()));
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
                    last_activity_at: attrs
                        .get("last_activity_at")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    issue_tracker_reference_id: attrs
                        .get("issue_tracker_reference_id")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    issue_tracker_reference_url: attrs
                        .get("issue_tracker_reference_url")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    asset: rel
                        .and_then(|r| r.get("structured_scope"))
                        .and_then(parse_asset_ref),
                    reporter: rel.and_then(|r| r.get("reporter")).and_then(parse_user_ref)?,
                    assignee: rel.and_then(|r| r.get("assignee")).and_then(parse_assignee_ref),
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

    // TEMPORARY DUMMY — does not hit the HackerOne API.
    // Simulates ~150-500ms latency and a 30% failure rate, picking from the
    // non-cascading error kinds (network/rate_limited/not_found/other) so the
    // full bulk-edit UI flow (progress, partial failure, retry-failed) can be
    // exercised without unauthorized/forbidden which would abort the batch.
    // Replace with a real PUT /reports/{id}/structured_scope when the UI is solid.
    async fn update_report_asset(&self, report_id: &str, asset_id: &str) -> AppResult<()> {
        let r = pseudo_rand_u64();
        let delay_ms = 150 + ((r >> 8) % 350);
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;

        #[cfg(debug_assertions)]
        println!("[dummy] update_report_asset report={report_id} asset={asset_id}");

        let roll = r & 0xff;
        if roll % 100 < 30 {
            return Err(match roll % 4 {
                0 => AppError::RateLimited {
                    message: "Simulated rate limit (dummy)".into(),
                },
                1 => AppError::Network {
                    message: "Simulated network failure (dummy)".into(),
                },
                2 => AppError::NotFound {
                    message: format!("Simulated missing report {report_id} (dummy)"),
                },
                _ => AppError::Other {
                    message: "Simulated server error (dummy)".into(),
                },
            });
        }
        Ok(())
    }
}

fn pseudo_rand_u64() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0)
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

fn parse_assignee_ref(rel: &serde_json::Value) -> Option<AssigneeRef> {
    let data = rel.get("data")?;
    let kind = data.get("type")?.as_str()?.to_string();
    let id = data.get("id")?.as_str()?.to_string();
    let attrs = data.get("attributes")?;
    let username = attrs.get("username").and_then(|v| v.as_str()).map(String::from);
    let name = attrs.get("name").and_then(|v| v.as_str()).and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    let profile_picture_url = attrs
        .get("profile_picture")
        .and_then(|p| p.get("62x62"))
        .and_then(|v| v.as_str())
        .map(String::from);
    Some(AssigneeRef { kind, id, username, name, profile_picture_url })
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

fn parse_attachment(item: &serde_json::Value) -> Option<Attachment> {
    let id = item.get("id")?.as_str()?.to_string();
    let attrs = item.get("attributes")?;
    Some(Attachment {
        id,
        file_name: attrs
            .get("file_name")
            .and_then(|v| v.as_str())
            .unwrap_or("attachment")
            .to_string(),
        content_type: attrs.get("content_type").and_then(|v| v.as_str()).map(String::from),
        file_size: attrs.get("file_size").and_then(|v| v.as_u64()),
        expiring_url: attrs.get("expiring_url").and_then(|v| v.as_str())?.to_string(),
    })
}

fn parse_attachments(rel: Option<&serde_json::Value>) -> Vec<Attachment> {
    rel.and_then(|r| r.get("attachments"))
        .and_then(|a| a.get("data"))
        .and_then(|d| d.as_array())
        .map(|arr| arr.iter().filter_map(parse_attachment).collect())
        .unwrap_or_default()
}

fn parse_activity(item: &serde_json::Value) -> Option<Activity> {
    let id = item.get("id")?.as_str()?.to_string();
    let kind = item.get("type")?.as_str()?.to_string();
    let attrs = item.get("attributes")?;
    let created_at = attrs.get("created_at")?.as_str()?.to_string();
    let internal = attrs.get("internal").and_then(|v| v.as_bool()).unwrap_or(false);
    let message = attrs.get("message").and_then(|v| v.as_str()).map(String::from);
    let relationships = item.get("relationships");
    let actor = relationships.and_then(|r| r.get("actor")).and_then(parse_user_ref);

    if kind == "activity-comment" {
        Some(Activity::Comment {
            id,
            created_at,
            message: message.unwrap_or_default(),
            internal,
            actor,
            attachments: parse_attachments(relationships),
        })
    } else {
        let kind_short = kind.strip_prefix("activity-").unwrap_or(&kind).to_string();
        let invitee = if kind_short == "external-user-invited" {
            attrs.get("email").and_then(|v| v.as_str()).map(String::from)
        } else {
            None
        };
        let duplicate_report_id = if kind_short == "external-user-joined" {
            attrs
                .get("duplicate_report_id")
                .and_then(|v| v.as_u64().map(|n| n.to_string()).or_else(|| v.as_str().map(String::from)))
        } else {
            None
        };
        let scope_identifier = |key: &str| -> Option<String> {
            relationships?
                .get(key)?
                .get("data")?
                .get("attributes")?
                .get("asset_identifier")?
                .as_str()
                .map(String::from)
        };
        let (old_scope, new_scope) = if kind_short == "changed-scope" {
            (scope_identifier("old_scope"), scope_identifier("new_scope"))
        } else {
            (None, None)
        };
        let new_weakness = if kind_short == "report-vulnerability-types-updated" {
            relationships
                .and_then(|r| r.get("new_weakness"))
                .and_then(|w| w.get("data"))
                .and_then(|d| d.get("attributes"))
                .and_then(|a| a.get("name"))
                .and_then(|v| v.as_str())
                .map(String::from)
        } else {
            None
        };
        let group_name = if kind_short == "group-assigned-to-bug" {
            relationships
                .and_then(|r| r.get("group"))
                .and_then(|g| g.get("data"))
                .and_then(|d| d.get("attributes"))
                .and_then(|a| a.get("name"))
                .and_then(|v| v.as_str())
                .map(String::from)
        } else {
            None
        };
        Some(Activity::Event {
            id,
            created_at,
            kind: kind_short,
            message,
            internal,
            actor,
            invitee,
            duplicate_report_id,
            old_scope,
            new_scope,
            new_weakness,
            group_name,
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
        issue_tracker_reference_id: attrs
            .get("issue_tracker_reference_id")
            .and_then(|v| v.as_str())
            .map(String::from),
        issue_tracker_reference_url: attrs
            .get("issue_tracker_reference_url")
            .and_then(|v| v.as_str())
            .map(String::from),
        reporter: rel.and_then(|r| r.get("reporter")).and_then(parse_user_ref)?,
        weakness: rel.and_then(|r| r.get("weakness")).and_then(parse_weakness_ref),
        asset: rel.and_then(|r| r.get("structured_scope")).and_then(parse_asset_ref),
        activities,
        attachments: parse_attachments(rel),
    })
}
