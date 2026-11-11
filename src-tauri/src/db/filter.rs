//! The `SELECT` of a table view (prompt 027): built here from what the filter row and the column heads
//! say, never typed. Names go through [`meta::quote`], every value is **bound** – the text of the statement
//! holds placeholders only. Pure; the cases below are the catalog (also of values that try to be SQL).
//!
//! Per database:
//! - **PostgreSQL** compares strictly by type and a bound text is `text`: each placeholder is cast to the
//!   type of its column (`CAST($1 AS uuid)`), so the server reads the value as what the column is.
//! - **MySQL, SQL Server, SQLite** convert on their own: numbers are bound as numbers, the rest as text.
//! - `NULLS FIRST/LAST` is written where it exists (PostgreSQL, SQLite) and as a leading sort key elsewhere.
//! - A limit is `LIMIT n`, on SQL Server `TOP (n)`.

use super::meta::quote;
use super::{Bind, DbKind};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::extract::sql_text;
use serde::{Deserialize, Serialize};

/// Conditions and sort keys a view takes at most.
pub const MAX_PARTS: usize = 50;
/// Values of one `IN` at most.
pub const MAX_IN: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Op {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Like,
    NotLike,
    /// The text occurs anywhere (`%` and `_` in it are characters, not wildcards).
    Contains,
    In,
    Between,
    IsNull,
    IsNotNull,
}

/// What a value of a column is, as far as the window knows it from the result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ValueKind {
    Number,
    Bool,
    #[default]
    Text,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    /// The name of the column as the catalog has it (quoted here).
    pub column: String,
    pub op: Op,
    /// As the user typed them: none for `IS NULL`, two for `BETWEEN`, any number for `IN`, else one.
    #[serde(default)]
    pub values: Vec<String>,
    #[serde(default)]
    pub kind: ValueKind,
    /// The type of the column as the database names it (`uuid`, `int4`, `timestamptz` …): PostgreSQL
    /// casts the value to it. Empty: no cast.
    #[serde(default)]
    pub type_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Nulls {
    First,
    Last,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub column: String,
    #[serde(default)]
    pub desc: bool,
    /// Where NULLs stand; `None` = as the database does it.
    #[serde(default)]
    pub nulls: Option<Nulls>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableQuery {
    /// `None`: the table is looked up as the session does it.
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    #[serde(default)]
    pub conditions: Vec<Condition>,
    /// The conditions are joined with `OR` (else `AND`).
    #[serde(default)]
    pub any: bool,
    /// A condition the user wrote as SQL. It is the user's own text, as in an editor – and must be one
    /// expression: `;` and comments are refused.
    #[serde(default)]
    pub where_sql: Option<String>,
    #[serde(default)]
    pub order: Vec<Order>,
    /// Rows at most; `None` = all.
    #[serde(default)]
    pub limit: Option<u64>,
    /// Only rows with one of these keys (prompt 030: the rows a foreign key points to, or those that
    /// point to a row). Joined to the other conditions with `AND`.
    #[serde(default)]
    pub keys: Option<KeySet>,
    /// Count the rows instead of reading them: `SELECT COUNT(*)`, without order and limit.
    #[serde(default)]
    pub count: bool,
}

/// Rows of a key at most; more are refused (the window says so before it asks).
pub const MAX_KEY_ROWS: usize = 1000;
/// Values of all key rows together at most (SQL Server takes 2100 parameters in a statement).
pub const MAX_KEY_VALUES: usize = 2000;
/// Columns of a key at most.
pub const MAX_KEY_COLUMNS: usize = 16;
/// Bytes of one key value at most: a key is short; anything longer is no value to follow.
pub const MAX_KEY_VALUE_BYTES: usize = 4096;
/// Values a statement binds at most, keys and conditions together (`MAX_BINDS` of the manager).
pub const MAX_PARAMS: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyColumn {
    pub column: String,
    #[serde(default)]
    pub kind: ValueKind,
    /// As in [`Condition`]: PostgreSQL casts the value to it.
    #[serde(default)]
    pub type_name: String,
}

/// Values of a key, row by row: one column gives `IN (…)`, several give
/// `(a = … AND b = …) OR (…)`. Every value is bound. A key never holds NULL (NULL references nothing):
/// the window leaves such rows out.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySet {
    pub columns: Vec<KeyColumn>,
    pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Built {
    /// The statement with placeholders: what runs.
    pub sql: String,
    /// The values, in the order of the placeholders. Sent back with the statement, bound by the driver.
    pub params: Vec<Bind>,
    /// The same statement with the values written out as literals of the dialect: to read, and to go on
    /// with in an editor.
    pub display: String,
}

pub(super) fn invalid(message: &str) -> AppError {
    AppError::new(ErrorCode::Unsupported, message)
}

pub(super) fn name(raw: &str, kind: DbKind) -> AppResult<String> {
    if raw.is_empty() || raw.len() > 256 || raw.contains('\0') {
        return Err(invalid("not a name"));
    }
    Ok(quote(raw, kind))
}

/// A type name that can stand in a `CAST` as it is – by its **shape**, not by its characters: a name, up
/// to three more words (`timestamp with time zone`), a size (`(12,2)`), array brackets. The name comes
/// from the server or from a stored filter: anyone may create a type called `int4) or exists(select f()`.
/// What has another shape is not written; the value is then compared as text.
fn castable(type_name: &str) -> Option<String> {
    let t = type_name.trim().to_ascii_lowercase();
    if t.is_empty() || t.len() > 64 {
        return None;
    }
    let b = t.as_bytes();
    let mut i = 0;
    let word = |i: &mut usize, first: bool| -> bool {
        let start = *i;
        while *i < b.len()
            && (b[*i].is_ascii_lowercase()
                || (first && (b[*i] == b'_' || (*i > start && b[*i].is_ascii_digit()))))
        {
            *i += 1;
        }
        *i > start
    };
    if !word(&mut i, true) {
        return None;
    }
    let mut words = 1;
    while i < b.len() && b[i] == b' ' {
        i += 1;
        if words == 4 || !word(&mut i, false) {
            return None;
        }
        words += 1;
    }
    let digits = |i: &mut usize| -> bool {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        (1..=4).contains(&(*i - start))
    };
    if i < b.len() && b[i] == b'(' {
        i += 1;
        if !digits(&mut i) {
            return None;
        }
        if i < b.len() && b[i] == b',' {
            i += 1;
            if !digits(&mut i) {
                return None;
            }
        }
        if i >= b.len() || b[i] != b')' {
            return None;
        }
        i += 1;
    }
    while b[i..].starts_with(b"[]") {
        i += 2;
    }
    if i != b.len() {
        return None;
    }
    // a cast must not change the value: `char` and `bit` without a length mean one character (the driver
    // names `character(n)` just `CHAR`) – cast to the types that keep all of it instead
    let (base, brackets) = match t.find('[') {
        Some(at) => t.split_at(at),
        None => (t.as_str(), ""),
    };
    Some(match base {
        "char" | "character" | "bpchar" => format!("bpchar{brackets}"),
        "bit" => format!("varbit{brackets}"),
        _ => t,
    })
}

/// SQL Server reads the text `2024-03-04 10:00:00` for a `datetime` or `smalldatetime` by the language
/// of the login (day and month may swap); with a `T` between date and time it reads it the same for
/// everyone. `type_name` is the driver's (`Datetime`, `Datetimen`, `Datetime4`).
fn mssql_datetime(raw: &str, type_name: &str) -> Option<String> {
    if !matches!(
        type_name.trim().to_ascii_lowercase().as_str(),
        "datetime" | "datetimen" | "datetime4" | "smalldatetime"
    ) {
        return None;
    }
    let t = raw.trim();
    let b = t.as_bytes();
    let digits = |from: usize, to: usize| {
        b.get(from..to)
            .is_some_and(|d| d.iter().all(u8::is_ascii_digit))
    };
    let shaped = b.len() >= 19
        && digits(0, 4)
        && b[4] == b'-'
        && digits(5, 7)
        && b[7] == b'-'
        && digits(8, 10)
        && b[10] == b' '
        && digits(11, 13)
        && b[13] == b':'
        && digits(14, 16)
        && b[16] == b':'
        && digits(17, 19)
        && (b.len() == 19 || (b[19] == b'.' && b.len() > 20 && digits(20, b.len())));
    shaped.then(|| format!("{}T{}", &t[..10], &t[11..]))
}

/// A whole number as far as 64 bits reach: bound as one, never through a float.
fn is_int(text: &str) -> bool {
    let t = text.trim();
    let digits = t.strip_prefix(['-', '+']).unwrap_or(t);
    !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit())
        && t.trim_start_matches('+').parse::<i64>().is_ok()
}

fn is_decimal(text: &str) -> bool {
    let t = text.trim();
    let body = t.strip_prefix(['-', '+']).unwrap_or(t);
    let (a, b) = body.split_once('.').unwrap_or((body, "0"));
    !a.is_empty()
        && !b.is_empty()
        && a.len() + b.len() <= 60
        && a.bytes().chain(b.bytes()).all(|c| c.is_ascii_digit())
}

/// Writes a statement twice: with placeholders (and the values beside it), and readable with literals.
/// Also used for the `UPDATE`s of `edit.rs` – the one place that turns a value into a placeholder.
pub(super) struct Builder {
    pub(super) kind: DbKind,
    pub(super) sql: String,
    pub(super) display: String,
    pub(super) params: Vec<Bind>,
}

impl Builder {
    pub(super) fn new(kind: DbKind) -> Self {
        Builder {
            kind,
            sql: String::new(),
            display: String::new(),
            params: Vec::new(),
        }
    }

    pub(super) fn text(&mut self, text: &str) {
        self.sql.push_str(text);
        self.display.push_str(text);
    }

    /// A placeholder for a value of a column, and the value beside it.
    pub(super) fn value(&mut self, raw: &str, kind: ValueKind, type_name: &str) {
        let n = self.params.len() + 1;
        let (bind, cast) = match self.kind {
            // the server reads the text as what the column is
            DbKind::Postgres => (Bind::Text(raw.to_owned()), castable(type_name)),
            _ => {
                let bind = match kind {
                    ValueKind::Number if is_int(raw) => {
                        Bind::Int(raw.trim().trim_start_matches('+').to_owned())
                    }
                    ValueKind::Number if is_decimal(raw) && self.kind != DbKind::Mysql => {
                        Bind::Decimal(raw.trim().trim_start_matches('+').to_owned())
                    }
                    ValueKind::Bool => match raw.trim().to_ascii_lowercase().as_str() {
                        "true" | "t" | "1" | "yes" | "ja" => Bind::Bool(true),
                        "false" | "f" | "0" | "no" | "nein" => Bind::Bool(false),
                        _ => Bind::Text(raw.to_owned()),
                    },
                    _ => match (self.kind, mssql_datetime(raw, type_name)) {
                        (DbKind::Sqlserver, Some(iso)) => Bind::Text(iso),
                        _ => Bind::Text(raw.to_owned()),
                    },
                };
                (bind, None)
            }
        };
        let placeholder = match self.kind {
            DbKind::Postgres => format!("${n}"),
            DbKind::Mysql => "?".to_owned(),
            DbKind::Sqlserver => format!("@P{n}"),
            DbKind::Sqlite => format!("?{n}"),
        };
        let literal = match &bind {
            Bind::Int(v) | Bind::Decimal(v) => v.clone(),
            Bind::Bool(b) => match (self.kind, *b) {
                (DbKind::Sqlserver | DbKind::Sqlite, true) => "1".to_owned(),
                (DbKind::Sqlserver | DbKind::Sqlite, false) => "0".to_owned(),
                (_, true) => "TRUE".to_owned(),
                (_, false) => "FALSE".to_owned(),
            },
            // the readable form may be run by hand: a backslash must not be read as an escape by a
            // PostgreSQL that is set to do so – in an E'…' string it is written out as one
            Bind::Text(v) | Bind::Date(v) | Bind::Datetime(v)
                if self.kind == DbKind::Postgres && v.contains('\\') =>
            {
                format!("E'{}'", v.replace('\\', "\\\\").replace('\'', "''"))
            }
            Bind::Text(v) | Bind::Date(v) | Bind::Datetime(v) => sql_text(v, self.kind),
        };
        match cast {
            Some(ty) => {
                self.sql.push_str(&format!("CAST({placeholder} AS {ty})"));
                self.display.push_str(&format!("CAST({literal} AS {ty})"));
            }
            None => {
                self.sql.push_str(&placeholder);
                self.display.push_str(&literal);
            }
        }
        self.params.push(bind);
    }

    /// A pattern for `LIKE`: always text, never cast.
    fn pattern(&mut self, pattern: &str) {
        self.value(pattern, ValueKind::Text, "");
    }

    /// The column as text, for `LIKE` on a column that is none.
    fn as_text(&self, column: &str, kind: ValueKind) -> String {
        if kind == ValueKind::Text {
            return column.to_owned();
        }
        match self.kind {
            DbKind::Postgres | DbKind::Sqlite => format!("CAST({column} AS text)"),
            DbKind::Mysql => format!("CAST({column} AS char)"),
            DbKind::Sqlserver => format!("CAST({column} AS nvarchar(max))"),
        }
    }

    /// The rows with one of the keys: `IN` for one column, a bracket of `(a = … AND b = …)` joined with
    /// `OR` for several. The caller has checked the sizes.
    fn keys(&mut self, keys: &KeySet) -> AppResult<()> {
        if let [only] = keys.columns.as_slice() {
            let column = name(&only.column, self.kind)?;
            self.text(&format!("{column} IN ("));
            for (i, row) in keys.rows.iter().enumerate() {
                if i > 0 {
                    self.text(", ");
                }
                self.value(&row[0], only.kind, &only.type_name);
            }
            self.text(")");
            return Ok(());
        }
        let names = keys
            .columns
            .iter()
            .map(|c| name(&c.column, self.kind))
            .collect::<AppResult<Vec<_>>>()?;
        self.text("(");
        for (i, row) in keys.rows.iter().enumerate() {
            if i > 0 {
                self.text("\n   OR ");
            }
            self.text("(");
            for (c, value) in row.iter().enumerate() {
                if c > 0 {
                    self.text(" AND ");
                }
                self.text(&format!("{} = ", names[c]));
                self.value(value, keys.columns[c].kind, &keys.columns[c].type_name);
            }
            self.text(")");
        }
        self.text(")");
        Ok(())
    }

    fn condition(&mut self, c: &Condition) -> AppResult<()> {
        let column = name(&c.column, self.kind)?;
        let need = |n: usize| -> AppResult<()> {
            if c.values.len() == n {
                Ok(())
            } else {
                Err(invalid("a condition has not the values its operator needs"))
            }
        };
        let simple = |op: Op| match op {
            Op::Eq => "=",
            Op::Ne => "<>",
            Op::Lt => "<",
            Op::Le => "<=",
            Op::Gt => ">",
            _ => ">=",
        };
        match c.op {
            Op::IsNull => self.text(&format!("{column} IS NULL")),
            Op::IsNotNull => self.text(&format!("{column} IS NOT NULL")),
            Op::Eq | Op::Ne | Op::Lt | Op::Le | Op::Gt | Op::Ge => {
                need(1)?;
                self.text(&format!("{column} {} ", simple(c.op)));
                self.value(&c.values[0], c.kind, &c.type_name);
            }
            Op::Between => {
                need(2)?;
                self.text(&format!("{column} BETWEEN "));
                self.value(&c.values[0], c.kind, &c.type_name);
                self.text(" AND ");
                self.value(&c.values[1], c.kind, &c.type_name);
            }
            Op::In => {
                if c.values.is_empty() || c.values.len() > MAX_IN {
                    return Err(invalid("a list needs 1 to 1000 values"));
                }
                self.text(&format!("{column} IN ("));
                for (i, v) in c.values.iter().enumerate() {
                    if i > 0 {
                        self.text(", ");
                    }
                    self.value(v, c.kind, &c.type_name);
                }
                self.text(")");
            }
            Op::Like | Op::NotLike => {
                need(1)?;
                let not = if c.op == Op::NotLike { " NOT" } else { "" };
                let text = self.as_text(&column, c.kind);
                self.text(&format!("{text}{not} LIKE "));
                self.pattern(&c.values[0]);
            }
            Op::Contains => {
                need(1)?;
                // `!` escapes: the same in all four databases (a backslash is not)
                let mut pattern = String::with_capacity(c.values[0].len() + 2);
                pattern.push('%');
                for ch in c.values[0].chars() {
                    if matches!(ch, '%' | '_' | '!' | '[') {
                        pattern.push('!');
                    }
                    pattern.push(ch);
                }
                pattern.push('%');
                let text = self.as_text(&column, c.kind);
                self.text(&format!("{text} LIKE "));
                self.pattern(&pattern);
                self.text(" ESCAPE '!'");
            }
        }
        Ok(())
    }
}

/// The free condition must be one expression that stays in its brackets. Outside of strings and quoted
/// names it holds nothing that ends the statement or hides its rest (`;`, comments), no bracket that
/// closes what it did not open, and no placeholder – those belong to the values of the conditions.
fn check_where(sql: &str, kind: DbKind) -> AppResult<()> {
    let refuse = |what: &str| {
        Err(invalid(&format!(
            "the free condition must be one expression: {what}"
        )))
    };
    if sql.len() > 10_000 || sql.contains('\0') {
        return refuse("it is too long");
    }
    let b = sql.as_bytes();
    let mut depth = 0usize;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let next = b.get(i + 1).copied().unwrap_or(0);
        // strings and quoted names: text, whatever it holds (a doubled quote is the quote itself)
        let close = match c {
            b'\'' => Some(b'\''),
            b'"' => Some(b'"'),
            b'`' if kind == DbKind::Mysql || kind == DbKind::Sqlite => Some(b'`'),
            b'[' if kind == DbKind::Sqlserver => Some(b']'),
            _ => None,
        };
        if let Some(close) = close {
            i += 1;
            loop {
                match b.get(i) {
                    None => return refuse("a string or a quoted name is not closed"),
                    // MySQL reads a backslash in a string as an escape
                    Some(b'\\') if kind == DbKind::Mysql && close != b'`' => i += 2,
                    Some(&x) if x == close => {
                        if b.get(i + 1) == Some(&close) {
                            i += 2;
                        } else {
                            i += 1;
                            break;
                        }
                    }
                    Some(_) => i += 1,
                }
            }
            continue;
        }
        match c {
            b';' => return refuse("no `;`"),
            b'-' if next == b'-' => return refuse("no comments"),
            b'/' if next == b'*' => return refuse("no comments"),
            b'#' if kind == DbKind::Mysql => return refuse("no comments"),
            b'(' => depth += 1,
            b')' => {
                if depth == 0 {
                    return refuse("a bracket closes that was not opened");
                }
                depth -= 1;
            }
            b'$' if kind == DbKind::Postgres && next.is_ascii_digit() => {
                return refuse("no placeholders");
            }
            b'?' if matches!(kind, DbKind::Mysql | DbKind::Sqlite) => {
                return refuse("no placeholders");
            }
            b'@' if kind == DbKind::Sqlserver
                && (next | 0x20) == b'p'
                && b.get(i + 2).is_some_and(u8::is_ascii_digit) =>
            {
                return refuse("no placeholders");
            }
            _ => {}
        }
        i += 1;
    }
    if depth > 0 {
        return refuse("a bracket is not closed");
    }
    Ok(())
}

/// The statement of a table view.
pub fn build(kind: DbKind, q: &TableQuery) -> AppResult<Built> {
    if q.conditions.len() > MAX_PARTS || q.order.len() > MAX_PARTS {
        return Err(invalid("too many conditions"));
    }
    let table = match q.schema.as_deref().filter(|s| !s.is_empty()) {
        Some(schema) => format!("{}.{}", name(schema, kind)?, name(&q.table, kind)?),
        None => name(&q.table, kind)?,
    };
    let mut b = Builder {
        kind,
        sql: String::new(),
        display: String::new(),
        params: Vec::new(),
    };
    if let Some(keys) = &q.keys {
        let width = keys.columns.len();
        if width == 0 || width > MAX_KEY_COLUMNS {
            return Err(invalid("a key has one to sixteen columns"));
        }
        if keys.rows.is_empty() {
            return Err(invalid("a key without values"));
        }
        if keys.rows.len() > MAX_KEY_ROWS || keys.rows.len() * width > MAX_KEY_VALUES {
            return Err(invalid("too many key values"));
        }
        if keys.rows.iter().any(|row| row.len() != width) {
            return Err(invalid("a key row does not fit its columns"));
        }
        if keys
            .rows
            .iter()
            .flatten()
            .any(|v| v.len() > MAX_KEY_VALUE_BYTES)
        {
            return Err(invalid("a key value is too long"));
        }
    }
    match (kind, q.limit, q.count) {
        (_, _, true) => b.text(&format!("SELECT COUNT(*)\nFROM {table}")),
        (DbKind::Sqlserver, Some(n), false) => b.text(&format!("SELECT TOP ({n}) *\nFROM {table}")),
        _ => b.text(&format!("SELECT *\nFROM {table}")),
    }
    let free = q
        .where_sql
        .as_deref()
        .map(str::trim)
        .filter(|w| !w.is_empty());
    if let Some(free) = free {
        check_where(free, kind)?;
    }
    if q.keys.is_some() || !q.conditions.is_empty() || free.is_some() {
        b.text("\nWHERE ");
        let mut first = true;
        if let Some(keys) = &q.keys {
            b.keys(keys)?;
            first = false;
        }
        if !q.conditions.is_empty() {
            if !first {
                b.text("\n  AND ");
            }
            // conditions joined with OR stand in a bracket beside anything joined to them with AND
            let grouped = (free.is_some() || !first) && q.conditions.len() > 1 && q.any;
            if grouped {
                b.text("(");
            }
            for (i, c) in q.conditions.iter().enumerate() {
                if i > 0 {
                    b.text(if q.any { "\n   OR " } else { "\n  AND " });
                }
                b.condition(c)?;
            }
            if grouped {
                b.text(")");
            }
            first = false;
        }
        if let Some(free) = free {
            if !first {
                b.text("\n  AND ");
            }
            b.text(&format!("({free})"));
        }
    }
    if !q.order.is_empty() && !q.count {
        b.text("\nORDER BY ");
        for (i, o) in q.order.iter().enumerate() {
            if i > 0 {
                b.text(", ");
            }
            let column = name(&o.column, kind)?;
            let native = matches!(kind, DbKind::Postgres | DbKind::Sqlite);
            if let (Some(nulls), false) = (o.nulls, native) {
                // no NULLS FIRST/LAST there: a key before the column says where the NULLs go
                let (null, other) = if nulls == Nulls::First {
                    (0, 1)
                } else {
                    (1, 0)
                };
                b.text(&format!(
                    "CASE WHEN {column} IS NULL THEN {null} ELSE {other} END, "
                ));
            }
            b.text(&column);
            if o.desc {
                b.text(" DESC");
            }
            if let (Some(nulls), true) = (o.nulls, native) {
                b.text(if nulls == Nulls::First {
                    " NULLS FIRST"
                } else {
                    " NULLS LAST"
                });
            }
        }
    }
    if let (Some(n), false) = (q.limit, kind == DbKind::Sqlserver || q.count) {
        b.text(&format!("\nLIMIT {n}"));
    }
    // refused here, before the statement is shown anywhere, not later by the driver
    if b.params.len() > MAX_PARAMS {
        return Err(invalid("too many values in one statement"));
    }
    Ok(Built {
        sql: b.sql,
        params: b.params,
        display: b.display,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [DbKind; 4] = [
        DbKind::Postgres,
        DbKind::Mysql,
        DbKind::Sqlserver,
        DbKind::Sqlite,
    ];

    fn cond(column: &str, op: Op, values: &[&str]) -> Condition {
        Condition {
            column: column.into(),
            op,
            values: values.iter().map(|v| (*v).to_owned()).collect(),
            kind: ValueKind::Text,
            type_name: String::new(),
        }
    }

    fn query(conditions: Vec<Condition>) -> TableQuery {
        TableQuery {
            schema: Some("shop".into()),
            table: "orders".into(),
            conditions,
            ..TableQuery::default()
        }
    }

    #[test]
    fn a_plain_table_is_a_plain_select() {
        let q = TableQuery {
            table: "Meine Tabelle".into(),
            limit: Some(200),
            ..TableQuery::default()
        };
        assert_eq!(
            build(DbKind::Postgres, &q).unwrap().sql,
            "SELECT *\nFROM \"Meine Tabelle\"\nLIMIT 200"
        );
        assert_eq!(
            build(DbKind::Mysql, &q).unwrap().sql,
            "SELECT *\nFROM `Meine Tabelle`\nLIMIT 200"
        );
        assert_eq!(
            build(DbKind::Sqlserver, &q).unwrap().sql,
            "SELECT TOP (200) *\nFROM [Meine Tabelle]"
        );
        assert!(build(DbKind::Sqlite, &q).unwrap().params.is_empty());
    }

    #[test]
    fn conditions_become_placeholders_and_values_go_apart() {
        let mut q = query(vec![
            Condition {
                kind: ValueKind::Number,
                type_name: "INT4".into(),
                ..cond("customer_id", Op::Eq, &["42"])
            },
            cond("state", Op::In, &["paid", "shipped"]),
            Condition {
                type_name: "TIMESTAMPTZ".into(),
                ..cond("ordered_at", Op::Between, &["2026-01-01", "2026-12-31"])
            },
            cond("note", Op::IsNull, &[]),
            cond("city", Op::Contains, &["100%_!"]),
            Condition {
                kind: ValueKind::Number,
                ..cond("total", Op::Like, &["12%"])
            },
        ]);
        q.order = vec![
            Order {
                column: "ordered_at".into(),
                desc: true,
                nulls: Some(Nulls::Last),
            },
            Order {
                column: "id".into(),
                desc: false,
                nulls: None,
            },
        ];
        q.limit = Some(1000);
        let pg = build(DbKind::Postgres, &q).unwrap();
        assert_eq!(
            pg.sql,
            "SELECT *\nFROM shop.orders\nWHERE customer_id = CAST($1 AS int4)\n  AND state IN ($2, $3)\n  AND ordered_at BETWEEN CAST($4 AS timestamptz) AND CAST($5 AS timestamptz)\n  AND note IS NULL\n  AND city LIKE $6 ESCAPE '!'\n  AND CAST(total AS text) LIKE $7\nORDER BY ordered_at DESC NULLS LAST, id\nLIMIT 1000"
        );
        // in PostgreSQL every value is text: the cast in the statement makes it what the column is
        assert_eq!(pg.params.len(), 7);
        assert!(pg.params.iter().all(|p| matches!(p, Bind::Text(_))));
        assert_eq!(pg.params[5], Bind::Text("%100!%!_!!%".into()));
        assert_eq!(
            pg.display,
            "SELECT *\nFROM shop.orders\nWHERE customer_id = CAST('42' AS int4)\n  AND state IN ('paid', 'shipped')\n  AND ordered_at BETWEEN CAST('2026-01-01' AS timestamptz) AND CAST('2026-12-31' AS timestamptz)\n  AND note IS NULL\n  AND city LIKE '%100!%!_!!%' ESCAPE '!'\n  AND CAST(total AS text) LIKE '12%'\nORDER BY ordered_at DESC NULLS LAST, id\nLIMIT 1000"
        );
        let ms = build(DbKind::Sqlserver, &q).unwrap();
        assert_eq!(
            ms.sql,
            "SELECT TOP (1000) *\nFROM shop.orders\nWHERE customer_id = @P1\n  AND state IN (@P2, @P3)\n  AND ordered_at BETWEEN @P4 AND @P5\n  AND note IS NULL\n  AND city LIKE @P6 ESCAPE '!'\n  AND CAST(total AS nvarchar(max)) LIKE @P7\nORDER BY CASE WHEN ordered_at IS NULL THEN 1 ELSE 0 END, ordered_at DESC, id"
        );
        // elsewhere a number is bound as a number
        assert_eq!(ms.params[0], Bind::Int("42".into()));
        let my = build(DbKind::Mysql, &q).unwrap();
        assert!(
            my.sql
                .contains("WHERE customer_id = ?\n  AND state IN (?, ?)")
        );
        assert!(my.sql.contains("ORDER BY CASE WHEN ordered_at IS NULL THEN 1 ELSE 0 END, ordered_at DESC, id\nLIMIT 1000"));
        let lite = build(DbKind::Sqlite, &q).unwrap();
        assert!(
            lite.sql
                .contains("customer_id = ?1\n  AND state IN (?2, ?3)")
        );
        assert!(
            lite.sql
                .ends_with("ORDER BY ordered_at DESC NULLS LAST, id\nLIMIT 1000")
        );
    }

    #[test]
    fn or_and_a_free_condition() {
        let mut q = query(vec![cond("a", Op::Eq, &["1"]), cond("b", Op::Ne, &["2"])]);
        q.any = true;
        assert!(
            build(DbKind::Sqlite, &q)
                .unwrap()
                .sql
                .ends_with("WHERE a = ?1\n   OR b <> ?2")
        );
        q.where_sql = Some("  total > 100 and lower(city) = 'köln' ".into());
        assert!(build(DbKind::Sqlite, &q).unwrap().sql.ends_with(
            "WHERE (a = ?1\n   OR b <> ?2)\n  AND (total > 100 and lower(city) = 'köln')"
        ));
        q.conditions.clear();
        assert!(
            build(DbKind::Sqlite, &q)
                .unwrap()
                .sql
                .ends_with("WHERE (total > 100 and lower(city) = 'köln')")
        );
        // the free condition is one expression: it cannot end the statement or hide the rest of it
        for bad in [
            "1 = 1; DROP TABLE orders",
            "1 = 1 -- ",
            "1 = 1 /* x",
            "a = 1;",
        ] {
            q.where_sql = Some(bad.into());
            assert_eq!(
                build(DbKind::Postgres, &q).unwrap_err().code,
                ErrorCode::Unsupported,
                "{bad}"
            );
        }
    }

    fn keys(columns: &[(&str, ValueKind, &str)], rows: &[&[&str]]) -> KeySet {
        KeySet {
            columns: columns
                .iter()
                .map(|(column, kind, type_name)| KeyColumn {
                    column: (*column).into(),
                    kind: *kind,
                    type_name: (*type_name).into(),
                })
                .collect(),
            rows: rows
                .iter()
                .map(|row| row.iter().map(|v| (*v).to_owned()).collect())
                .collect(),
        }
    }

    /// Prompt 030: the rows a foreign key points to – one column as a list, several as pairs.
    #[test]
    fn keys_become_a_list_or_pairs_with_every_value_bound() {
        let mut q = query(vec![]);
        q.keys = Some(keys(
            &[("id", ValueKind::Number, "int8")],
            &[&["7"], &["42"]],
        ));
        let pg = build(DbKind::Postgres, &q).unwrap();
        assert_eq!(
            pg.sql,
            "SELECT *\nFROM shop.orders\nWHERE id IN (CAST($1 AS int8), CAST($2 AS int8))"
        );
        assert_eq!(
            pg.params,
            vec![Bind::Text("7".into()), Bind::Text("42".into())]
        );
        assert_eq!(
            pg.display,
            "SELECT *\nFROM shop.orders\nWHERE id IN (CAST('7' AS int8), CAST('42' AS int8))"
        );
        // a composite key: pair by pair, in a bracket, beside the conditions of the user
        q.keys = Some(keys(
            &[
                ("warehouse", ValueKind::Number, "int4"),
                ("item code", ValueKind::Text, ""),
            ],
            &[&["1", "A-7"], &["2", "B'9"]],
        ));
        q.conditions = vec![
            cond("state", Op::Eq, &["open"]),
            cond("state", Op::Eq, &["held"]),
        ];
        q.any = true;
        q.limit = Some(200);
        let my = build(DbKind::Mysql, &q).unwrap();
        assert_eq!(
            my.sql,
            "SELECT *\nFROM shop.orders\nWHERE ((warehouse = ? AND `item code` = ?)\n   OR (warehouse = ? AND `item code` = ?))\n  AND (state = ?\n   OR state = ?)\nLIMIT 200"
        );
        assert_eq!(my.params.len(), 6);
        assert_eq!(my.params[3], Bind::Text("B'9".into()));
        let ms = build(DbKind::Sqlserver, &q).unwrap();
        assert!(ms.sql.starts_with(
            "SELECT TOP (200) *\nFROM shop.orders\nWHERE ((warehouse = @P1 AND [item code] = @P2)"
        ));
        // counting: the same rows, no order, no limit
        q.count = true;
        q.order = vec![Order {
            column: "id".into(),
            desc: false,
            nulls: None,
        }];
        let count = build(DbKind::Sqlserver, &q).unwrap();
        assert!(
            count
                .sql
                .starts_with("SELECT COUNT(*)\nFROM shop.orders\nWHERE ((")
        );
        assert!(!count.sql.contains("ORDER BY") && !count.sql.contains("TOP"));
        assert!(!build(DbKind::Postgres, &q).unwrap().sql.contains("LIMIT"));
    }

    #[test]
    fn keys_that_do_not_fit_are_refused_and_no_key_value_stands_in_the_statement() {
        let refused = |k: KeySet| {
            let mut q = query(vec![]);
            q.keys = Some(k);
            build(DbKind::Postgres, &q).unwrap_err().code
        };
        let no = invalid("").code;
        let one = [("id", ValueKind::Number, "int4")];
        assert_eq!(refused(keys(&[], &[&["1"]])), no);
        assert_eq!(refused(keys(&one, &[])), no);
        assert_eq!(refused(keys(&one, &[&["1", "2"]])), no);
        assert_eq!(refused(keys(&one, &[&[]])), no);
        let many: Vec<Vec<String>> = (0..=MAX_KEY_ROWS).map(|i| vec![i.to_string()]).collect();
        assert_eq!(
            refused(KeySet {
                rows: many,
                ..keys(&one, &[])
            }),
            no
        );
        // three columns: 667 rows are more values than a statement takes
        let three = [
            ("a", ValueKind::Text, ""),
            ("b", ValueKind::Text, ""),
            ("c", ValueKind::Text, ""),
        ];
        let wide: Vec<Vec<String>> = (0..667).map(|i| vec![i.to_string(); 3]).collect();
        assert_eq!(
            refused(KeySet {
                rows: wide,
                ..keys(&three, &[])
            }),
            no
        );
        // review 030: a value longer than any key is refused, and so is a statement whose keys and
        // conditions together bind more than a driver takes
        assert_eq!(
            refused(keys(&one, &[&[&"x".repeat(MAX_KEY_VALUE_BYTES + 1)]])),
            no
        );
        let mut q = query(vec![cond("state", Op::Eq, &["open"])]);
        let pair = [("a", ValueKind::Text, ""), ("b", ValueKind::Text, "")];
        q.keys = Some(KeySet {
            rows: (0..1000).map(|i| vec![i.to_string(); 2]).collect(),
            ..keys(&pair, &[])
        });
        assert_eq!(build(DbKind::Postgres, &q).unwrap_err().code, no);
        q.conditions.clear();
        assert_eq!(
            build(DbKind::Postgres, &q).unwrap().params.len(),
            MAX_PARAMS
        );
        // a column name is quoted like any other; a type that is none is not written
        let mut q = query(vec![]);
        q.keys = Some(keys(
            &[("id\"; DROP TABLE t; --", ValueKind::Text, "int4); DROP")],
            &[&["1"]],
        ));
        let built = build(DbKind::Postgres, &q).unwrap();
        assert_eq!(
            built.sql,
            "SELECT *\nFROM shop.orders\nWHERE \"id\"\"; DROP TABLE t; --\" IN ($1)"
        );
        for kind in ALL {
            for evil in [
                "'; DROP TABLE orders; --",
                "1) OR (1=1",
                "x' OR 'a'='a",
                "?1",
                "$1",
                "@P1",
            ] {
                for value_kind in [ValueKind::Text, ValueKind::Number, ValueKind::Bool] {
                    for columns in [&one[..], &three[..]] {
                        let row: Vec<&str> = vec![evil; columns.len()];
                        let mut q = query(vec![]);
                        let mut set = keys(columns, &[&row]);
                        for c in &mut set.columns {
                            c.kind = value_kind;
                        }
                        q.keys = Some(set);
                        let built = build(kind, &q).unwrap();
                        for word in ["DROP", "OR (1", "'a'", "--"] {
                            assert!(!built.sql.contains(word), "{kind:?} {evil}: {}", built.sql);
                        }
                        assert_eq!(built.params.len(), columns.len());
                    }
                }
            }
        }
    }

    /// The acceptance criterion: no value can become SQL, whatever it holds – in no database, with no
    /// operator. The statement that would be sent is checked itself.
    #[test]
    fn no_value_ever_stands_in_the_statement() {
        let evil = [
            "'; DROP TABLE orders; --",
            "\" OR \"\"=\"",
            "1 OR 1=1",
            "x') UNION SELECT password FROM users --",
            "\\'; DELETE FROM t; --",
            "`; SHUTDOWN; --",
            "]; EXEC xp_cmdshell('dir'); --",
            "$1); DROP TABLE t; --",
            "?1 OR ?2",
            "@P1; DROP",
            "%' OR '1'='1",
            "\0; DROP TABLE t",
            "ä😀'\"`[];--/*",
        ];
        let ops = [
            Op::Eq,
            Op::Ne,
            Op::Lt,
            Op::Le,
            Op::Gt,
            Op::Ge,
            Op::Like,
            Op::NotLike,
            Op::Contains,
            Op::In,
        ];
        for kind in ALL {
            for value in evil {
                for op in ops {
                    for value_kind in [ValueKind::Text, ValueKind::Number, ValueKind::Bool] {
                        let q = query(vec![Condition {
                            kind: value_kind,
                            type_name: "int4".into(),
                            ..cond("c", op, &[value])
                        }]);
                        let built = build(kind, &q).unwrap();
                        // nothing of the value is in the text that runs
                        for word in [
                            "DROP", "UNION", "DELETE", "SHUTDOWN", "EXEC", "OR 1", "😀", "'1'",
                        ] {
                            assert!(!built.sql.contains(word), "{kind:?} {op:?}: {}", built.sql);
                        }
                        assert!(!built.sql.contains(';'), "{}", built.sql);
                        // the value is whole in what is bound (a pattern wraps it)
                        assert_eq!(built.params.len(), 1);
                        let Bind::Text(bound) = &built.params[0] else {
                            panic!(
                                "a text that is no number or boolean is bound as text: {:?}",
                                built.params[0]
                            );
                        };
                        if op == Op::Contains {
                            assert!(bound.starts_with('%') && bound.ends_with('%'));
                        } else {
                            assert_eq!(bound, value);
                        }
                    }
                }
                let between = query(vec![cond("c", Op::Between, &[value, value])]);
                let built = build(kind, &between).unwrap();
                assert!(!built.sql.contains("DROP") && built.params.len() == 2);
            }
        }
    }

    #[test]
    fn names_are_quoted_whatever_they_hold() {
        let q = TableQuery {
            schema: Some("my\"schema".into()),
            table: "t; DROP TABLE x".into(),
            conditions: vec![cond("col\"; --", Op::Eq, &["1"])],
            order: vec![Order {
                column: "a]b`c".into(),
                desc: false,
                nulls: None,
            }],
            ..TableQuery::default()
        };
        assert_eq!(
            build(DbKind::Postgres, &q).unwrap().sql,
            "SELECT *\nFROM \"my\"\"schema\".\"t; DROP TABLE x\"\nWHERE \"col\"\"; --\" = $1\nORDER BY \"a]b`c\""
        );
        assert_eq!(
            build(DbKind::Sqlserver, &q).unwrap().sql,
            "SELECT *\nFROM [my\"schema].[t; DROP TABLE x]\nWHERE [col\"; --] = @P1\nORDER BY [a]]b`c]"
        );
        assert!(
            build(DbKind::Mysql, &q)
                .unwrap()
                .sql
                .contains("ORDER BY `a]b``c`")
        );
        // a type name that is no type name is never written into a cast
        let odd = query(vec![Condition {
            type_name: "int4); DROP TABLE x; --".into(),
            ..cond("c", Op::Eq, &["1"])
        }]);
        assert_eq!(
            build(DbKind::Postgres, &odd).unwrap().sql,
            "SELECT *\nFROM shop.orders\nWHERE c = $1"
        );
        let array = query(vec![Condition {
            type_name: "NUMERIC(12,2)".into(),
            ..cond("c", Op::Eq, &["1"])
        }]);
        assert!(
            build(DbKind::Postgres, &array)
                .unwrap()
                .sql
                .ends_with("c = CAST($1 AS numeric(12,2))")
        );
        for bad in ["", "a\0b"] {
            let q = TableQuery {
                table: bad.into(),
                ..TableQuery::default()
            };
            assert!(build(DbKind::Postgres, &q).is_err());
        }
    }

    #[test]
    fn values_are_typed_where_the_database_converts_on_its_own() {
        let n = |v: &str| Condition {
            kind: ValueKind::Number,
            ..cond("c", Op::Eq, &[v])
        };
        let bound =
            |kind: DbKind, c: Condition| build(kind, &query(vec![c])).unwrap().params[0].clone();
        assert_eq!(bound(DbKind::Sqlite, n("-7")), Bind::Int("-7".into()));
        assert_eq!(
            bound(DbKind::Sqlserver, n("12.50")),
            Bind::Decimal("12.50".into())
        );
        // MySQL converts a text itself and exactly; a bound decimal would be a double there
        assert_eq!(bound(DbKind::Mysql, n("12.50")), Bind::Text("12.50".into()));
        // what is no number stays what was typed: the database says what it thinks of it
        assert_eq!(bound(DbKind::Sqlite, n("abc")), Bind::Text("abc".into()));
        let b = Condition {
            kind: ValueKind::Bool,
            ..cond("c", Op::Eq, &["Ja"])
        };
        assert_eq!(bound(DbKind::Mysql, b.clone()), Bind::Bool(true));
        assert_eq!(
            build(DbKind::Sqlserver, &query(vec![b])).unwrap().display,
            "SELECT *\nFROM shop.orders\nWHERE c = 1"
        );
    }

    #[test]
    fn refuses_what_is_no_condition() {
        for c in [
            cond("c", Op::Eq, &[]),
            cond("c", Op::Eq, &["1", "2"]),
            cond("c", Op::Between, &["1"]),
            cond("c", Op::In, &[]),
            cond("", Op::IsNull, &[]),
        ] {
            assert!(build(DbKind::Postgres, &query(vec![c])).is_err());
        }
        let many = query(
            (0..=MAX_PARTS)
                .map(|_| cond("c", Op::IsNull, &[]))
                .collect(),
        );
        assert!(build(DbKind::Postgres, &many).is_err());
    }

    #[test]
    fn reads_what_the_window_sends() {
        let q: TableQuery = serde_json::from_value(serde_json::json!({
            "schema": "shop", "table": "orders", "any": true, "limit": 200,
            "conditions": [{ "column": "id", "op": "between", "values": ["1", "9"], "kind": "number", "typeName": "INT4" },
                           { "column": "n", "op": "isNotNull" }],
            "order": [{ "column": "id", "desc": true, "nulls": "first" }],
            "whereSql": "a > 1"
        }))
        .unwrap();
        assert_eq!(q.conditions[0].op, Op::Between);
        assert_eq!(q.order[0].nulls, Some(Nulls::First));
        let built = serde_json::to_value(build(DbKind::Postgres, &q).unwrap()).unwrap();
        assert_eq!(
            built["params"][0],
            serde_json::json!({ "kind": "text", "value": "1" })
        );
        assert!(built["display"].as_str().unwrap().contains("NULLS FIRST"));
    }

    /// Review 027: a type name comes from the server (anyone may `CREATE TYPE "…"`) or from a stored
    /// filter – it is written into a cast only when it has the shape of a type name.
    /// Review 031: a cast must not change the value. PostgreSQL's driver names `character(n)` `CHAR` and
    /// `bit(n)` `BIT` – and a cast to `char` or `bit` without a length keeps one character.
    #[test]
    fn a_cast_never_shortens_a_value() {
        for (name, cast) in [
            ("CHAR", "bpchar"),
            ("char", "bpchar"),
            ("CHAR[]", "bpchar[]"),
            ("BIT", "varbit"),
            ("character", "bpchar"),
            ("char(10)", "char(10)"),
            ("VARCHAR", "varchar"),
            ("bit(8)", "bit(8)"),
        ] {
            let q = query(vec![Condition {
                type_name: name.into(),
                ..cond("code", Op::Eq, &["DE"])
            }]);
            let sql = build(DbKind::Postgres, &q).unwrap().sql;
            assert!(
                sql.ends_with(&format!("code = CAST($1 AS {cast})")),
                "{name}: {sql}"
            );
        }
    }

    /// Review 031: SQL Server reads `2024-03-04 10:00:00` for a `datetime` by the language of the login
    /// (4 March or 3 April); with a `T` it is the same day for everyone. Only for those types: a text
    /// that looks like a date stays what it is.
    #[test]
    fn a_datetime_for_sql_server_does_not_depend_on_the_language() {
        let with = |type_name: &str, value: &str| {
            let q = query(vec![Condition {
                type_name: type_name.into(),
                ..cond("at", Op::Eq, &[value])
            }]);
            build(DbKind::Sqlserver, &q).unwrap()
        };
        for ty in ["Datetime", "Datetimen", "Datetime4"] {
            let built = with(ty, "2024-03-04 10:00:00.123");
            assert_eq!(
                built.params,
                vec![Bind::Text("2024-03-04T10:00:00.123".into())],
                "{ty}"
            );
            assert!(
                built.display.ends_with("'2024-03-04T10:00:00.123'"),
                "{}",
                built.display
            );
        }
        for (ty, value) in [
            ("NVarchar", "2024-03-04 10:00:00"),
            ("Datetime2", "2024-03-04 10:00:00"),
            ("Datetime", "not a date"),
        ] {
            assert_eq!(
                with(ty, value).params,
                vec![Bind::Text(value.into())],
                "{ty}"
            );
        }
        // and nowhere else
        let q = query(vec![Condition {
            type_name: "datetime".into(),
            ..cond("at", Op::Eq, &["2024-03-04 10:00:00"])
        }]);
        assert_eq!(
            build(DbKind::Mysql, &q).unwrap().params,
            vec![Bind::Text("2024-03-04 10:00:00".into())]
        );
    }

    /// Review 031: a whole number is bound as one as far as 64 bits reach – never through a float.
    #[test]
    fn big_whole_numbers_stay_whole() {
        for value in [
            "1234567890123456789",
            "-9223372036854775808",
            "9223372036854775807",
        ] {
            let q = query(vec![Condition {
                kind: ValueKind::Number,
                ..cond("id", Op::Eq, &[value])
            }]);
            assert_eq!(
                build(DbKind::Sqlite, &q).unwrap().params,
                vec![Bind::Int(value.into())],
                "{value}"
            );
        }
    }

    #[test]
    fn a_type_name_that_is_sql_is_never_written() {
        for evil in [
            "int4) or (true",
            "int4) or exists(select pg_reload_conf()",
            "int4) or exists(select pg_sleep(9)",
            "text) , (select 1",
            "numeric(12,2) or true",
            "a b c d e f",
            "int4()",
            "int4(1,2,3)",
            "int4(x)",
            "int4[] or true",
            "(int4)",
            "int4,int8",
        ] {
            let q = query(vec![Condition {
                type_name: evil.into(),
                ..cond("c", Op::Eq, &["1"])
            }]);
            let built = build(DbKind::Postgres, &q).unwrap();
            assert_eq!(
                built.sql, "SELECT *\nFROM shop.orders\nWHERE c = $1",
                "{evil}"
            );
        }
        for (good, written) in [
            ("INT4", "int4"),
            ("timestamptz", "timestamptz"),
            ("NUMERIC(12,2)", "numeric(12,2)"),
            ("varchar(40)", "varchar(40)"),
            ("TIMESTAMP WITH TIME ZONE", "timestamp with time zone"),
            ("double precision", "double precision"),
            ("int4[]", "int4[]"),
            ("_my_enum", "_my_enum"),
        ] {
            let q = query(vec![Condition {
                type_name: good.into(),
                ..cond("c", Op::Eq, &["1"])
            }]);
            let built = build(DbKind::Postgres, &q).unwrap();
            assert!(
                built.sql.ends_with(&format!("c = CAST($1 AS {written})")),
                "{good}: {}",
                built.sql
            );
        }
    }

    /// Review 027: the free condition stays inside its brackets, and takes no placeholder of the values.
    #[test]
    fn the_free_condition_cannot_leave_its_brackets() {
        let free = |kind: DbKind, sql: &str| {
            build(
                kind,
                &TableQuery {
                    table: "t".into(),
                    where_sql: Some(sql.into()),
                    ..TableQuery::default()
                },
            )
        };
        for bad in [
            "1=1) UNION SELECT usename, passwd FROM pg_shadow WHERE (1=1",
            "a = 1) or (b = 2",
            "(a = 1",
            "a = 1)",
            ")(",
            "a = 'open",
            "a = \"open",
        ] {
            for kind in ALL {
                assert!(free(kind, bad).is_err(), "{kind:?}: {bad}");
            }
        }
        // MySQL: `#` starts a comment that would hide the closing bracket
        assert!(free(DbKind::Mysql, "1=1) INTO OUTFILE '/tmp/x' #").is_err());
        assert!(free(DbKind::Mysql, "a = 1 # x").is_err());
        // a placeholder would take a value of a condition, or none at all
        assert!(free(DbKind::Postgres, "a = $1").is_err());
        assert!(free(DbKind::Mysql, "a = ?").is_err());
        assert!(free(DbKind::Sqlite, "a = ?1").is_err());
        assert!(free(DbKind::Sqlserver, "a = @P1").is_err());
        // what is text in the condition is text: brackets, `;`, `--` and `#` in a literal are fine
        for good in [
            "name = 'a;b' and note <> '--' and x = '/* (' ",
            "(a = 1 or (b = 2 and c in (1, 2)))",
            "\"odd)name\" = 'it''s )'",
            "tags ? 'a'",
            "price > @price_floor",
        ] {
            assert!(free(DbKind::Postgres, good).is_ok(), "{good}");
        }
        assert!(free(DbKind::Sqlserver, "[a)b] = 1 and x = '#'").is_ok());
        assert!(free(DbKind::Mysql, "`a#b` = '#'").is_ok());
    }

    /// Review 027: the readable form can be run by hand – a backslash in a value must not end its literal
    /// on a PostgreSQL that reads backslashes in strings.
    #[test]
    fn the_readable_form_writes_backslashes_so_that_every_server_reads_them_as_text() {
        let q = query(vec![cond("c", Op::Eq, &["\\'; DROP TABLE t; --"])]);
        let pg = build(DbKind::Postgres, &q).unwrap();
        assert_eq!(
            pg.display,
            "SELECT *\nFROM shop.orders\nWHERE c = E'\\\\''; DROP TABLE t; --'"
        );
        // what runs is untouched: the value is bound as it is
        assert_eq!(pg.params[0], Bind::Text("\\'; DROP TABLE t; --".into()));
        let plain = build(DbKind::Postgres, &query(vec![cond("c", Op::Eq, &["it's"])])).unwrap();
        assert!(plain.display.ends_with("c = 'it''s'"));
    }
}
