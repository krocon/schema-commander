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
    /// The statement writes or destroys and the connection wants a confirmation first (prompt 012).
    ConfirmationRequired,
    /// The SSH server shows a key that is in no known_hosts: the message holds type and fingerprint; a
    /// connect that names this fingerprint records it (prompt 014).
    HostKeyUnknown,
    /// The SSH server shows another key than the one on record, or a revoked one. There is no way past.
    HostKeyChanged,
    /// The SSH tunnel needs a password or the passphrase of its key file.
    SshSecretRequired,
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
    /// Formatting (prompt 023): the text ends inside a string, a quoted name or a comment.
    FormatIncomplete,
    /// Brackets and blocks inside each other deeper than the formatter follows.
    FormatTooDeep,
    /// The formatted text would not have had the tokens of the text; nothing was changed.
    FormatUnsafe,
    /// A program of a database (`pg_dump`, `mysqldump` …) is not on this machine (prompt 044).
    ProgramNotFound,
    Io,
}

/// What a database says about a failed statement beyond its message (prompt 022). Every part is
/// optional: each database tells what it knows.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetails {
    /// `SQLSTATE` (PostgreSQL, MySQL) or the number of the error (SQL Server, MySQL), as text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sqlstate: Option<String>,
    /// PostgreSQL's `DETAIL`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// PostgreSQL's `HINT`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// Where in the statement, counted in characters from 1 (PostgreSQL, SQLite).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<u32>,
    /// The line of the statement, from 1 (MySQL, SQL Server).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    /// The text the database stumbled over (MySQL: `near '…'`; SQL Server: the name in quotes).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub near: Option<String>,
    /// PostgreSQL's `CONTEXT` (where in a function …).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constraint: Option<String>,
}

impl ErrorDetails {
    /// Nothing is known: the details are left out.
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// Error returned by Tauri commands: `{ "code": "...", "message": "...", "details": { … } }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    /// What the database told about a failed statement; absent for errors of the app itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Box<ErrorDetails>>,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    /// Adds what the database told; empty details are left out.
    pub fn with(mut self, details: ErrorDetails) -> Self {
        self.details = (!details.is_empty()).then(|| Box::new(details));
        self
    }
}

/// The text between the first pair of single quotes of a message (`Invalid column name 'nmae'.`).
pub fn quoted_part(message: &str) -> Option<String> {
    let start = message.find('\'')? + 1;
    let end = start + message[start..].find('\'')?;
    let part = &message[start..end];
    (!part.trim().is_empty()).then(|| part.to_string())
}

/// What MySQL says where a syntax error is: `… near 'selec 1' at line 3`. The text may hold quotes of
/// its own, so it ends at the last `' at line`.
pub fn mysql_near(message: &str) -> (Option<String>, Option<u32>) {
    let line = message.rfind(" at line ").and_then(|i| {
        message[i + 9..]
            .trim()
            .trim_end_matches('.')
            .parse::<u32>()
            .ok()
    });
    let near = message.find("near '").and_then(|i| {
        let rest = &message[i + 6..];
        let end = rest.rfind("' at line").or_else(|| rest.rfind('\''))?;
        (!rest[..end].is_empty()).then(|| rest[..end].to_string())
    });
    (near, line)
}

/// A byte offset into a text as a position in characters from 1 (SQLite counts bytes).
pub fn char_position(sql: &str, byte_offset: usize) -> Option<u32> {
    if byte_offset > sql.len() {
        return None;
    }
    // an offset inside a character means that character
    let mut end = byte_offset;
    while !sql.is_char_boundary(end) {
        end -= 1;
    }
    u32::try_from(sql[..end].chars().count() + 1).ok()
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
        // an error of the app itself has no details at all
        assert!(json.get("details").is_none());
    }

    #[test]
    fn carries_what_the_database_told_and_leaves_out_what_it_did_not() {
        let e = AppError::new(ErrorCode::InvalidQuery, "x").with(ErrorDetails {
            sqlstate: Some("23503".into()),
            detail: Some("Key (a)=(1) is not present in table \"t\".".into()),
            position: Some(8),
            constraint: Some("fk".into()),
            ..Default::default()
        });
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["details"]["sqlstate"], "23503");
        assert_eq!(json["details"]["position"], 8);
        assert_eq!(json["details"]["constraint"], "fk");
        assert!(json["details"].get("hint").is_none());
        // nothing known: no details
        let none = AppError::new(ErrorCode::InvalidQuery, "x").with(ErrorDetails::default());
        assert_eq!(none.details, None);
    }

    #[test]
    fn reads_where_mysql_and_sql_server_stumbled() {
        let m = "You have an error in your SQL syntax; check the manual that corresponds to your \
                 MySQL server version for the right syntax to use near 'selec 'it''s' FROM t' at line 3";
        assert_eq!(
            mysql_near(m),
            (Some("selec 'it''s' FROM t".into()), Some(3))
        );
        assert_eq!(mysql_near("Table 'shop.nope' doesn't exist"), (None, None));
        assert_eq!(mysql_near("… near '' at line 1"), (None, Some(1)));
        assert_eq!(
            quoted_part("Invalid column name 'nmae'."),
            Some("nmae".into())
        );
        assert_eq!(
            quoted_part("Incorrect syntax near 'FORM'."),
            Some("FORM".into())
        );
        assert_eq!(quoted_part("Divide by zero error encountered."), None);
        assert_eq!(quoted_part("near ''"), None);
    }

    #[test]
    fn turns_bytes_into_characters() {
        let sql = "SELECT 'ä😀' FORM t";
        // `FORM` starts behind 7 + 1 + 2 + 4 + 1 + 1 bytes
        assert_eq!(char_position(sql, 16), Some(13));
        assert_eq!(char_position(sql, 0), Some(1));
        // inside the emoji: the emoji
        assert_eq!(char_position(sql, 12), Some(10));
        assert_eq!(char_position(sql, sql.len()), Some(19));
        assert_eq!(char_position(sql, 999), None);
    }
}
