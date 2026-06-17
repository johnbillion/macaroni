use crate::credentials::{CredentialStore, Credentials};
use crate::error::{AppError, AppResult};
use async_trait::async_trait;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use zeroize::Zeroize as _;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

pub const BASE_URL: &str = "https://api.hackerone.com/v1";

/// The only host we will ever attach the user's credentials to. `get_json` follows
/// `links.next` cursor URLs returned by the API verbatim; this guards against a tampered
/// response redirecting the `Authorization` header to an attacker-controlled host.
const API_HOST: &str = "api.hackerone.com";

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
    // The full report description. The /reports list endpoint already returns this, so we carry
    // it on the summary to populate the detail pane immediately on selection (before get_report
    // returns). It's a large field, so it noticeably inflates list responses.
    pub vulnerability_information: String,
    pub state: String,
    pub severity_rating: Option<String>,
    pub created_at: String,
    pub last_activity_at: Option<String>,
    pub issue_tracker_reference_id: Option<String>,
    pub issue_tracker_reference_url: Option<String>,
    pub asset: Option<AssetRef>,
    pub weakness: Option<WeaknessRef>,
    pub reporter: UserRef,
    pub assignee: Option<AssigneeRef>,
    pub inboxes: Vec<InboxRef>,
    pub bounty: Option<BountyTotal>,
}

// Total awarded bounty for a report, summed across all bounty awards (a report can
// have several when an award is split between collaborators). The list endpoint only
// carries actually-awarded amounts; HackerOne's API has no "suggested bounty" field here.
#[derive(Debug, Clone, Serialize)]
pub struct BountyTotal {
    pub amount: f64,
    pub currency: Option<String>,
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
pub struct InboxRef {
    pub id: String,
    pub name: String,
    /// `default` for the program's built-in inbox, `custom` for a custom inbox.
    pub kind: Option<String>,
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

// `Event` carries far more fields than `Comment`, so the variants differ a lot in size. These are
// short-lived API DTOs held in small per-report `Vec`s, so the disparity isn't worth boxing fields
// (which would only uglify the polymorphic match in `parse_activity` and the frontend serde shape).
#[allow(clippy::large_enum_variant)]
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
        /// `original_report_id` attr on `activity-bug-duplicate` — the canonical report
        /// this one was closed as a duplicate of.
        original_report_id: Option<String>,
        /// `old_scope` / `new_scope` asset identifiers on `activity-changed-scope`.
        old_scope: Option<String>,
        new_scope: Option<String>,
        /// `new_weakness` name on `activity-report-vulnerability-types-updated`.
        new_weakness: Option<String>,
        /// `group` name on `activity-group-assigned-to-bug` (sometimes null).
        group_name: Option<String>,
        /// `old_severity` / `new_severity` ratings on `activity-report-severity-updated`.
        old_severity: Option<String>,
        new_severity: Option<String>,
        /// `old_title` / `new_title` on `activity-report-title-updated`.
        old_title: Option<String>,
        new_title: Option<String>,
        /// `bounty_amount` / `bonus_amount` on `activity-bounty-suggested` (the suggested
        /// award and report-quality bonus) and `activity-bounty-awarded` (the actual award).
        /// The activity carries no currency code.
        bounty_amount: Option<f64>,
        bonus_amount: Option<f64>,
        /// `assigned_user` on `activity-user-assigned-to-bug` — the user the report was
        /// assigned to (distinct from `actor`, who performed the assignment).
        assigned_user: Option<UserRef>,
        /// `reference` on `activity-reference-id-added` — the external issue-tracker
        /// reference id linked to the report (sometimes a bare id, sometimes a full URL).
        reference: Option<String>,
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
    pub vulnerability_information: String,
    pub issue_tracker_reference_id: Option<String>,
    pub issue_tracker_reference_url: Option<String>,
    pub reporter: UserRef,
    pub weakness: Option<WeaknessRef>,
    pub asset: Option<AssetRef>,
    pub inboxes: Vec<InboxRef>,
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
    /// Assignee filter tokens — usernames for user assignees, names for group assignees. The
    /// HackerOne API's `filter[assignee][]` matches on those, not on assignee id. Multiple
    /// values are OR'd together.
    #[serde(default)]
    pub assignees: Vec<String>,
    #[serde(default)]
    pub keyword: Option<String>,
    #[serde(default)]
    pub page_cursor: Option<String>,
    /// ISO8601 timestamp. When set (and no `page_cursor`), restricts the result to reports
    /// created strictly after this instant via `filter[created_at__gt]` — used by the inbox's
    /// background poll to fetch only reports newer than the latest one already on screen.
    #[serde(default)]
    pub since_created_at: Option<String>,
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
            .user_agent("Macaroni/0.1")
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(AppError::from)?;
        Ok(Self { http, creds })
    }

    fn auth_header(creds: &Credentials) -> String {
        let mut raw = format!("{}:{}", creds.username, creds.token);
        let mut encoded = base64::engine::general_purpose::STANDARD.encode(raw.as_bytes());
        raw.zeroize();
        let header = format!("Basic {encoded}");
        encoded.zeroize();
        header
    }

    /// Reject any URL that isn't HTTPS to the HackerOne API host before we attach credentials.
    fn ensure_api_url(url: &str) -> AppResult<()> {
        let parsed = reqwest::Url::parse(url)
            .map_err(|e| AppError::other(format!("invalid request URL: {e}")))?;
        if parsed.scheme() != "https" || parsed.host_str() != Some(API_HOST) {
            return Err(AppError::Other {
                message: "Refusing to send credentials to a non-HackerOne URL".into(),
            });
        }
        Ok(())
    }

    async fn get_json(&self, url: &str) -> AppResult<serde_json::Value> {
        Self::ensure_api_url(url)?;

        let creds = self.creds.load()?.ok_or(AppError::Unauthorized {
            message: "No credentials saved".into(),
        })?;

        // Built fresh per request and wiped immediately after the builder copies it into the
        // request's header map, so the base64'd secret isn't left sitting on the heap.
        let mut auth = Self::auth_header(&creds);
        let res = self
            .http
            .get(url)
            .header("Authorization", auth.as_str())
            .header("Accept", "application/json")
            .send()
            .await;
        auth.zeroize();
        let res = res?;

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
        self.get_json(&format!("{BASE_URL}/me/organizations"))
            .await?;
        Ok(())
    }

    async fn list_organizations(&self) -> AppResult<Vec<Organization>> {
        let body = self
            .get_json(&format!("{BASE_URL}/me/organizations?page%5Bsize%5D=100"))
            .await?;
        let data = body
            .get("data")
            .and_then(|v| v.as_array())
            .ok_or_else(|| AppError::Other {
                message: "Unexpected response shape from /me/organizations".into(),
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
        let url = format!("{BASE_URL}/organizations/{org_id}/programs?page%5Bsize%5D=100");
        let body = self.get_json(&url).await?;
        let data = body
            .get("data")
            .and_then(|v| v.as_array())
            .ok_or_else(|| AppError::Other {
                message: "Unexpected response shape from /programs".into(),
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
        let url = format!("{BASE_URL}/organizations/{org_id}/assets?page%5Bsize%5D=100");
        let body = self.get_json(&url).await?;
        let data = body
            .get("data")
            .and_then(|v| v.as_array())
            .ok_or_else(|| AppError::Other {
                message: "Unexpected response shape from /assets".into(),
            })?;
        Ok(data
            .iter()
            .filter_map(|item| {
                let attrs = item.get("attributes")?;
                Some(Asset {
                    id: item.get("id")?.as_str()?.to_string(),
                    identifier: attrs.get("identifier")?.as_str()?.to_string(),
                    asset_type: attrs
                        .get("asset_type")
                        .and_then(|v| v.as_str())
                        .map(String::from),
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
            let data =
                body.get("data")
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| AppError::Other {
                        message: "Unexpected response shape from /programs/.../members".into(),
                    })?;
            for item in data {
                let Some(attrs) = item.get("attributes") else {
                    continue;
                };
                let Some(user_id) = attrs.get("user_id").and_then(|v| {
                    v.as_str()
                        .map(String::from)
                        .or_else(|| v.as_u64().map(|n| n.to_string()))
                }) else {
                    continue;
                };
                let Some(username) = attrs.get("username").and_then(|v| v.as_str()) else {
                    continue;
                };
                members.push(TeamMember {
                    id: user_id,
                    username: username.to_string(),
                });
            }
            match body
                .get("links")
                .and_then(|l| l.get("next"))
                .and_then(|n| n.as_str())
            {
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
                    (
                        "filter[program][]".to_string(),
                        query.program_handle.clone(),
                    ),
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
                for assignee in &query.assignees {
                    params.push(("filter[assignee][]".to_string(), assignee.clone()));
                }
                if let Some(keyword) = query
                    .keyword
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    params.push(("filter[keyword]".to_string(), keyword.to_string()));
                }
                if let Some(since) = query
                    .since_created_at
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    params.push(("filter[created_at__gt]".to_string(), since.to_string()));
                }
                let qs = serde_urlencoded::to_string(&params).map_err(AppError::other)?;
                format!("{BASE_URL}/reports?{qs}")
            }
        };

        #[cfg(debug_assertions)]
        println!("[reports] GET {url}");

        let body = self.get_json(&url).await?;
        let data = body
            .get("data")
            .and_then(|v| v.as_array())
            .ok_or_else(|| AppError::Other {
                message: "Unexpected response shape from /reports".into(),
            })?;

        let items = data
            .iter()
            .filter_map(|item| {
                let attrs = item.get("attributes")?;
                let rel = item.get("relationships");
                Some(ReportSummary {
                    id: item.get("id")?.as_str()?.to_string(),
                    title: attrs.get("title")?.as_str()?.to_string(),
                    vulnerability_information: attrs
                        .get("vulnerability_information")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    state: attrs
                        .get("state")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
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
                    weakness: rel
                        .and_then(|r| r.get("weakness"))
                        .and_then(parse_weakness_ref),
                    reporter: rel
                        .and_then(|r| r.get("reporter"))
                        .and_then(parse_user_ref)?,
                    assignee: rel
                        .and_then(|r| r.get("assignee"))
                        .and_then(parse_assignee_ref),
                    inboxes: parse_inboxes(rel),
                    bounty: parse_bounty(rel),
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
        let url = format!("{BASE_URL}/reports/{report_id}");

        #[cfg(debug_assertions)]
        println!("[report] GET {url}");

        let body = self.get_json(&format!("{url}")).await?;
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
    // asset_id is only referenced by the debug-only println below, so it reads
    // as unused in release builds.
    #[cfg_attr(not(debug_assertions), allow(unused_variables))]
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
    let username = attrs
        .get("username")
        .and_then(|v| v.as_str())
        .map(String::from);
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
    Some(AssigneeRef {
        kind,
        id,
        username,
        name,
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

fn parse_inboxes(rel: Option<&serde_json::Value>) -> Vec<InboxRef> {
    rel.and_then(|r| r.get("inboxes"))
        .and_then(|i| i.get("data"))
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let attrs = item.get("attributes")?;
                    Some(InboxRef {
                        id: item.get("id")?.as_str()?.to_string(),
                        name: attrs.get("name")?.as_str()?.to_string(),
                        kind: attrs.get("type").and_then(|v| v.as_str()).map(String::from),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

// HackerOne returns money as JSON strings ("450.00"); tolerate numbers too.
fn parse_money(v: Option<&serde_json::Value>) -> f64 {
    match v {
        Some(serde_json::Value::String(s)) => s.parse::<f64>().unwrap_or(0.0),
        Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

// Sum the awarded amount (base + bonus) across every bounty on a report. Returns None
// when there are no bounties so the frontend can render an empty cell rather than $0.
fn parse_bounty(rel: Option<&serde_json::Value>) -> Option<BountyTotal> {
    let arr = rel?.get("bounties")?.get("data")?.as_array()?;
    if arr.is_empty() {
        return None;
    }
    let mut amount = 0.0;
    let mut currency = None;
    for item in arr {
        let Some(attrs) = item.get("attributes") else {
            continue;
        };
        amount += parse_money(attrs.get("awarded_amount"));
        amount += parse_money(attrs.get("awarded_bonus_amount"));
        if currency.is_none() {
            currency = attrs
                .get("awarded_currency")
                .and_then(|v| v.as_str())
                .map(String::from);
        }
    }
    Some(BountyTotal { amount, currency })
}

fn parse_asset_ref(rel: &serde_json::Value) -> Option<AssetRef> {
    let data = rel.get("data")?;
    let attrs = data.get("attributes")?;
    Some(AssetRef {
        id: data.get("id")?.as_str()?.to_string(),
        asset_identifier: attrs.get("asset_identifier")?.as_str()?.to_string(),
        asset_type: attrs
            .get("asset_type")
            .and_then(|v| v.as_str())
            .map(String::from),
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
        content_type: attrs
            .get("content_type")
            .and_then(|v| v.as_str())
            .map(String::from),
        file_size: attrs.get("file_size").and_then(|v| v.as_u64()),
        expiring_url: attrs
            .get("expiring_url")
            .and_then(|v| v.as_str())?
            .to_string(),
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
    let internal = attrs
        .get("internal")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let message = attrs
        .get("message")
        .and_then(|v| v.as_str())
        .map(String::from);
    let relationships = item.get("relationships");
    let actor = relationships
        .and_then(|r| r.get("actor"))
        .and_then(parse_user_ref);

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
            attrs
                .get("email")
                .and_then(|v| v.as_str())
                .map(String::from)
        } else {
            None
        };
        let duplicate_report_id = if kind_short == "external-user-joined" {
            attrs.get("duplicate_report_id").and_then(|v| {
                v.as_u64()
                    .map(|n| n.to_string())
                    .or_else(|| v.as_str().map(String::from))
            })
        } else {
            None
        };
        let original_report_id = if kind_short == "bug-duplicate" {
            attrs.get("original_report_id").and_then(|v| {
                v.as_u64()
                    .map(|n| n.to_string())
                    .or_else(|| v.as_str().map(String::from))
            })
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
        let severity_rating = |key: &str| -> Option<String> {
            relationships?
                .get(key)?
                .get("data")?
                .get("attributes")?
                .get("rating")?
                .as_str()
                .map(String::from)
        };
        let (old_severity, new_severity) = if kind_short == "report-severity-updated" {
            (
                severity_rating("old_severity"),
                severity_rating("new_severity"),
            )
        } else {
            (None, None)
        };
        let (old_title, new_title) = if kind_short == "report-title-updated" {
            (
                attrs
                    .get("old_title")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                attrs
                    .get("new_title")
                    .and_then(|v| v.as_str())
                    .map(String::from),
            )
        } else {
            (None, None)
        };
        let (bounty_amount, bonus_amount) =
            if kind_short == "bounty-suggested" || kind_short == "bounty-awarded" {
                (
                    attrs.get("bounty_amount").map(|v| parse_money(Some(v))),
                    attrs.get("bonus_amount").map(|v| parse_money(Some(v))),
                )
            } else {
                (None, None)
            };
        let assigned_user = if kind_short == "user-assigned-to-bug" {
            relationships
                .and_then(|r| r.get("assigned_user"))
                .and_then(parse_user_ref)
        } else {
            None
        };
        let reference = if kind_short == "reference-id-added" {
            attrs
                .get("reference")
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
            original_report_id,
            old_scope,
            new_scope,
            new_weakness,
            group_name,
            old_severity,
            new_severity,
            old_title,
            new_title,
            bounty_amount,
            bonus_amount,
            assigned_user,
            reference,
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
        state: attrs
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
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
        reporter: rel
            .and_then(|r| r.get("reporter"))
            .and_then(parse_user_ref)?,
        weakness: rel
            .and_then(|r| r.get("weakness"))
            .and_then(parse_weakness_ref),
        asset: rel
            .and_then(|r| r.get("structured_scope"))
            .and_then(parse_asset_ref),
        inboxes: parse_inboxes(rel),
        activities,
        attachments: parse_attachments(rel),
    })
}

#[cfg(test)]
mod auth_url_tests {
    use super::*;

    #[test]
    fn accepts_hackerone_https_urls() {
        assert!(ReqwestClient::ensure_api_url(&format!("{BASE_URL}/reports")).is_ok());
        assert!(
            ReqwestClient::ensure_api_url("https://api.hackerone.com/v1/me/organizations").is_ok()
        );
    }

    #[test]
    fn rejects_other_hosts_and_schemes() {
        // A tampered `links.next` pointing elsewhere must not receive the credentials.
        assert!(ReqwestClient::ensure_api_url("https://evil.example.com/v1/reports").is_err());
        // Look-alike hosts.
        assert!(ReqwestClient::ensure_api_url("https://api.hackerone.com.evil.com/v1").is_err());
        // Downgraded scheme.
        assert!(ReqwestClient::ensure_api_url("http://api.hackerone.com/v1/reports").is_err());
        // Garbage.
        assert!(ReqwestClient::ensure_api_url("not a url").is_err());
    }
}
