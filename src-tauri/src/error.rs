use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AppError {
    Unauthorized { message: String },
    Forbidden { message: String },
    NotFound { message: String },
    RateLimited { message: String },
    Network { message: String },
    Other { message: String },
}

impl AppError {
    pub fn other(e: impl std::fmt::Display) -> Self {
        AppError::Other { message: e.to_string() }
    }

    pub fn from_status(status: u16, body: &str) -> Self {
        let message = if body.is_empty() {
            format!("HTTP {status}")
        } else {
            format!("HTTP {status}: {body}")
        };
        match status {
            401 => AppError::Unauthorized { message },
            403 => AppError::Forbidden { message },
            404 => AppError::NotFound { message },
            429 => AppError::RateLimited { message },
            _ => AppError::Other { message },
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::Unauthorized { message }
            | AppError::Forbidden { message }
            | AppError::NotFound { message }
            | AppError::RateLimited { message }
            | AppError::Network { message }
            | AppError::Other { message } => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for AppError {}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Network { message: e.to_string() }
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        AppError::Other { message: format!("keyring: {e}") }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Other { message: format!("json: {e}") }
    }
}

pub type AppResult<T> = Result<T, AppError>;
