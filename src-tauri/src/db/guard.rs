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

/// A word (upper case), or a sign that matters.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Tok {
    Word(String),
    Open,
    Close,
    Semi,
    /// Anything else that is neither space nor comment: operators, numbers, strings, quoted names.
    Other,
}

/// The tokens of a text: comments are dropped, strings and quoted names are one [`Tok::Other`] each. A
/// string or comment that never ends runs to the end of the text.
fn tokens(sql: &str, kind: DbKind) -> Vec<Tok> {
    let chars: Vec<char> = sql.chars().collect();
    let n = chars.len();
    let mut out = Vec::new();
    let mut i = 0;
    let backslash = kind == DbKind::Mysql;
    while i < n {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c.is_whitespace() {
            i += 1;
        } else if (c == '-' && next == Some('-')) || (c == '#' && kind == DbKind::Mysql) {
            while i < n && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            // MySQL runs the text of /*! … */ and /*+ … */ is only a hint: both are scanned as code or
            // dropped. A versioned comment is code: it is not skipped.
            if kind == DbKind::Mysql && chars.get(i + 2) == Some(&'!') {
                i += 3;
                while i < n && chars[i].is_ascii_digit() {
                    i += 1;
                }
                continue;
            }
            let mut depth = 1;
            i += 2;
            while i < n && depth > 0 {
                if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                } else if chars[i] == '/'
                    && chars.get(i + 1) == Some(&'*')
                    && kind == DbKind::Postgres
                {
                    // PostgreSQL nests block comments
                    depth += 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
        } else if c == '*' && next == Some('/') && kind == DbKind::Mysql {
            // the end of a versioned comment
            i += 2;
        } else if c == '\'' || c == '"' || c == '`' {
            // a string or a quoted name: to its closing quote, a doubled quote stays inside
            let quote = c;
            i += 1;
            while i < n {
                if chars[i] == '\\'
                    && (backslash || is_escape_string(&chars, i, quote))
                    && quote != '`'
                {
                    i += 2;
                } else if chars[i] == quote {
                    if chars.get(i + 1) == Some(&quote) {
                        i += 2;
                    } else {
                        i += 1;
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            out.push(Tok::Other);
        } else if c == '[' && kind == DbKind::Sqlserver {
            i += 1;
            while i < n {
                if chars[i] == ']' {
                    if chars.get(i + 1) == Some(&']') {
                        i += 2;
                    } else {
                        i += 1;
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            out.push(Tok::Other);
        } else if c == '$' && kind == DbKind::Postgres && dollar_tag(&chars, i).is_some() {
            // $tag$ … $tag$
            let tag = dollar_tag(&chars, i).unwrap_or_default();
            let body = i + tag.len();
            let end = find(&chars, body, &tag)
                .map(|at| at + tag.len())
                .unwrap_or(n);
            i = end;
            out.push(Tok::Other);
        } else if c == '(' {
            out.push(Tok::Open);
            i += 1;
        } else if c == ')' {
            out.push(Tok::Close);
            i += 1;
        } else if c == ';' {
            out.push(Tok::Semi);
            i += 1;
        } else if c.is_alphabetic() || c == '_' {
            let start = i;
            while i < n && (chars[i].is_alphanumeric() || matches!(chars[i], '_' | '$' | '#' | '@'))
            {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            out.push(Tok::Word(word.to_uppercase()));
        } else {
            out.push(Tok::Other);
            i += 1;
        }
    }
    out
}

/// PostgreSQL: a backslash escapes only inside `E'…'`. Looking back from the backslash is not possible
/// cheaply, so the scanner asks whether the string was opened behind an `E`.
fn is_escape_string(chars: &[char], at: usize, quote: char) -> bool {
    if quote != '\'' {
        return false;
    }
    // back to the opening quote of this string
    let mut i = at;
    while i > 0 {
        i -= 1;
        if chars[i] == '\'' {
            return i > 0 && matches!(chars[i - 1], 'e' | 'E');
        }
    }
    false
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

/// Words that only read or steer the session when they start a statement.
const READ_STARTS: &[&str] = &[
    "SELECT",
    "WITH",
    "VALUES",
    "TABLE",
    "SHOW",
    "DESCRIBE",
    "DESC",
    "EXPLAIN",
    "BEGIN",
    "START",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT",
    "RELEASE",
    "END",
    "USE",
    "PRAGMA",
    "HELP",
];

/// Words that make a statement a write wherever they stand in it (outside strings and names).
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
    "NEXTVAL",
    "SETVAL",
    "HANDLER",
    "IMPORT",
    "UNLOAD",
    "OUTFILE",
    "DUMPFILE",
    "OPENROWSET",
    "OPENQUERY",
    "PERFORM",
    "LISTEN",
    "NOTIFY",
    "UNLISTEN",
    "DISCARD",
    "RESET",
    "CHECKPOINT",
    "PREPARE",
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
];

/// Functions that change something although they are called from a `SELECT`.
const WRITING_FUNCTIONS: &[&str] = &[
    "NEXTVAL",
    "SETVAL",
    "SET_CONFIG",
    "PG_TERMINATE_BACKEND",
    "PG_CANCEL_BACKEND",
    "PG_RELOAD_CONF",
    "PG_ROTATE_LOGFILE",
    "PG_SWITCH_WAL",
    "PG_CREATE_RESTORE_POINT",
    "PG_ADVISORY_LOCK",
    "PG_ADVISORY_XACT_LOCK",
    "PG_TRY_ADVISORY_LOCK",
    "PG_NOTIFY",
    "LO_IMPORT",
    "LO_EXPORT",
    "LO_UNLINK",
    "LO_CREATE",
    "LO_CREAT",
    "LOWRITE",
    "LO_PUT",
    "LO_FROM_BYTEA",
    "DBLINK",
    "DBLINK_EXEC",
    "DBLINK_CONNECT",
    "PG_READ_FILE",
    "PG_READ_BINARY_FILE",
    "PG_LS_DIR",
    "PG_SLEEP",
    "QUERY_TO_XML",
    "TXID_CURRENT",
    "PG_LOGICAL_EMIT_MESSAGE",
    "PG_REPLICATION_SLOT_ADVANCE",
    "PG_CREATE_LOGICAL_REPLICATION_SLOT",
    "PG_DROP_REPLICATION_SLOT",
    "PG_STAT_RESET",
    "GET_LOCK",
    "RELEASE_LOCK",
    "RELEASE_ALL_LOCKS",
    "LOAD_FILE",
    "SLEEP",
    "BENCHMARK",
    "LAST_INSERT_ID",
    "LOAD_EXTENSION",
    "WRITEFILE",
    "READFILE",
    "EDIT",
    "FTS3_TOKENIZER",
    "XP_CMDSHELL",
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

fn word(t: &Tok) -> Option<&str> {
    match t {
        Tok::Word(w) => Some(w.as_str()),
        _ => None,
    }
}

/// One statement (no `;` in it).
fn classify_one(toks: &[Tok], kind: DbKind) -> Option<Class> {
    // what it starts with, behind opening parentheses
    let first = toks.iter().find_map(|t| match t {
        Tok::Open => None,
        other => Some(other),
    })?;
    let Some(start) = word(first) else {
        return Some(Class::Write);
    };
    let words: Vec<&str> = toks.iter().filter_map(word).collect();
    let has = |list: &[&str]| words.iter().any(|w| list.contains(w));

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
        if has(DANGEROUS_WORDS) {
            class = Class::Dangerous;
        } else if has(WRITE_WORDS) || has(WRITING_FUNCTIONS) {
            class = Class::Write;
        } else if has(DDL_WORDS) {
            // `EXPLAIN ANALYZE` runs the statement; a plain one that only reads stays reading
            let only_analyze = start == "EXPLAIN"
                && words
                    .iter()
                    .all(|w| !DDL_WORDS.contains(w) || matches!(*w, "ANALYZE" | "ANALYSE"));
            if !only_analyze {
                class = Class::Ddl;
            }
        }
        if start == "PRAGMA" && class == Class::Read && !read_pragma(toks) {
            class = Class::Write;
        }
        if start == "USE" && kind != DbKind::Mysql && kind != DbKind::Sqlserver {
            class = Class::Write;
        }
    }

    if start == "PRAGMA" {
        // its value may be any word (`journal_mode = DELETE`): no statement hides in it
        return Some(class);
    }
    if class == Class::Ddl && has(DANGEROUS_WORDS) {
        // ALTER … DROP …
        class = Class::Dangerous;
    }
    if class == Class::Write && has(DANGEROUS_WORDS) {
        class = Class::Dangerous;
    }
    if class < Class::Dangerous && unbounded_change(toks) {
        class = Class::Dangerous;
    }
    Some(class)
}

/// `PRAGMA [schema.]name` or `PRAGMA [schema.]name(argument)` of a pragma that only tells something.
/// Anything else – another name, an assignment – changes the database or the session.
fn read_pragma(toks: &[Tok]) -> bool {
    // PRAGMA name | PRAGMA schema . name
    let (name, rest) = match toks {
        [_, Tok::Word(_), Tok::Other, Tok::Word(name), rest @ ..] => (name, rest),
        [_, Tok::Word(name), rest @ ..] => (name, rest),
        _ => return false,
    };
    if !READ_PRAGMAS.contains(&name.as_str()) {
        return false;
    }
    // nothing behind it, or one argument in parentheses
    match rest {
        [] => true,
        [Tok::Open, inner @ .., Tok::Close] => {
            inner.len() == 1 && matches!(inner[0], Tok::Word(_) | Tok::Other)
        }
        _ => false,
    }
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
                        Tok::Word(x) if d == depth && (x == "WHERE" || x == "CURRENT") => {
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
    let toks = tokens(sql, kind);
    let mut worst = Class::Read;
    for statement in toks.split(|t| *t == Tok::Semi) {
        if let Some(class) = classify_one(statement, kind) {
            worst = worst.max(class);
        }
    }
    // T-SQL batches need no semicolon between statements: a second statement hides behind the first
    if kind == DbKind::Sqlserver && worst == Class::Read {
        let words: Vec<&str> = toks.iter().filter_map(word).collect();
        if words.iter().skip(1).any(|w| {
            DANGEROUS_WORDS.contains(w) || DDL_WORDS.contains(w) || WRITE_WORDS.contains(w)
        }) {
            worst = Class::Write;
        }
    }
    worst
}

/// The statement that makes a session read only on the server, where the database has one.
pub fn read_only_statement(kind: DbKind) -> Option<&'static str> {
    match kind {
        DbKind::Postgres => Some("SET default_transaction_read_only = on"),
        DbKind::Mysql => Some("SET SESSION TRANSACTION READ ONLY"),
        DbKind::Sqlite => Some("PRAGMA query_only = ON"),
        // SQL Server has no read-only session; the classification is all there is
        DbKind::Sqlserver => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Class::{Dangerous, Ddl, Read, Write};

    const ALL: [DbKind; 4] = [
        DbKind::Postgres,
        DbKind::Mysql,
        DbKind::Sqlserver,
        DbKind::Sqlite,
    ];

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
            ("SELECT E'it\\'s; DROP TABLE t' AS s", Read),
            ("SELECT 'a\\'; DROP TABLE t; --'", Dangerous),
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
            ("SELECT 'a\\'; DROP TABLE t; -- ' AS s", Read),
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
            ("EXEC sp_executesql N'DROP TABLE t'", Write),
            ("EXEC('DROP TABLE t')", Write),
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
}
