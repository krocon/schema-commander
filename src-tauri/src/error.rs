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
    /// A colour scheme (file) that breaks a rule: shape, bounds, values (design 001).
    InvalidTheme,
    /// A file is larger than a command reads.
    TooLarge,
    NotFound,
    /// A result that is not (any more) in the store (prompt 006).
    UnknownResult,
    /// The session of open tabs (prompt 004): a tab id or entry that breaks a rule.
    InvalidSession,
    /// A text cannot be written in the encoding of its file without losing characters.
    EncodingFailed,
    /// Connections (prompt 003): the server cannot be reached, does not answer or the connection broke.
    ConnectionFailed,
    /// The server refused the login (user, password).
    AuthFailed,
    /// TLS could not be set up (certificate, host name, protocol).
    TlsFailed,
    /// No answer in time.
    Timeout,
    /// The work was stopped on request. Not an error for the user.
    Cancelled,
    /// The server refused the statement for lack of rights.
    PermissionDenied,
    /// A password is needed and none is known: the frontend asks for it.
    SecretRequired,
    /// The keychain of the OS is not available (no Secret Service, locked, error).
    KeychainUnavailable,
    /// A connection profile breaks a rule (name, host, user …).
    InvalidProfile,
    /// There is no profile with this id.
    UnknownConnection,
    /// The profile is not connected (any more).
    NotConnected,
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
