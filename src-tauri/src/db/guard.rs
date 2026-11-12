//! Protection of connections (prompt 012): what a statement does – read, write, change the schema, destroy –
//! and whether a connection lets it run. A scanner of our own, no SQL parser: it only has to be right in one
//! direction. Whatever it does not know for sure is a write; **a statement that writes is never taken for
//! one that reads**. Pure.

use super::DbKind;
use crate::error::{AppError, ErrorCode};
use serde::{Deserialize, Serialize};

/// What a statement does, the mildest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Class {
    /// Reads, or only steers the session (transactions).
    Read,
    /// Changes data – or is unknown.
    Write,
    /// Changes the schema.
    Ddl,
    /// Destroys or gives away: `UPDATE`/`DELETE` without `WHERE`, `TRUNCATE`, `DROP`, `GRANT`, `REVOKE`.
    Dangerous,
}

/// How a connection is protected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protection {
    /// Only what is dangerous asks first.
    #[default]
    Free,
    /// Everything but reading asks first.
    Ask,
    /// Nothing but reading runs.
    Readonly,
}

/// What a statement needs before it may run on a connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Need {
    Nothing,
    /// A yes.
    Confirm,
    /// The name of the connection, typed.
    TypeName,
    /// It does not run here.
    Refused,
}

/// The rule: what `class` needs on a connection with `protection`. `allow_dangerous` is the user's setting
/// "do not ask for dangerous statements on free connections"; it never loosens a protected connection.
pub fn need(protection: Protection, class: Class, allow_dangerous: bool) -> Need {
    match (protection, class) {
        (_, Class::Read) => Need::Nothing,
        (Protection::Readonly, _) => Need::Refused,
        (Protection::Ask, Class::Dangerous) => Need::TypeName,
        (Protection::Ask, _) => Need::Confirm,
        (Protection::Free, Class::Dangerous) if !allow_dangerous => Need::Confirm,
        (Protection::Free, _) => Need::Nothing,
    }
}

/// The error for a statement that must not run (yet).
pub fn refusal(n: Need, class: Class) -> AppError {
    let what = match class {
        Class::Read => "read",
        Class::Write => "write",
        Class::Ddl => "ddl",
        Class::Dangerous => "dangerous",
    };
    match n {
        Need::Refused => AppError::new(
            ErrorCode::PermissionDenied,
            format!("this connection is read only ({what} statement)"),
        ),
        _ => AppError::new(
            ErrorCode::ConfirmationRequired,
            format!("this statement needs a confirmation ({what})"),
        ),
    }
}

// --- scanning ----------------------------------------------------------------------------------------

/// A piece of a statement.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Tok {
    /// A bare word, upper case.
    Word(String),
    /// A quoted name, upper case (`"set_config"`, `` `x` ``, `[x]`).
    Quoted(String),
    /// A string, upper case.
    Str(String),
    Open,
    Close,
    Semi,
    Dot,
    /// Any other sign or a number.
    Other,
}

/// What the scanner found.
struct Scan {
    toks: Vec<Tok>,
    /// The text can be read in two ways, depending on a setting of the server we do not know (a backslash
    /// before a quote, a `U&` escape): what stands behind may be code. Such a text never counts as reading.
    ambiguous: bool,
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// The tokens of a text: comments are dropped as the dialect drops them, strings and quoted names are one
/// token each. A string or comment that never ends runs to the end of the text.
fn scan(sql: &str, kind: DbKind) -> Scan {
    let chars: Vec<char> = sql.chars().collect();
    let n = chars.len();
    let mut toks = Vec::new();
    let mut ambiguous = false;
    let mut i = 0;
    while i < n {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c.is_whitespace() || c.is_control() {
            i += 1;
        } else if c == '-' && next == Some('-') {
            // MySQL takes `--` for a comment only before a space; else it is twice a minus
            let after = chars.get(i + 2).copied();
            let comment =
                kind != DbKind::Mysql || after.is_none_or(|a| a.is_whitespace() || a.is_control());
            if comment {
                while i < n && chars[i] != '\n' && chars[i] != '\r' {
                    i += 1;
                }
            } else {
                toks.push(Tok::Other);
                i += 1;
            }
        } else if c == '#' && kind == DbKind::Mysql {
            while i < n && chars[i] != '\n' && chars[i] != '\r' {
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            // MySQL and MariaDB run the text of /*! … */ and /*M! … */: it is code, not a comment
            if kind == DbKind::Mysql {
                let bang = match (chars.get(i + 2), chars.get(i + 3)) {
                    (Some('!'), _) => Some(3),
                    (Some('M' | 'm'), Some('!')) => Some(4),
                    _ => None,
                };
                if let Some(skip) = bang {
                    i += skip;
                    while i < n && chars[i].is_ascii_digit() {
                        i += 1;
                    }
                    continue;
                }
            }
            // PostgreSQL and SQL Server nest block comments
            let nests = matches!(kind, DbKind::Postgres | DbKind::Sqlserver | DbKind::Duckdb);
            let mut depth = 1;
            i += 2;
            while i < n && depth > 0 {
                if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                } else if nests && chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
        } else if c == '*' && next == Some('/') && kind == DbKind::Mysql {
            // the end of an executable comment
            i += 2;
        } else if c == '\'' || c == '"' || c == '`' {
            // A string or a quoted name: to its closing quote; a doubled quote stays inside. Whether a
            // backslash escapes depends on dialect and settings: a backslash before a quote is taken
            // as an escape here, and the text marked as not certainly reading.
            let quote = c;
            // U&'…' and U&"…" can spell anything with their escapes
            if i >= 2 && chars[i - 1] == '&' && matches!(chars[i - 2], 'u' | 'U') {
                ambiguous = true;
            }
            let start = i + 1;
            i += 1;
            while i < n {
                // Oracle knows no backslash escape, whatever the settings
                // ClickHouse takes it as an escape inside backticks too (review 035d 2)
                if chars[i] == '\\'
                    && (quote != '`' || kind == DbKind::Clickhouse)
                    && !matches!(kind, DbKind::Oracle | DbKind::Trino | DbKind::Firebird)
                    && i + 1 < n
                {
                    // (in BigQuery the backslash always is the escape: nothing to doubt)
                    if (chars[i + 1] == quote || chars[i + 1] == '\\') && kind != DbKind::Bigquery {
                        ambiguous = true;
                    }
                    i += 2;
                } else if chars[i] == quote {
                    if chars.get(i + 1) == Some(&quote) {
                        i += 2;
                    } else {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            let end = i.min(n);
            let body: String = chars[start..end].iter().collect::<String>().to_uppercase();
            i = (i + 1).min(n);
            if quote == '"' && kind == DbKind::Mysql && body.contains(';') {
                // a string, or a name under ANSI_QUOTES – with different ends when it holds a quote
                ambiguous = true;
            }
            toks.push(if quote == '\'' {
                Tok::Str(body)
            } else {
                Tok::Quoted(body)
            });
        } else if c == '['
            && matches!(
                kind,
                DbKind::Sqlserver | DbKind::Sqlite | DbKind::Libsql | DbKind::D1
            )
        {
            let start = i + 1;
            i += 1;
            while i < n {
                if chars[i] == ']' {
                    if kind == DbKind::Sqlserver && chars.get(i + 1) == Some(&']') {
                        i += 2;
                    } else {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            let body: String = chars[start..i.min(n)]
                .iter()
                .collect::<String>()
                .to_uppercase();
            i = (i + 1).min(n);
            toks.push(Tok::Quoted(body));
        } else if c == '$'
            && matches!(kind, DbKind::Postgres | DbKind::Duckdb)
            && dollar_tag(&chars, i).is_some()
        {
            // $tag$ … $tag$
            let tag = dollar_tag(&chars, i).unwrap_or_default();
            let body = (i + tag.len()).min(n);
            let end = find(&chars, body, &tag).unwrap_or(n);
            let text: String = chars[body..end].iter().collect::<String>().to_uppercase();
            i = (end + tag.len()).min(n);
            toks.push(Tok::Str(text));
        } else if c == '(' {
            toks.push(Tok::Open);
            i += 1;
        } else if c == ')' {
            toks.push(Tok::Close);
            i += 1;
        } else if c == ';' {
            toks.push(Tok::Semi);
            i += 1;
        } else if c == '.' {
            toks.push(Tok::Dot);
            i += 1;
        } else if c.is_alphabetic() || c == '_' {
            let start = i;
            while i < n && is_word_char(chars[i]) {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            // Oracle's q'[ … ]': a string that ends at its closing sign followed by a quote, and
            // holds quotes as they are
            if kind == DbKind::Oracle
                && matches!(word.to_ascii_uppercase().as_str(), "Q" | "NQ")
                && chars.get(i) == Some(&'\'')
                && i + 1 < n
            {
                let close = match chars[i + 1] {
                    '[' => ']',
                    '(' => ')',
                    '{' => '}',
                    '<' => '>',
                    other => other,
                };
                let body = i + 2;
                let end = find(&chars, body, &[close, '\'']).unwrap_or(n);
                let text: String = chars[body.min(n)..end]
                    .iter()
                    .collect::<String>()
                    .to_uppercase();
                i = (end + 2).min(n);
                toks.push(Tok::Str(text));
                continue;
            }
            toks.push(Tok::Word(word.to_uppercase()));
        } else {
            toks.push(Tok::Other);
            i += 1;
        }
    }
    Scan { toks, ambiguous }
}

/// `$$` or `$tag$` at `at`.
fn dollar_tag(chars: &[char], at: usize) -> Option<Vec<char>> {
    let mut i = at + 1;
    while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
        i += 1;
    }
    (chars.get(i) == Some(&'$') && !chars.get(at + 1).is_some_and(char::is_ascii_digit))
        .then(|| chars[at..=i].to_vec())
}

fn find(chars: &[char], from: usize, needle: &[char]) -> Option<usize> {
    if needle.is_empty() || from > chars.len() {
        return None;
    }
    (from..=chars.len().saturating_sub(needle.len()))
        .find(|&i| chars[i..i + needle.len()] == *needle)
}

/// Words a statement that reads may start with.
const READ_STARTS: &[&str] = &[
    "SELECT", "WITH", "VALUES", "TABLE", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "USE", "PRAGMA",
    "HELP",
];

/// Words that start a statement which only steers the transaction.
const TRANSACTION_STARTS: &[&str] = &[
    "BEGIN",
    "START",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT",
    "RELEASE",
    "END",
];

/// The only words such a statement may hold besides the name of a savepoint. `WRITE`, `PREPARED`,
/// `IMMEDIATE`, `EXCLUSIVE`, `REPLICA`, `DISTRIBUTED` … are not among them.
const TRANSACTION_WORDS: &[&str] = &[
    "BEGIN",
    "START",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT",
    "RELEASE",
    "END",
    "TRANSACTION",
    "TRAN",
    "WORK",
    "ISOLATION",
    "LEVEL",
    "READ",
    "ONLY",
    "COMMITTED",
    "UNCOMMITTED",
    "REPEATABLE",
    "SERIALIZABLE",
    "SNAPSHOT",
    "DEFERRABLE",
    "DEFERRED",
    "NOT",
    "TO",
    "AND",
    "NO",
    "CHAIN",
    "CONSISTENT",
    "WITH",
];

/// Words that make a statement a write wherever they stand in it (outside strings and quoted names).
const WRITE_WORDS: &[&str] = &[
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "UPSERT",
    "REPLACE",
    "INTO",
    "CALL",
    "EXEC",
    "EXECUTE",
    "DO",
    "COPY",
    "LOAD",
    "LOCK",
    "SET",
    "HANDLER",
    "IMPORT",
    "UNLOAD",
    "OUTFILE",
    "DUMPFILE",
    "OPENROWSET",
    "OPENQUERY",
    "OPENDATASOURCE",
    "PERFORM",
    "LISTEN",
    "NOTIFY",
    "UNLISTEN",
    "DISCARD",
    "RESET",
    "CHECKPOINT",
    "PREPARE",
    "PREPARED",
    "DEALLOCATE",
    "KILL",
    "SHUTDOWN",
    "FLUSH",
    "PURGE",
    "INSTALL",
    "UNINSTALL",
    "BACKUP",
    "RESTORE",
    "DBCC",
    "BULK",
    "WRITETEXT",
    "UPDATETEXT",
    "WRITE",
    "SHARE",
    "WAITFOR",
    "RECEIVE",
    "SEND",
    "CONVERSATION",
    "DIALOG",
    "DISABLE",
    "ENABLE",
    "REVERT",
    "RECONFIGURE",
    "SETUSER",
    "RAISERROR",
    "THROW",
    "DISTRIBUTED",
    "DECLARE",
    "XA",
    "STOP",
    "CHANGE",
    "BINLOG",
    "CACHE",
    "SIGNAL",
    "RESIGNAL",
    "IMMEDIATE",
    "EXCLUSIVE",
    "REPLICA",
    "SLAVE",
    "GROUP_REPLICATION",
];

/// More of them that only SQL Server knows as statements: there a batch needs no `;`, so a statement can
/// hide behind another. Elsewhere these are ordinary names.
const TSQL_WRITE_WORDS: &[&str] = &[
    "ADD", "OPEN", "CLOSE", "SAVE", "GOTO", "PRINT", "RETURN", "GO",
];

/// Functions that change something although they are called from a `SELECT`.
const WRITING_FUNCTIONS: &[&str] = &[
    // DuckDB: table functions that write files or settings
    "ENABLE_LOGGING",
    "DISABLE_LOGGING",
    "TRUNCATE_DUCKDB_LOGS",
    "NEXTVAL",
    "SETVAL",
    "SET_CONFIG",
    "QUERY_TO_XML",
    "QUERY_TO_XML_AND_XMLSCHEMA",
    "TABLE_TO_XML",
    "CURSOR_TO_XML",
    "TXID_CURRENT",
    "CROSSTAB",
    "GET_LOCK",
    "RELEASE_LOCK",
    "RELEASE_ALL_LOCKS",
    "LOAD_FILE",
    "SLEEP",
    "BENCHMARK",
    "LAST_INSERT_ID",
    "MASTER_POS_WAIT",
    "SOURCE_POS_WAIT",
    "WAIT_FOR_EXECUTED_GTID_SET",
    "LOAD_EXTENSION",
    "WRITEFILE",
    "READFILE",
    "EDIT",
    "ZIPFILE",
    "FTS3_TOKENIZER",
    "LOWRITE",
    "LOREAD",
];

/// Functions whose names start like this are taken for writing, but for [`READING_PG_FUNCTIONS`].
const WRITING_PREFIXES: &[&str] = &[
    "PG_", "LO_", "DBLINK", "SYS_", "XP_", "SP_", "BRIN_", "GIN_",
];

/// Functions of PostgreSQL that start with `pg_` and only tell something.
const READING_PG_FUNCTIONS: &[&str] = &[
    "PG_TYPEOF",
    "PG_COLUMN_SIZE",
    "PG_SIZE_PRETTY",
    "PG_SIZE_BYTES",
    "PG_TABLE_SIZE",
    "PG_TOTAL_RELATION_SIZE",
    "PG_RELATION_SIZE",
    "PG_DATABASE_SIZE",
    "PG_INDEXES_SIZE",
    "PG_TABLESPACE_SIZE",
    "PG_BACKEND_PID",
    "PG_IS_IN_RECOVERY",
    "PG_POSTMASTER_START_TIME",
    "PG_CONF_LOAD_TIME",
    "PG_ENCODING_TO_CHAR",
    "PG_CHAR_TO_ENCODING",
    "PG_TABLE_IS_VISIBLE",
    "PG_TYPE_IS_VISIBLE",
    "PG_FUNCTION_IS_VISIBLE",
    "PG_HAS_ROLE",
    "PG_RELATION_FILEPATH",
    "PG_MY_TEMP_SCHEMA",
    "PG_IS_OTHER_TEMP_SCHEMA",
    "PG_COLLATION_FOR",
    "PG_DESCRIBE_OBJECT",
    "PG_IDENTIFY_OBJECT",
    "PG_INPUT_IS_VALID",
    "PG_BLOCKING_PIDS",
    "PG_CURRENT_SNAPSHOT",
    "PG_CLIENT_ENCODING",
];

const DDL_WORDS: &[&str] = &[
    "CREATE", "ALTER", "COMMENT", "RENAME", "REINDEX", "VACUUM", "ANALYZE", "ANALYSE", "CLUSTER",
    "REFRESH", "ATTACH", "DETACH", "OPTIMIZE", "REPAIR", "SECURITY",
];

const DANGEROUS_WORDS: &[&str] = &["DROP", "TRUNCATE", "GRANT", "REVOKE", "DENY"];

/// Pragmas of SQLite that only tell something.
const READ_PRAGMAS: &[&str] = &[
    "TABLE_INFO",
    "TABLE_XINFO",
    "TABLE_LIST",
    "INDEX_LIST",
    "INDEX_INFO",
    "INDEX_XINFO",
    "FOREIGN_KEY_LIST",
    "DATABASE_LIST",
    "COLLATION_LIST",
    "FUNCTION_LIST",
    "MODULE_LIST",
    "PRAGMA_LIST",
    "COMPILE_OPTIONS",
    "INTEGRITY_CHECK",
    "QUICK_CHECK",
    "FOREIGN_KEY_CHECK",
];

/// Before these, `UPDATE` and `DELETE` are part of something else (`FOR UPDATE`, `ON DELETE CASCADE`,
/// `DO UPDATE`, `THEN DELETE`), not a statement that needs its own `WHERE`.
const NOT_A_STATEMENT_AFTER: &[&str] = &[
    "FOR", "DO", "THEN", "ON", "KEY", "NO", "OF", "BEFORE", "AFTER", "OR", "INSTEAD",
];

/// Statements that run text: what the text does counts for them.
const RUNS_TEXT: &[&str] = &["DO", "EXEC", "EXECUTE", "PREPARE", "CALL"];

fn word(t: &Tok) -> Option<&str> {
    match t {
        Tok::Word(w) => Some(w.as_str()),
        _ => None,
    }
}

/// Whether `text` holds `needle` as a word of its own.
fn holds_word(text: &str, needle: &str) -> bool {
    text.match_indices(needle).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + needle.len()..].chars().next();
        !before.is_some_and(is_word_char) && !after.is_some_and(is_word_char)
    })
}

/// A call of a function that is known or suspected to change something.
fn calls_writing_function(toks: &[Tok]) -> bool {
    toks.windows(2).any(|pair| {
        let name = match &pair[0] {
            Tok::Word(w) | Tok::Quoted(w) => w.as_str(),
            _ => return false,
        };
        pair[1] == Tok::Open
            && (WRITING_FUNCTIONS.contains(&name)
                || (WRITING_PREFIXES.iter().any(|p| name.starts_with(p))
                    && !READING_PG_FUNCTIONS.contains(&name)
                    && !name.starts_with("PG_GET_")
                    && !name.starts_with("PG_STAT_GET_")))
    })
}

/// A statement that only steers the transaction and cannot open one that writes.
fn plain_transaction_control(toks: &[Tok]) -> bool {
    let mut name_may_follow = false;
    for t in toks {
        match t {
            Tok::Word(w) => {
                let known = TRANSACTION_WORDS.contains(&w.as_str());
                // one name: of a savepoint, behind SAVEPOINT, TO or RELEASE
                if !known && !name_may_follow {
                    return false;
                }
                name_may_follow = known && matches!(w.as_str(), "SAVEPOINT" | "TO" | "RELEASE");
            }
            Tok::Quoted(_) if name_may_follow => name_may_follow = false,
            // commas between the modes of a transaction
            Tok::Other => {}
            _ => return false,
        }
    }
    true
}

/// `PRAGMA [schema.]name` or `PRAGMA [schema.]name(argument)` of a pragma that only tells something.
/// Anything else – another name, an assignment – changes the database or the session.
fn read_pragma(toks: &[Tok]) -> bool {
    let (name, rest) = match toks {
        [_, Tok::Word(_), Tok::Dot, Tok::Word(name), rest @ ..] => (name, rest),
        [_, Tok::Word(name), rest @ ..] => (name, rest),
        _ => return false,
    };
    if !READ_PRAGMAS.contains(&name.as_str()) {
        return false;
    }
    match rest {
        [] => true,
        [Tok::Open, inner, Tok::Close] => {
            matches!(
                inner,
                Tok::Word(_) | Tok::Quoted(_) | Tok::Str(_) | Tok::Other
            )
        }
        _ => false,
    }
}

/// One statement (no `;` in it).
fn classify_one(toks: &[Tok], kind: DbKind) -> Option<Class> {
    // what it starts with, behind opening parentheses
    let first = toks.iter().find(|t| **t != Tok::Open)?;
    let Some(start) = word(first) else {
        return Some(Class::Write);
    };
    let words: Vec<&str> = toks.iter().filter_map(word).collect();
    let has = |list: &[&str]| words.iter().any(|w| list.contains(w));

    if start == "PRAGMA" {
        // its value may be any word (`journal_mode = DELETE`): no statement hides in it
        return Some(if kind.is_sqlite() && read_pragma(toks) {
            Class::Read
        } else if has(DDL_WORDS) {
            Class::Ddl
        } else {
            Class::Write
        });
    }
    // only that: `BEGIN READ WRITE`, a T-SQL block or `END CONVERSATION` are judged by what they hold
    if TRANSACTION_STARTS.contains(&start) && plain_transaction_control(toks) {
        return Some(Class::Read);
    }

    if kind == DbKind::Duckdb
        && (matches!(start, "INSTALL" | "LOAD" | "FORCE")
            || (start == "UPDATE" && words.get(1) == Some(&"EXTENSIONS")))
    {
        // code from the net, run inside the app: asked about like what destroys
        return Some(Class::Dangerous);
    }
    if kind == DbKind::Duckdb
        && matches!(start, "SET" | "RESET" | "PRAGMA")
        && words
            .iter()
            .any(|w| w.contains("EXTENSION") || *w == "ENABLE_EXTERNAL_ACCESS")
    {
        // the switches that keep extensions from loading on their own (and files in reach): turning
        // them is the first half of running foreign code
        return Some(Class::Dangerous);
    }
    if kind == DbKind::Firebird && start == "RECREATE" {
        // drops what is there and makes it anew: the rows of a table are gone with it
        return Some(Class::Dangerous);
    }
    if kind == DbKind::Clickhouse && matches!(start, "SYSTEM" | "KILL") {
        // the server itself: stop it, drop its caches, end what others run
        return Some(Class::Dangerous);
    }
    let mut class = if READ_STARTS.contains(&start) {
        Class::Read
    } else if DANGEROUS_WORDS.contains(&start) {
        Class::Dangerous
    } else if DDL_WORDS.contains(&start) {
        Class::Ddl
    } else {
        Class::Write
    };

    if class == Class::Read {
        // a statement that looks like reading writes when a writing word stands anywhere in it
        let pairs = |a: &str, b: &str| words.windows(2).any(|w| w[0] == a && w[1] == b);
        if has(DANGEROUS_WORDS) {
            class = Class::Dangerous;
        } else if has(WRITE_WORDS)
            || (kind == DbKind::Sqlserver && has(TSQL_WRITE_WORDS))
            || calls_writing_function(toks)
            || (kind == DbKind::Oracle && has(&["NEXTVAL"]))
            || pairs("NEXT", "VALUE")
            || pairs("PREVIOUS", "VALUE")
        {
            class = Class::Write;
        } else if has(DDL_WORDS) && !matches!(start, "SHOW" | "DESCRIBE" | "DESC" | "HELP") {
            // `SHOW CREATE TABLE` only tells. `EXPLAIN ANALYZE` runs the statement; one that only
            // reads stays reading
            let only_analyze = start == "EXPLAIN"
                && words
                    .iter()
                    .all(|w| !DDL_WORDS.contains(w) || matches!(*w, "ANALYZE" | "ANALYSE"));
            if !only_analyze {
                class = Class::Ddl;
            }
        }
        if start == "USE" && kind != DbKind::Mysql && kind != DbKind::Sqlserver {
            class = Class::Write;
        }
    }

    if class == Class::Ddl
        && matches!(start, "CREATE" | "ALTER")
        && matches!(words.get(1).copied(), Some("ROLE" | "USER" | "LOGIN"))
    {
        // who may log in and what a role is: it gives away like a GRANT does (review 047 M1)
        class = Class::Dangerous;
    }
    if kind == DbKind::Bigquery
        && class == Class::Read
        && toks.windows(2).any(|w| {
            matches!(&w[0], Tok::Word(name) if name == "EXTERNAL_QUERY") && w[1] == Tok::Open
        })
    {
        // hands a text to another database: what it does there nobody reads here
        class = Class::Write;
    }
    if kind == DbKind::Firebird
        && class == Class::Read
        && toks
            .windows(2)
            .any(|w| matches!(&w[0], Tok::Word(name) if name == "GEN_ID") && w[1] == Tok::Open)
    {
        // moves a sequence – also inside a transaction that only reads (review 035i 7)
        class = Class::Write;
    }
    if kind == DbKind::Trino
        && class == Class::Read
        && toks
            .windows(2)
            .any(|w| matches!(&w[0], Tok::Word(name) if name == "TABLE") && w[1] == Tok::Open)
    {
        // `TABLE(catalog.system.query(query => '…'))` hands a text to the database behind a catalog:
        // what it does there nobody reads here
        class = Class::Write;
    }
    if kind == DbKind::Clickhouse && class == Class::Read && reaches_out(toks) {
        // a table function that reads files of the server or calls another one: no plain reading
        class = Class::Write;
    }
    if class < Class::Dangerous && has(DANGEROUS_WORDS) {
        // ALTER … DROP …, a batch that also drops
        class = Class::Dangerous;
    }
    if class < Class::Dangerous && has(RUNS_TEXT) {
        // the text a statement runs is a statement too
        let destroys = toks.iter().any(|t| match t {
            Tok::Str(body) => DANGEROUS_WORDS.iter().any(|w| holds_word(body, w)),
            _ => false,
        });
        if destroys {
            class = Class::Dangerous;
        }
    }
    if class < Class::Dangerous && unbounded_change(toks) {
        class = Class::Dangerous;
    }
    Some(class)
}

/// ClickHouse: a table function that leaves the database – a file of the server, another server, a
/// program – called anywhere in the statement.
fn reaches_out(toks: &[Tok]) -> bool {
    const OUT: &[&str] = &[
        "URL",
        "URLCLUSTER",
        "REMOTE",
        "REMOTESECURE",
        "CLUSTER",
        "CLUSTERALLREPLICAS",
        "FILE",
        "FILECLUSTER",
        "S3",
        "S3CLUSTER",
        "GCS",
        "HDFS",
        "HDFSCLUSTER",
        "AZUREBLOBSTORAGE",
        "MYSQL",
        "POSTGRESQL",
        "MONGODB",
        "REDIS",
        "SQLITE",
        "ODBC",
        "JDBC",
        "EXECUTABLE",
        "DELTALAKE",
        "ICEBERG",
        "HUDI",
        "INPUT",
    ];
    toks.windows(2).any(|w| {
        matches!(&w[0], Tok::Word(name) if OUT.contains(&name.as_str())) && w[1] == Tok::Open
    })
}

/// An `UPDATE` or `DELETE` statement (also inside parentheses, as in a CTE) without a `WHERE` of its own.
fn unbounded_change(toks: &[Tok]) -> bool {
    let mut depth: i32 = 0;
    let mut previous: Option<&str> = None;
    for (i, t) in toks.iter().enumerate() {
        match t {
            Tok::Open => depth += 1,
            Tok::Close => depth -= 1,
            _ => {}
        }
        if let Some(w) = word(t) {
            let statement = matches!(w, "UPDATE" | "DELETE")
                && !previous.is_some_and(|p| NOT_A_STATEMENT_AFTER.contains(&p));
            if statement {
                // its WHERE: at the same depth, before the parenthesis it is in closes
                let mut d = depth;
                let mut found = false;
                for later in &toks[i + 1..] {
                    match later {
                        Tok::Open => d += 1,
                        Tok::Close => {
                            d -= 1;
                            if d < depth {
                                break;
                            }
                        }
                        Tok::Word(x) if d == depth && x == "WHERE" => {
                            found = true;
                            break;
                        }
                        _ => {}
                    }
                }
                if !found {
                    return true;
                }
            }
            previous = Some(w);
        } else if !matches!(t, Tok::Open) {
            previous = None;
        }
    }
    false
}

/// What a text does: the worst of its statements. An empty text reads.
pub fn classify(sql: &str, kind: DbKind) -> Class {
    let scan = scan(sql, kind);
    let mut worst = Class::Read;
    for statement in scan.toks.split(|t| *t == Tok::Semi) {
        if let Some(class) = classify_one(statement, kind) {
            worst = worst.max(class);
        }
    }
    if scan.ambiguous && worst == Class::Read {
        worst = Class::Write;
    }
    worst
}

/// Whether a text is exactly one statement: nothing stands behind a semicolon. (Where a batch needs no
/// semicolon between statements – T-SQL – this cannot be told from the tokens alone.)
pub fn is_single_statement(sql: &str, kind: DbKind) -> bool {
    let scan = scan(sql, kind);
    !scan.ambiguous
        && scan
            .toks
            .split(|t| *t == Tok::Semi)
            .filter(|s| !s.is_empty())
            .count()
            == 1
}

/// Whether a text is one statement that creates a table, and nothing else: `CREATE [TEMP …] TABLE …`,
/// with no second statement behind a semicolon – or, where a batch needs none (T-SQL), behind the
/// column list.
pub fn is_create_table(sql: &str, kind: DbKind) -> bool {
    let scan = scan(sql, kind);
    if scan.ambiguous || classify(sql, kind) != Class::Ddl {
        return false;
    }
    let mut statements = scan
        .toks
        .split(|t| *t == Tok::Semi)
        .filter(|s| !s.is_empty());
    let (Some(statement), None) = (statements.next(), statements.next()) else {
        return false;
    };
    let mut words = statement.iter().map(word);
    if words.next() != Some(Some("CREATE")) {
        return false;
    }
    let named = loop {
        match words.next() {
            Some(Some("GLOBAL" | "LOCAL" | "TEMP" | "TEMPORARY" | "UNLOGGED")) => {}
            other => break other,
        }
    };
    if named != Some(Some("TABLE")) {
        return false;
    }
    // behind the column list only what belongs to the table follows
    let mut depth = 0usize;
    let mut closed = false;
    for tok in statement {
        match tok {
            Tok::Open => depth += 1,
            Tok::Close => {
                depth = depth.saturating_sub(1);
                closed |= depth == 0;
            }
            Tok::Word(w)
                if closed
                    && depth == 0
                    && matches!(
                        w.as_str(),
                        "INSERT"
                            | "UPDATE"
                            | "DELETE"
                            | "MERGE"
                            | "SELECT"
                            | "EXEC"
                            | "EXECUTE"
                            | "CREATE"
                            | "ALTER"
                            | "DROP"
                            | "TRUNCATE"
                            | "GRANT"
                            | "REVOKE"
                            | "DENY"
                            | "CALL"
                            | "SET"
                    ) =>
            {
                return false;
            }
            _ => {}
        }
    }
    true
}

/// Whether a text is nothing but transaction control (`BEGIN`, `COMMIT`, `ROLLBACK`, savepoints): such a
/// statement is sent as it is, also in manual mode.
pub fn is_transaction_control(sql: &str, kind: DbKind) -> bool {
    let scan = scan(sql, kind);
    let mut any = false;
    for statement in scan.toks.split(|t| *t == Tok::Semi) {
        let Some(first) = statement.iter().find_map(word) else {
            if statement.is_empty() {
                continue;
            }
            return false;
        };
        if !TRANSACTION_STARTS.contains(&first) && first != "SET" {
            return false;
        }
        any = true;
    }
    any
}

/// The statement that makes a session read only on the server, where the database has one.
pub fn read_only_statement(kind: DbKind) -> Option<&'static str> {
    match kind {
        DbKind::Postgres => Some("SET default_transaction_read_only = on"),
        DbKind::Mysql => Some("SET SESSION TRANSACTION READ ONLY"),
        DbKind::Sqlite => Some("PRAGMA query_only = ON"),
        // the server takes no such PRAGMA: the classification is all there is, and a reading call
        // runs in a transaction that is rolled back
        // D1 has no session at all; whether a token may write is decided at Cloudflare
        DbKind::Libsql | DbKind::D1 => None,
        // SQL Server has no read-only session; the classification is all there is
        DbKind::Sqlserver => None,
        // Oracle has it only for one transaction (and reads a stale snapshot inside it): the
        // classification is all there is, and a reading call runs in a transaction that is rolled back
        // DuckDB can be read only for a whole file, not for a session of an open one
        DbKind::Oracle | DbKind::Duckdb => None,
        // kept by the session of the server; once set it cannot be taken back there
        // (1, not 2: with 2 an INSERT INTO FUNCTION file(…) still writes)
        DbKind::Clickhouse => Some("SET readonly = 1"),
        // no statement that holds: the driver keeps the session inside a read-only transaction
        // (`Session::make_read_only`, see trino.rs)
        DbKind::Trino => None,
        // every transaction of the session is opened read only (`Session::make_read_only`)
        DbKind::Firebird => None,
        // every statement is a job of its own; what a login may write is decided at Google
        DbKind::Bigquery => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Class::{Dangerous, Ddl, Read, Write};

    const ALL: [DbKind; 12] = [
        DbKind::Postgres,
        DbKind::Mysql,
        DbKind::Sqlserver,
        DbKind::Sqlite,
        DbKind::Oracle,
        DbKind::Duckdb,
        DbKind::Clickhouse,
        DbKind::Trino,
        DbKind::Libsql,
        DbKind::D1,
        DbKind::Firebird,
        DbKind::Bigquery,
    ];

    /// libSQL (prompt 035g): classified as SQLite; read only is not a statement there.
    #[test]
    fn libsql_is_classified_like_sqlite() {
        for sql in [
            "SELECT 1",
            "PRAGMA table_info(t)",
            "PRAGMA journal_mode = WAL",
            "INSERT INTO t VALUES (1)",
            "DROP TABLE t",
            "ATTACH DATABASE 'x' AS x",
            "SELECT [a;b], `c` FROM t",
        ] {
            assert_eq!(
                classify(sql, DbKind::Libsql),
                classify(sql, DbKind::Sqlite),
                "{sql}"
            );
        }
        assert_eq!(read_only_statement(DbKind::Libsql), None);
    }

    /// BigQuery (prompt 035j).
    #[test]
    fn bigquery_reads_until_a_statement_reaches_out() {
        let k = DbKind::Bigquery;
        assert_eq!(
            classify("SELECT * FROM `p.d.t` WHERE a = 'it\\'s'", k),
            Read
        );
        assert_eq!(classify("INSERT INTO d.t VALUES (1)", k), Write);
        assert_eq!(classify("DROP TABLE d.t", k), Dangerous);
        assert_eq!(
            classify("SELECT * FROM EXTERNAL_QUERY('c', 'DELETE FROM t')", k),
            Write
        );
        assert_ne!(
            classify("EXPORT DATA OPTIONS (uri = 'gs://b/x') AS SELECT 1", k),
            Read
        );
        assert_ne!(classify("EXECUTE IMMEDIATE 'DROP TABLE d.t'", k), Read);
        assert_ne!(classify("CALL d.p()", k), Read);
        assert_eq!(read_only_statement(k), None);
    }

    /// Firebird (prompt 035i).
    #[test]
    fn firebird_blocks_and_procedures_are_no_reading() {
        let k = DbKind::Firebird;
        assert_eq!(classify("SELECT FIRST 5 * FROM t", k), Read);
        assert_eq!(classify("SELECT 'C:\\' FROM rdb$database", k), Read);
        assert_eq!(classify("UPDATE t SET a = 1 WHERE id = 1", k), Write);
        assert_ne!(
            classify("EXECUTE BLOCK AS BEGIN DELETE FROM t; END", k),
            Read
        );
        assert_ne!(classify("EXECUTE PROCEDURE wipe", k), Read);
        assert_eq!(classify("SELECT GEN_ID(g, 1) FROM rdb$database", k), Write);
        assert_ne!(
            classify("SELECT NEXT VALUE FOR g FROM rdb$database", k),
            Read
        );
        assert_eq!(classify("DROP TABLE t", k), Dangerous);
        assert_eq!(classify("RECREATE TABLE t (a INTEGER)", k), Dangerous);
        assert!(is_transaction_control("SET TRANSACTION", k));
        assert_eq!(read_only_statement(k), None);
    }

    /// Trino (prompt 035f).
    #[test]
    fn trino_reads_until_a_statement_reaches_through_a_catalog() {
        let k = DbKind::Trino;
        assert_eq!(classify("SELECT count(*) FROM tpch.tiny.orders", k), Read);
        assert_eq!(classify("SHOW CATALOGS", k), Read);
        assert_eq!(classify("EXPLAIN SELECT 1", k), Read);
        assert_eq!(classify("INSERT INTO t VALUES (1)", k), Write);
        assert_eq!(classify("CREATE TABLE t AS SELECT 1 AS a", k), Ddl);
        assert_eq!(classify("DROP TABLE t", k), Dangerous);
        // a text handed to the database behind a catalog: nobody reads here what it does there
        assert_eq!(
            classify(
                "SELECT * FROM TABLE(pg.system.query(query => 'DELETE FROM t RETURNING 1'))",
                k
            ),
            Write
        );
        assert_eq!(classify("SELECT * FROM TABLE (sequence(1, 3))", k), Write);
        assert_eq!(classify("SELECT \"table\" FROM t", k), Read);
        // a statement in a text, a procedure of the server: never plain reading
        assert_ne!(classify("EXECUTE IMMEDIATE 'DROP TABLE t'", k), Read);
        assert_ne!(
            classify(
                "CALL system.runtime.kill_query(query_id => 'x', message => 'y')",
                k
            ),
            Read
        );
        assert_eq!(read_only_statement(k), None);
        assert!(is_transaction_control("START TRANSACTION READ ONLY", k));
        // a backslash is a character there, as in Oracle: nothing ambiguous about it
        assert_eq!(classify("SELECT 'C:\\', 'a\\' FROM t", k), Read);
    }

    /// ClickHouse (prompt 035d).
    #[test]
    fn clickhouse_commands_for_the_server_ask_first() {
        let k = DbKind::Clickhouse;
        assert_eq!(classify("SYSTEM SHUTDOWN", k), Dangerous);
        assert_eq!(classify("KILL QUERY WHERE user = 'x'", k), Dangerous);
        assert_eq!(classify("SELECT count() FROM t", k), Read);
        assert_eq!(
            classify("INSERT INTO FUNCTION file('x.csv') SELECT 1", k),
            Write
        );
        assert_eq!(classify("ALTER TABLE t DELETE WHERE id = 1", k), Ddl);
        assert_eq!(classify("OPTIMIZE TABLE t FINAL", k), Ddl);
        assert_eq!(classify("TRUNCATE TABLE t", k), Dangerous);
        assert_eq!(read_only_statement(k), Some("SET readonly = 1"));
        // review 035d 2: a backslash escapes inside backticks there – what follows is seen
        assert_eq!(
            classify(
                "SELECT 1 AS `a\\` , 2 AS ` ; DROP TABLE t ; SELECT ` , 3 AS `b`",
                k
            ),
            Dangerous
        );
        // review 035d 7: table functions that leave the database are no plain reading
        assert_eq!(classify("SELECT * FROM url('http://x/y', 'CSV')", k), Write);
        assert_eq!(classify("SELECT * FROM remote('other', db.t)", k), Write);
        assert_eq!(classify("SELECT * FROM file('x.csv')", k), Write);
        assert_eq!(classify("SELECT file, url FROM t", k), Read);
    }

    /// DuckDB (prompt 035c): extensions are code from the net, files are written by statements.
    #[test]
    fn duckdb_extensions_ask_first_and_files_count_as_writing() {
        let k = DbKind::Duckdb;
        assert_eq!(classify("INSTALL httpfs", k), Dangerous);
        assert_eq!(classify("LOAD 'x.duckdb_extension'", k), Dangerous);
        assert_eq!(classify("FORCE INSTALL spatial", k), Dangerous);
        assert_eq!(classify("UPDATE EXTENSIONS", k), Dangerous);
        assert_eq!(classify("UPDATE t SET a = 1 WHERE id = 2", k), Write);
        assert_eq!(classify("COPY t TO 'out.parquet'", k), Write);
        assert_eq!(classify("ATTACH 'other.duckdb'", k), Ddl);
        assert_eq!(classify("SELECT * FROM read_parquet('a.parquet')", k), Read);
        assert_eq!(classify("FROM t SELECT a", k), Write);
        assert_eq!(read_only_statement(k), None);
        // review 035c 1: dollar quotes and nested comments are DuckDB's too – what hides in them is seen
        assert_eq!(
            classify("SELECT $$'$$; DROP TABLE t; SELECT $$'$$", k),
            Dangerous
        );
        assert_eq!(
            classify("SELECT 1 /* /* */ ' */ ; DROP TABLE t; --'", k),
            Dangerous
        );
        assert_eq!(classify("SELECT $tag$ ; DELETE FROM t $tag$", k), Read);
        // review 035c 4: the switches for extensions, and functions that write
        assert_eq!(
            classify("SET autoinstall_known_extensions = true", k),
            Dangerous
        );
        assert_eq!(
            classify("SET GLOBAL autoload_known_extensions=true", k),
            Dangerous
        );
        assert_eq!(classify("RESET custom_extension_repository", k), Dangerous);
        assert_eq!(classify("SET threads = 4", k), Write);
        assert_eq!(
            classify("SELECT * FROM enable_logging(storage='file')", k),
            Write
        );
    }

    /// Oracle (prompt 035b): a q-quote holds quotes as they are, a backslash escapes nothing, and a
    /// PL/SQL block is judged by what it holds.
    #[test]
    fn oracle_strings_blocks_and_what_only_reads() {
        let k = DbKind::Oracle;
        assert_eq!(
            classify("SELECT q'[it's; DROP TABLE t]' FROM dual", k),
            Read
        );
        assert_eq!(classify("SELECT nq'{a'b}' FROM dual", k), Read);
        // what follows the q-quote is code again
        assert_eq!(
            classify("BEGIN x := q'[']'; DELETE FROM t; END;", k),
            Dangerous
        );
        assert_eq!(
            classify("SELECT q'!x!' FROM dual; DROP TABLE t", k),
            Dangerous
        );
        // no backslash escape: the string ends at its quote, the rest is code
        assert_eq!(classify("SELECT 'a\\' FROM dual", k), Read);
        assert_eq!(
            classify("SELECT 'a\\'; DROP TABLE t; --' FROM dual", k),
            Dangerous
        );
        assert_eq!(classify("BEGIN NULL; END;", k), Write);
        assert_eq!(classify("DECLARE n NUMBER; BEGIN n := 1; END;", k), Write);
        assert_eq!(
            classify("BEGIN EXECUTE IMMEDIATE 'DROP TABLE t'; END;", k),
            Dangerous
        );
        assert_eq!(classify("CALL p(1)", k), Write);
        // a sequence moves on: no reading
        assert_eq!(classify("SELECT seq.NEXTVAL FROM dual", k), Write);
        assert_eq!(classify("SELECT * FROM t FOR UPDATE", k), Write);
        assert_eq!(
            classify(
                "MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET t.a = 1",
                k
            ),
            Write
        );
        assert_eq!(classify("TRUNCATE TABLE t", k), Dangerous);
        // a session setting is no reading: the app sends this one itself
        assert_eq!(classify("SET TRANSACTION READ ONLY", k), Write);
        assert_eq!(read_only_statement(k), None);
    }

    /// Statements every dialect is asked about.
    const COMMON: &[(&str, Class)] = &[
        ("", Read),
        ("   -- only a comment", Read),
        ("SELECT 1", Read),
        (
            "select * from kunde where name = 'DROP TABLE x; DELETE FROM y'",
            Read,
        ),
        ("SELECT \"update\", \"delete\" FROM t", Read),
        ("(SELECT 1) UNION (SELECT 2)", Read),
        ("WITH a AS (SELECT 1) SELECT * FROM a", Read),
        ("VALUES (1), (2)", Read),
        ("EXPLAIN SELECT * FROM t", Read),
        ("BEGIN", Read),
        ("COMMIT", Read),
        ("ROLLBACK", Read),
        ("/* a */ SELECT /* b */ 1 -- c", Read),
        ("INSERT INTO t VALUES (1)", Write),
        ("insert into t select * from u", Write),
        ("UPDATE t SET a = 1 WHERE id = 2", Write),
        ("DELETE FROM t WHERE id = 2", Write),
        ("  \n\t delete from t where id=1", Write),
        ("-- harmless\nDELETE FROM t WHERE id = 1", Write),
        ("/* SELECT */ UPDATE t SET a = 1 WHERE b = 2", Write),
        ("SELECT 1; INSERT INTO t VALUES (1)", Write),
        ("SELECT 1;DELETE FROM t WHERE a=1;SELECT 2", Write),
        (
            "WITH d AS (DELETE FROM t WHERE id = 1 RETURNING *) SELECT * FROM d",
            Write,
        ),
        (
            "WITH i AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM i",
            Write,
        ),
        ("SELECT * INTO backup FROM t", Write),
        ("EXPLAIN ANALYZE DELETE FROM t WHERE id = 1", Write),
        ("EXPLAIN ANALYZE SELECT * FROM t", Read),
        ("CALL cleanup()", Write),
        (
            "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = s.a",
            Write,
        ),
        ("blubb", Write),
        ("42", Write),
        ("SELECT nextval('seq')", Write),
        ("SELECT * FROM t FOR UPDATE", Write),
        ("CREATE TABLE t (a int)", Ddl),
        ("create index i on t (a)", Ddl),
        ("ALTER TABLE t ADD COLUMN b int", Ddl),
        (
            "CREATE TABLE t (a int REFERENCES u ON DELETE CASCADE ON UPDATE CASCADE)",
            Ddl,
        ),
        ("CREATE VIEW v AS SELECT * FROM t", Ddl),
        ("DELETE FROM t", Dangerous),
        ("delete from t -- where id = 1", Dangerous),
        ("DELETE FROM t /* WHERE id = 1 */", Dangerous),
        ("UPDATE t SET a = 1", Dangerous),
        ("UPDATE t SET note = 'where is it'", Dangerous),
        (
            "UPDATE t SET a = (SELECT max(a) FROM u WHERE u.id = 1)",
            Dangerous,
        ),
        ("DELETE FROM t WHERE id IN (SELECT id FROM u)", Write),
        (
            "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d WHERE id = 1",
            Dangerous,
        ),
        ("SELECT 1; DELETE FROM t", Dangerous),
        ("TRUNCATE TABLE t", Dangerous),
        ("DROP TABLE t", Dangerous),
        ("drop   view v", Dangerous),
        ("ALTER TABLE t DROP COLUMN a", Dangerous),
        ("GRANT ALL ON t TO PUBLIC", Dangerous),
        ("ALTER ROLE bob SUPERUSER", Dangerous),
        ("CREATE USER 'a'@'%' IDENTIFIED BY '***'", Dangerous),
        ("ALTER LOGIN [a] WITH PASSWORD = '***'", Dangerous),
        ("alter role [db_owner] add member [bob]", Dangerous),
        ("CREATE ROLE readers", Dangerous),
        ("REVOKE ALL ON t FROM PUBLIC", Dangerous),
        ("SELECT 1; DROP TABLE t", Dangerous),
        ("EXPLAIN ANALYZE DELETE FROM t", Dangerous),
        (
            "INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET b = 2",
            Write,
        ),
        ("INSERT INTO log SELECT * FROM t; DROP TABLE t", Dangerous),
    ];

    #[test]
    fn classifies_the_common_catalog_in_every_dialect() {
        for kind in ALL {
            for (sql, class) in COMMON {
                // SQL Server has no EXPLAIN: there the words behind it are a second statement
                if kind == DbKind::Sqlserver && sql.starts_with("EXPLAIN ANALYZE SELECT") {
                    continue;
                }
                assert_eq!(classify(sql, kind), *class, "{kind:?}: {sql}");
            }
        }
    }

    #[test]
    fn postgres_tricks() {
        let k = DbKind::Postgres;
        for (sql, class) in [
            ("SELECT $$ DROP TABLE t; $$", Read),
            ("SELECT $x$ ' ; DELETE FROM t $x$ AS a", Read),
            ("SELECT 'a''b; DROP TABLE t' AS s", Read),
            ("SELECT E'it\\'s; DROP TABLE t' AS s", Write),
            ("SELECT 'a\\'; DROP TABLE t; --'", Write),
            ("/* outer /* inner */ still a comment */ SELECT 1", Read),
            ("/* a /* b */ c */ DROP TABLE t", Dangerous),
            ("DO $$ BEGIN DELETE FROM t; END $$", Write),
            ("COPY t FROM '/tmp/x'", Write),
            ("COPY (SELECT * FROM t) TO '/tmp/x'", Write),
            ("SELECT pg_terminate_backend(42)", Write),
            ("SELECT lo_unlink(1)", Write),
            (
                "SELECT set_config('default_transaction_read_only', 'off', false)",
                Write,
            ),
            ("SET default_transaction_read_only = off", Write),
            ("RESET ALL", Write),
            ("TABLE t", Read),
            ("SHOW search_path", Read),
            ("REFRESH MATERIALIZED VIEW v", Ddl),
            ("VACUUM FULL t", Ddl),
            ("SELECT * FROM t FOR NO KEY UPDATE", Write),
            ("CREATE TABLE a AS SELECT * FROM t", Ddl),
            ("SELECT 1 \\; DROP TABLE t", Dangerous),
        ] {
            assert_eq!(classify(sql, k), class, "{sql}");
        }
    }

    #[test]
    fn mysql_tricks() {
        let k = DbKind::Mysql;
        for (sql, class) in [
            ("SELECT `delete`, `drop` FROM t", Read),
            ("SELECT 1 # DROP TABLE t", Read),
            ("SELECT 'a\\'; DROP TABLE t; -- ' AS s", Write),
            ("SELECT 1 /*! ; DROP TABLE t */", Dangerous),
            ("/*!50000 DROP TABLE t */", Dangerous),
            ("SELECT * FROM t INTO OUTFILE '/tmp/x'", Write),
            ("REPLACE INTO t VALUES (1)", Write),
            ("SELECT REPLACE(name, 'a', 'b') FROM t", Write),
            ("LOAD DATA INFILE 'x' INTO TABLE t", Write),
            (
                "INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 2",
                Write,
            ),
            ("USE shop", Read),
            ("SHOW TABLES", Read),
            ("DESCRIBE t", Read),
            ("SET GLOBAL read_only = 0", Write),
            ("SELECT SLEEP(100)", Write),
            ("HANDLER t OPEN", Write),
            ("RENAME TABLE a TO b", Ddl),
            ("OPTIMIZE TABLE t", Ddl),
            ("KILL 42", Write),
        ] {
            assert_eq!(classify(sql, k), class, "{sql}");
        }
    }

    #[test]
    fn sql_server_tricks() {
        let k = DbKind::Sqlserver;
        for (sql, class) in [
            ("SELECT [delete], [drop]]x] FROM t", Read),
            ("SELECT 1 DROP TABLE t", Dangerous),
            ("SELECT 1 DELETE FROM t", Dangerous),
            ("SELECT 1 EXEC sp_who", Write),
            ("EXEC sp_executesql N'DROP TABLE t'", Dangerous),
            ("EXEC('DROP TABLE t')", Dangerous),
            ("SELECT * INTO #tmp FROM t", Write),
            ("USE master", Read),
            ("USE master DROP DATABASE shop", Dangerous),
            ("DENY SELECT ON t TO x", Dangerous),
            ("BACKUP DATABASE shop TO DISK = 'x'", Write),
            ("SELECT * FROM OPENROWSET('x', 'y', 'DROP TABLE t')", Write),
            ("xp_cmdshell 'del x'", Write),
            ("BEGIN TRANSACTION", Read),
        ] {
            assert_eq!(classify(sql, k), class, "{sql}");
        }
    }

    #[test]
    fn sqlite_tricks() {
        let k = DbKind::Sqlite;
        for (sql, class) in [
            ("PRAGMA table_info(orders)", Read),
            ("PRAGMA main.table_info('orders')", Read),
            ("PRAGMA database_list", Read),
            ("PRAGMA query_only = OFF", Write),
            ("PRAGMA query_only(0)", Write),
            ("PRAGMA query_only(table_info)", Write),
            ("PRAGMA main.query_only = table_info", Write),
            ("PRAGMA table_info(t) = 1", Write),
            ("PRAGMA table_info(a, b)", Write),
            ("PRAGMA", Write),
            ("PRAGMA journal_mode = DELETE", Write),
            ("PRAGMA writable_schema = 1", Write),
            ("PRAGMA optimize", Ddl),
            ("ATTACH DATABASE 'x.db' AS x", Ddl),
            ("SELECT load_extension('evil')", Write),
            ("VACUUM", Ddl),
            ("REPLACE INTO t VALUES (1)", Write),
            ("SELECT * FROM pragma_table_info('orders')", Read),
        ] {
            assert_eq!(classify(sql, k), class, "{sql}");
        }
    }

    #[test]
    fn a_text_that_never_closes_its_string_or_comment_is_no_read() {
        for kind in ALL {
            assert_eq!(classify("DELETE FROM t /* where", kind), Dangerous);
            assert_eq!(classify("DROP TABLE t; SELECT '", kind), Dangerous);
            // the string swallows the rest: what stands before it decides
            assert_eq!(classify("SELECT 'x; DROP TABLE t", kind), Read);
        }
    }

    /// What a second reviewer got past the first version (design 012): each of these was `Read`.
    #[test]
    fn the_bypasses_of_the_review_are_closed() {
        use DbKind::{Mysql, Postgres, Sqlite, Sqlserver};
        let cases: &[(DbKind, &str)] = &[
            (Sqlserver, r"SELECT 1 WHERE 'a' LIKE'\' DROP TABLE t --'"),
            (
                Sqlserver,
                r"SELECT 1 WHERE 'a' LIKE'\'; EXEC xp_cmdshell 'x' --'",
            ),
            (
                Postgres,
                r"SELECT 'x' LIKE'\'; COMMIT; SET default_transaction_read_only = off; DELETE FROM t; --'",
            ),
            (Postgres, r"SELECT E'''\''; DROP TABLE t; --'"),
            (Sqlserver, "SELECT 1 /* /* */ ' */ DROP TABLE t --'"),
            (
                Mysql,
                "SELECT 1--1; SET SESSION TRANSACTION READ WRITE; DELETE FROM t",
            ),
            (
                Mysql,
                "SELECT 1 x#'\n; SET SESSION TRANSACTION READ WRITE; DELETE FROM t; -- '",
            ),
            (Mysql, "/*M!100100 DROP TABLE t */"),
            (Mysql, "SELECT 1 /*M!; DROP TABLE t */"),
            (
                Postgres,
                r#"SELECT "set_config"('default_transaction_read_only','off',false)"#,
            ),
            (
                Postgres,
                r#"SELECT U&"set\005fconfig"('default_transaction_read_only','off',false)"#,
            ),
            (Postgres, r#"SELECT pg_catalog."lo_unlink"(1)"#),
            (Postgres, "BEGIN READ WRITE"),
            (Postgres, "START TRANSACTION READ WRITE"),
            (Mysql, "START TRANSACTION READ WRITE"),
            (Postgres, "COMMIT PREPARED 'tx1'"),
            (Postgres, "ROLLBACK PREPARED 'tx1'"),
            (Mysql, "START REPLICA"),
            (Mysql, "START SLAVE"),
            (Mysql, "START GROUP_REPLICATION"),
            (Sqlite, "PRAGMA query_only = integrity_check"),
            (Sqlite, "PRAGMA query_only = quick_check"),
            (Sqlite, "PRAGMA foreign_keys = table_info"),
            (Sqlite, "PRAGMA user_version = table_list"),
            (Sqlite, "PRAGMA query_only - table_info"),
            (Postgres, "SELECT 1 -- x\rDROP TABLE t"),
            (Sqlserver, "SELECT 1 -- x\rDROP TABLE t"),
            (Sqlserver, "SELECT NEXT VALUE FOR dbo.seq"),
            (Mysql, "SELECT NEXT VALUE FOR seq"),
            (Sqlserver, "SELECT 1 WAITFOR DELAY '01:00:00'"),
            (Sqlserver, "SELECT 1 RECEIVE TOP(1) * FROM q"),
            (Sqlserver, "SELECT 1 SEND ON CONVERSATION @h MESSAGE TYPE x"),
            (Sqlserver, "END CONVERSATION @h WITH CLEANUP"),
            (
                Sqlserver,
                "BEGIN DIALOG CONVERSATION @h FROM SERVICE a TO SERVICE 'b'",
            ),
            (Sqlserver, "SELECT 1 DISABLE TRIGGER ALL ON DATABASE"),
            (Sqlserver, "SELECT 1 ENABLE TRIGGER ALL ON DATABASE"),
            (Sqlserver, "SELECT 1 REVERT"),
            (Sqlserver, "SELECT 1 RECONFIGURE"),
            (Sqlserver, "SELECT 1 SETUSER 'x'"),
            (Sqlserver, "SELECT 1 ADD SIGNATURE TO p BY CERTIFICATE c"),
            (
                Sqlserver,
                "SELECT 1 OPEN SYMMETRIC KEY k DECRYPTION BY PASSWORD = 'x'",
            ),
            (Sqlserver, "SELECT 1 RAISERROR('x',20,1) WITH LOG"),
            (Sqlserver, "SELECT 1 SAVE TRANSACTION x"),
            (Sqlserver, "BEGIN DISTRIBUTED TRANSACTION"),
            (Sqlserver, "SELECT * FROM OPENDATASOURCE('x','y').a.b.c"),
            (Sqlserver, "SELECT 1 EXEC@sql"),
            (Sqlserver, "SELECT * INTO#t FROM x"),
            (Postgres, "SELECT pg_promote()"),
            (Postgres, "SELECT pg_backup_start('x')"),
            (Postgres, "SELECT pg_stat_reset_shared('bgwriter')"),
            (Postgres, "SELECT pg_stat_statements_reset()"),
            (Postgres, "SELECT pg_advisory_lock_shared(1)"),
            (Postgres, "SELECT pg_advisory_unlock_all()"),
            (Postgres, "SELECT pg_sleep_for('1 hour')"),
            (Postgres, "SELECT pg_create_physical_replication_slot('s')"),
            (
                Postgres,
                "SELECT * FROM pg_logical_slot_get_changes('s', NULL, NULL)",
            ),
            (Postgres, "SELECT pg_file_write('x', 'y', false)"),
            (Postgres, "SELECT dblink_send_query('c', 'DELETE FROM t')"),
            (
                Postgres,
                "SELECT * FROM crosstab('DELETE FROM t RETURNING 1,2,3') AS x(a int)",
            ),
            (Postgres, "SELECT lo_truncate(1,0)"),
            (Postgres, "SELECT pg_current_xact_id()"),
            (Postgres, "SELECT * FROM t FOR SHARE"),
            (Mysql, "SELECT * FROM t FOR SHARE"),
            (Mysql, "SELECT sys_exec('rm x')"),
            (Mysql, "SELECT MASTER_POS_WAIT('f', 4)"),
            (Mysql, "SELECT * FROM t FOR UPDATE#\n"),
            (Postgres, r"SELECT 'a\' || '; DROP TABLE t; --'"),
            (Mysql, r#"SELECT 1 AS "a\"; DROP TABLE t; -- ""#),
            (Mysql, "SELECT 1 FROM t INTO@a"),
            (Sqlite, "SELECT [a'] FROM t; DROP TABLE t; --'"),
            (
                Sqlite,
                r"SELECT 1 WHERE 'a' LIKE'\'; PRAGMA query_only = 0; DELETE FROM t; --'",
            ),
            (Sqlite, "BEGIN EXCLUSIVE"),
            (Sqlite, "BEGIN IMMEDIATE"),
            (Sqlite, "SELECT zipfile('a','b')"),
        ];
        for (kind, sql) in cases {
            assert_ne!(classify(sql, *kind), Read, "{kind:?}: {sql}");
        }
    }

    #[test]
    fn text_that_is_run_counts_and_a_column_named_current_is_no_where() {
        assert_eq!(
            classify("DO $$BEGIN DROP TABLE t; END$$", DbKind::Postgres),
            Dangerous
        );
        assert_eq!(
            classify("EXEC('DROP TABLE t')", DbKind::Sqlserver),
            Dangerous
        );
        assert_eq!(
            classify("EXEC sp_executesql N'DROP TABLE t'", DbKind::Sqlserver),
            Dangerous
        );
        assert_eq!(
            classify("PREPARE s FROM 'DROP TABLE t'", DbKind::Mysql),
            Dangerous
        );
        assert_eq!(
            classify("DO $$BEGIN PERFORM 1; END$$", DbKind::Postgres),
            Write
        );
        for kind in ALL {
            assert_eq!(classify("UPDATE t SET current = 0", kind), Dangerous);
            assert_eq!(classify("DELETE FROM t WHERE CURRENT OF c", kind), Write);
        }
    }

    #[test]
    fn everyday_reading_stays_reading() {
        use DbKind::{Mysql, Postgres, Sqlite, Sqlserver};
        let cases: &[(DbKind, &str)] = &[
            (
                Postgres,
                "SELECT a, count(*) FROM t WHERE name LIKE 'x%' GROUP BY a ORDER BY 2 DESC LIMIT 10",
            ),
            (
                Postgres,
                "SELECT pg_size_pretty(pg_total_relation_size('t')), pg_typeof(a), pg_get_viewdef('v') FROM t",
            ),
            (
                Postgres,
                r#"SELECT "select", "Größe 1" FROM "My Table" t JOIN u USING (id)"#,
            ),
            (
                Postgres,
                "SELECT 'it''s', $$ dollar $$, now(), coalesce(a, 0) FROM t",
            ),
            (
                Postgres,
                "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
            ),
            (Postgres, "SAVEPOINT sp1"),
            (Postgres, "ROLLBACK TO SAVEPOINT sp1"),
            (Postgres, r#"RELEASE SAVEPOINT "sp 1""#),
            (Postgres, "COMMIT AND NO CHAIN"),
            (
                Mysql,
                "SELECT `select`, CONCAT(a, '-', b), IFNULL(c, 0) FROM `my table` WHERE a - -1 = 2",
            ),
            (Mysql, "SELECT 5--3 AS eight"),
            (Mysql, "START TRANSACTION WITH CONSISTENT SNAPSHOT"),
            (Mysql, "SHOW CREATE TABLE t"),
            (
                Sqlserver,
                "SELECT TOP 10 [select], LEN(name) FROM [dbo].[my table] ORDER BY 1 OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY",
            ),
            (Sqlserver, "SELECT * FROM #tmp WHERE id = @id"),
            (Sqlserver, "BEGIN TRAN"),
            (
                Sqlite,
                "SELECT [select], length(name), substr(name, 1, 2) FROM [my table]",
            ),
            (
                Sqlite,
                "SELECT * FROM pragma_table_info('orders') WHERE schema = 'main'",
            ),
            (Sqlite, "BEGIN"),
            (Sqlite, "END"),
        ];
        for (kind, sql) in cases {
            assert_eq!(classify(sql, *kind), Read, "{kind:?}: {sql}");
        }
    }

    #[test]
    fn the_rule_per_protection() {
        use Need::*;
        use Protection::*;
        let table = [
            (Free, Read, Nothing),
            (Free, Write, Nothing),
            (Free, Ddl, Nothing),
            (Free, Dangerous, Confirm),
            (Ask, Read, Nothing),
            (Ask, Write, Confirm),
            (Ask, Ddl, Confirm),
            (Ask, Dangerous, TypeName),
            (Readonly, Read, Nothing),
            (Readonly, Write, Refused),
            (Readonly, Ddl, Refused),
            (Readonly, Dangerous, Refused),
        ];
        for (protection, class, expected) in table {
            assert_eq!(
                need(protection, class, false),
                expected,
                "{protection:?} {class:?}"
            );
        }
        // the setting loosens free connections only
        assert_eq!(need(Free, Dangerous, true), Nothing);
        assert_eq!(need(Ask, Dangerous, true), TypeName);
        assert_eq!(need(Readonly, Dangerous, true), Refused);
    }

    #[test]
    fn refusals_have_codes_the_frontend_can_act_on() {
        assert_eq!(
            refusal(Need::Refused, Write).code,
            ErrorCode::PermissionDenied
        );
        assert_eq!(
            refusal(Need::Confirm, Write).code,
            ErrorCode::ConfirmationRequired
        );
        assert_eq!(
            refusal(Need::TypeName, Dangerous).code,
            ErrorCode::ConfirmationRequired
        );
    }

    #[test]
    fn protection_reads_and_writes_as_lower_case_and_defaults_to_free() {
        assert_eq!(
            serde_json::to_string(&Protection::Readonly).unwrap(),
            "\"readonly\""
        );
        assert_eq!(Protection::default(), Protection::Free);
        assert_eq!(
            serde_json::to_string(&Class::Dangerous).unwrap(),
            "\"dangerous\""
        );
        assert_eq!(
            serde_json::to_string(&Need::TypeName).unwrap(),
            "\"type_name\""
        );
    }
    /// Review 033: where only a table is to be created, only that runs.
    #[test]
    fn tells_a_single_create_table_from_everything_else() {
        use DbKind::*;
        for (kind, sql) in [
            (
                Postgres,
                "CREATE TABLE shop.t (\n  id bigint,\n  \"a; b\" text\n)",
            ),
            (Postgres, "create unlogged table t (a int);"),
            (Sqlite, "CREATE TEMP TABLE IF NOT EXISTS t (a text) -- note"),
            (Mysql, "CREATE TABLE `t` (a varchar(20)) ENGINE=InnoDB;\n"),
            (Sqlserver, "CREATE TABLE [dbo].[t] (a nvarchar(max))"),
        ] {
            assert!(is_create_table(sql, kind), "{sql}");
        }
        for (kind, sql) in [
            (
                Postgres,
                "CREATE TABLE t (a int); INSERT INTO other VALUES (1)",
            ),
            (Postgres, "CREATE TABLE t (a int); CREATE TABLE u (a int)"),
            (Postgres, "ALTER TABLE t ADD b int"),
            (Postgres, "CREATE INDEX i ON t (a)"),
            (
                Postgres,
                "CREATE OR REPLACE FUNCTION f() RETURNS int AS 'select 1' LANGUAGE sql",
            ),
            (Postgres, "DROP TABLE t"),
            (Postgres, "SELECT 1"),
            (Postgres, ""),
            (Sqlserver, "CREATE TABLE t (a int) DROP TABLE u"),
        ] {
            assert!(!is_create_table(sql, kind), "{sql}");
        }
    }
}
