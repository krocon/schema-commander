//! Structured, serialisable errors (`AppError { code, message }`), as in files-and-folders-tauri,
//! editlicious and log-commander. `src/app/core/errors/app-error.ts` mirrors the codes.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The statement is empty, too long or was refused by the database; the message is the engine's.
    InvalidQuery,
    /// A value of a command is not what it must be (e.g. a colour that is not `#rrggbb`).
    Unsupported,
    Io,
}

/// Error returned by Tauri commands: `{ "code": "...", "message": "..." }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_code_as_snake_case() {
        let e = AppError::new(ErrorCode::InvalidQuery, "near \"selec\": syntax error");
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["code"], "invalid_query");
        assert_eq!(json["message"], "near \"selec\": syntax error");
    }
}
