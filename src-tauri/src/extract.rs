//! Rows of a result as text in a format one can paste (prompt 009): TSV, CSV, JSON, Markdown, `INSERT`,
//! an `IN` list, a `WHERE` condition, an HTML table, plain values. Pure: an [`Extractor`] gets the cells as
//! they are stored (the JSON of [`crate::db::value::Cell`]) and appends text; where the text goes
//! (clipboard here, a file in prompt 011) is not its business.

use crate::db::DbKind;
use crate::db::meta::quote;
use crate::db::value::{ColKind, Column};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Tsv,
    Csv,
    Json,
    Markdown,
    Insert,
    /// `IN (…)` of the first column.
    Inlist,
    /// A condition that finds the rows again.
    Where,
    Html,
    /// The values of the first column, one per line.
    Values,
    /// One JSON object per line (export, prompt 011).
    Ndjson,
}

/// How to write. Everything has a default, so a caller names only what it wants different.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// A first line with the column names (TSV, CSV, Markdown and HTML).
    pub header: bool,
    /// NULL in TSV, CSV, Markdown, HTML and plain values: `""`, `NULL`, `\N` …
    pub null_as: String,
    /// The separator of CSV.
    pub delimiter: char,
    /// CSV lines end with CR LF (RFC 4180) instead of LF.
    pub crlf: bool,
    /// The table of `INSERT`, as it is written in SQL (quoted by the caller's source, the schema tree).
    pub table: String,
    /// Whose literals and names `INSERT`, `IN` and `WHERE` are written in.
    pub dialect: DbKind,
    /// Rows per `INSERT` statement; 1 = a statement per row.
    pub batch: u32,
    /// Keep the line break behind the last line (a file) instead of dropping it (the clipboard).
    pub final_newline: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            header: true,
            null_as: String::new(),
            delimiter: ',',
            crlf: false,
            table: "table_name".to_string(),
            dialect: DbKind::Postgres,
            batch: 1,
            final_newline: false,
        }
    }
}

/// Writes rows in one format. `begin`, then `row` for each row, then `end`.
pub struct Extractor {
    format: Format,
    options: Options,
    columns: Vec<Column>,
    rows: u64,
    /// Values already in the `IN` list.
    seen: std::collections::HashSet<String>,
}

fn is_number(kind: ColKind) -> bool {
    matches!(kind, ColKind::Int | ColKind::Float | ColKind::Decimal)
}

/// A number as SQL and JSON write it: digits, a sign, a point, an exponent – nothing else.
fn plain_number(text: &str) -> bool {
    let t = text.strip_prefix('-').unwrap_or(text);
    let (mantissa, exponent) = match t.split_once(['e', 'E']) {
        Some((m, e)) => (m, Some(e)),
        None => (t, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok = match mantissa.split_once('.') {
        Some((a, b)) => digits(a) && digits(b),
        None => digits(mantissa),
    };
    let exponent_ok = exponent.is_none_or(|e| digits(e.trim_start_matches(['+', '-'])));
    mantissa_ok && exponent_ok
}

/// A stored binary value: its length and the hex of the bytes that were kept.
fn binary(cell: &Value) -> Option<(u64, &str)> {
    let map = cell.as_object()?;
    Some((map.get("bytes")?.as_u64()?, map.get("hex")?.as_str()?))
}

/// A cell as plain text; `None` for NULL.
pub fn plain_text(cell: &Value) -> Option<String> {
    text(cell)
}

/// A cell as plain text; `None` for NULL.
fn text(cell: &Value) -> Option<String> {
    match cell {
        Value::Null => None,
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        other => Some(match binary(other) {
            Some((bytes, hex)) if bytes * 2 == hex.len() as u64 => format!("0x{hex}"),
            Some((bytes, hex)) => format!("0x{hex}… ({bytes} bytes)"),
            None => other
                .get("unreadable")
                .and_then(Value::as_str)
                .map(|t| format!("<{t}>"))
                .unwrap_or_default(),
        }),
    }
}

pub fn sql_text(text: &str, dialect: DbKind) -> String {
    let mut out = String::with_capacity(text.len() + 3);
    // SQL Server reads a plain literal in the code page of the database
    if dialect == DbKind::Sqlserver && !text.is_ascii() {
        out.push('N');
    }
    out.push('\'');
    for c in text.chars() {
        match c {
            '\'' => out.push_str("''"),
            // MySQL takes the backslash as an escape unless told otherwise
            '\\' if matches!(dialect, DbKind::Mysql | DbKind::Clickhouse) => out.push_str("\\\\"),
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// A cell as a literal of the dialect.
pub fn literal(cell: &Value, kind: ColKind, dialect: DbKind) -> String {
    match cell {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => match (dialect, *b) {
            (DbKind::Sqlserver | DbKind::Sqlite | DbKind::Libsql | DbKind::D1, true) => {
                "1".to_string()
            }
            (DbKind::Sqlserver | DbKind::Sqlite | DbKind::Libsql | DbKind::D1, false) => {
                "0".to_string()
            }
            (_, true) => "TRUE".to_string(),
            (_, false) => "FALSE".to_string(),
        },
        Value::Number(n) => n.to_string(),
        // big integers and decimals are stored as text, digit by digit
        Value::String(s) if is_number(kind) && plain_number(s) => s.clone(),
        // Oracle reads a text as a date by the format of the session: a literal of its own says what it is
        Value::String(s)
            if dialect == DbKind::Oracle
                && matches!(
                    kind,
                    ColKind::Date | ColKind::Timestamp | ColKind::TimestampTz
                ) =>
        {
            let spoken = s.replace('T', " ");
            let spoken = match spoken.strip_suffix('Z') {
                Some(utc) => format!("{utc} +00:00"),
                None => spoken,
            };
            if kind == ColKind::Date && spoken.len() == 10 {
                format!("DATE {}", sql_text(&spoken, dialect))
            } else {
                format!("TIMESTAMP {}", sql_text(&spoken, dialect))
            }
        }
        Value::String(s) => sql_text(s, dialect),
        other => match binary(other) {
            Some((bytes, hex)) if bytes * 2 == hex.len() as u64 => match dialect {
                DbKind::Postgres => format!("'\\x{hex}'"),
                DbKind::Sqlserver => format!("0x{hex}"),
                DbKind::Mysql
                | DbKind::Sqlite
                | DbKind::Libsql
                | DbKind::D1
                | DbKind::Trino
                | DbKind::Firebird => {
                    format!("X'{hex}'")
                }
                DbKind::Oracle => format!("HEXTORAW('{hex}')"),
                DbKind::Duckdb | DbKind::Clickhouse => format!("unhex('{hex}')"),
            },
            // only the head of a big value is kept (prompt 006): better no value than a wrong one
            Some((bytes, _)) => format!("NULL /* binary, {bytes} bytes: not copied */"),
            None => "NULL /* unreadable */".to_string(),
        },
    }
}

fn delimited(value: &str, delimiter: char, out: &mut String) {
    let quote = value.contains([delimiter, '"', '\n', '\r'])
        || value.starts_with(' ')
        || value.ends_with(' ');
    if !quote {
        out.push_str(value);
        return;
    }
    out.push('"');
    for c in value.chars() {
        if c == '"' {
            out.push('"');
        }
        out.push(c);
    }
    out.push('"');
}

fn html(value: &str, out: &mut String) {
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\n' => out.push_str("<br>"),
            '\r' => {}
            c => out.push(c),
        }
    }
}

fn markdown(value: &str, out: &mut String) {
    for c in value.chars() {
        match c {
            '|' => out.push_str("\\|"),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("<br>"),
            '\r' => {}
            c => out.push(c),
        }
    }
}

/// The keys of the JSON objects: the column names, made unique (`id`, `id_2`) and never empty.
fn json_keys(columns: &[Column]) -> Vec<String> {
    let mut seen = std::collections::HashMap::<String, u32>::new();
    columns
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let base = if c.name.is_empty() {
                format!("column_{}", i + 1)
            } else {
                c.name.clone()
            };
            let n = seen.entry(base.clone()).or_insert(0);
            *n += 1;
            if *n == 1 { base } else { format!("{base}_{n}") }
        })
        .collect()
}

impl Extractor {
    /// `columns`: the columns the rows will have, in their order.
    pub fn new(format: Format, options: Options, columns: Vec<Column>) -> Self {
        Self {
            format,
            options,
            columns,
            rows: 0,
            seen: Default::default(),
        }
    }

    /// Rows written so far.
    pub fn rows(&self) -> u64 {
        self.rows
    }

    fn eol(&self) -> &'static str {
        if self.format == Format::Csv && self.options.crlf {
            "\r\n"
        } else {
            "\n"
        }
    }

    fn name(&self, c: &Column) -> String {
        quote(&c.name, self.options.dialect)
    }

    fn shown(&self, cell: &Value) -> String {
        text(cell).unwrap_or_else(|| self.options.null_as.clone())
    }

    pub fn begin(&mut self, out: &mut String) {
        let o = &self.options;
        match self.format {
            Format::Tsv | Format::Csv if o.header => {
                let delimiter = if self.format == Format::Tsv {
                    '\t'
                } else {
                    o.delimiter
                };
                for (i, c) in self.columns.iter().enumerate() {
                    if i > 0 {
                        out.push(delimiter);
                    }
                    delimited(&c.name, delimiter, out);
                }
                out.push_str(self.eol());
            }
            Format::Markdown => {
                // a Markdown table needs its header
                out.push('|');
                for c in &self.columns {
                    out.push(' ');
                    markdown(&c.name, out);
                    out.push_str(" |");
                }
                out.push_str("\n|");
                for c in &self.columns {
                    out.push_str(if is_number(c.kind) {
                        " ---: |"
                    } else {
                        " --- |"
                    });
                }
                out.push('\n');
            }
            Format::Html => {
                out.push_str("<table>\n");
                if o.header {
                    out.push_str("<thead><tr>");
                    for c in &self.columns {
                        out.push_str("<th>");
                        html(&c.name, out);
                        out.push_str("</th>");
                    }
                    out.push_str("</tr></thead>\n");
                }
                out.push_str("<tbody>\n");
            }
            Format::Json => out.push('['),
            Format::Inlist => out.push_str("IN ("),
            Format::Where => out.push_str("WHERE "),
            _ => {}
        }
    }

    /// Appends a row; `cells` has a cell per column of [`Extractor::new`].
    pub fn row(&mut self, cells: &[Value], out: &mut String) {
        let first = self.rows == 0;
        let null = Value::Null;
        let cell = |i: usize| cells.get(i).unwrap_or(&null);
        let dialect = self.options.dialect;
        match self.format {
            Format::Tsv | Format::Csv => {
                let delimiter = if self.format == Format::Tsv {
                    '\t'
                } else {
                    self.options.delimiter
                };
                for i in 0..self.columns.len() {
                    if i > 0 {
                        out.push(delimiter);
                    }
                    delimited(&self.shown(cell(i)), delimiter, out);
                }
                out.push_str(self.eol());
            }
            Format::Json | Format::Ndjson => {
                if self.format == Format::Json {
                    out.push_str(if first { "\n  " } else { ",\n  " });
                }
                out.push('{');
                for (i, key) in json_keys(&self.columns).iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    out.push_str(&Value::String(key.clone()).to_string());
                    out.push_str(": ");
                    let value = cell(i);
                    let written = match value {
                        // JSON of the database stays JSON, as far as it is some
                        Value::String(s) if self.columns[i].kind == ColKind::Json => {
                            serde_json::from_str::<Value>(s).unwrap_or_else(|_| value.clone())
                        }
                        Value::Object(_) => Value::String(text(value).unwrap_or_default()),
                        other => other.clone(),
                    };
                    out.push_str(&written.to_string());
                }
                out.push('}');
                if self.format == Format::Ndjson {
                    out.push('\n');
                }
            }
            Format::Markdown => {
                out.push('|');
                for i in 0..self.columns.len() {
                    out.push(' ');
                    markdown(&self.shown(cell(i)), out);
                    out.push_str(" |");
                }
                out.push('\n');
            }
            Format::Html => {
                out.push_str("<tr>");
                for i in 0..self.columns.len() {
                    out.push_str("<td>");
                    html(&self.shown(cell(i)), out);
                    out.push_str("</td>");
                }
                out.push_str("</tr>\n");
            }
            Format::Insert => {
                let batch = u64::from(self.options.batch.max(1));
                let starts = self.rows.is_multiple_of(batch);
                if starts {
                    if batch > 1 && !first {
                        out.push_str(";\n");
                    }
                    out.push_str("INSERT INTO ");
                    out.push_str(&self.options.table);
                    out.push_str(" (");
                    for (i, c) in self.columns.iter().enumerate() {
                        if i > 0 {
                            out.push_str(", ");
                        }
                        out.push_str(&self.name(c));
                    }
                    out.push_str(if batch > 1 {
                        ") VALUES\n  ("
                    } else {
                        ") VALUES ("
                    });
                } else {
                    out.push_str(",\n  (");
                }
                for (i, c) in self.columns.iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    out.push_str(&literal(cell(i), c.kind, dialect));
                }
                out.push_str(if batch > 1 { ")" } else { ");\n" });
            }
            Format::Inlist => {
                let Some(c) = self.columns.first() else {
                    return;
                };
                // NULL is never IN a list, and a value is there once
                if cell(0).is_null() {
                    return;
                }
                let value = literal(cell(0), c.kind, dialect);
                if !self.seen.insert(value.clone()) {
                    return;
                }
                if self.seen.len() > 1 {
                    out.push_str(", ");
                }
                out.push_str(&value);
            }
            Format::Where => {
                if !first {
                    out.push_str("\n   OR ");
                }
                let many = self.columns.len() > 1;
                if many {
                    out.push('(');
                }
                for (i, c) in self.columns.iter().enumerate() {
                    if i > 0 {
                        out.push_str(" AND ");
                    }
                    out.push_str(&self.name(c));
                    if cell(i).is_null() {
                        out.push_str(" IS NULL");
                    } else {
                        out.push_str(" = ");
                        out.push_str(&literal(cell(i), c.kind, dialect));
                    }
                }
                if many {
                    out.push(')');
                }
            }
            Format::Values => {
                out.push_str(&self.shown(cell(0)));
                out.push('\n');
            }
        }
        self.rows += 1;
    }

    pub fn end(&mut self, out: &mut String) {
        match self.format {
            Format::Json => out.push_str(if self.rows == 0 { "]" } else { "\n]" }),
            Format::Html => out.push_str("</tbody>\n</table>"),
            Format::Inlist => out.push(')'),
            Format::Where => {
                if self.rows == 0 {
                    out.push_str("1 = 0");
                }
            }
            Format::Insert if self.options.batch > 1 => {
                if self.rows > 0 {
                    out.push(';');
                    if self.options.final_newline {
                        out.push('\n');
                    }
                }
            }
            Format::Tsv
            | Format::Csv
            | Format::Markdown
            | Format::Insert
            | Format::Values
            | Format::Ndjson => {
                // the last line break is not part of what is pasted into a cell or a query
                if !self.options.final_newline {
                    while out.ends_with(['\n', '\r']) {
                        out.pop();
                    }
                }
            }
        }
    }
}

/// Rows as text, all at once: for small selections and tests.
pub fn extract(
    format: Format,
    options: Options,
    columns: Vec<Column>,
    rows: &[Vec<Value>],
) -> String {
    let mut out = String::new();
    let mut e = Extractor::new(format, options, columns);
    e.begin(&mut out);
    for row in rows {
        e.row(row, &mut out);
    }
    e.end(&mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn col(name: &str, kind: ColKind) -> Column {
        Column {
            name: name.to_string(),
            kind,
            type_name: String::new(),
        }
    }

    fn columns() -> Vec<Column> {
        vec![
            col("id", ColKind::Int),
            col("name", ColKind::Text),
            col("price", ColKind::Decimal),
            col("ok", ColKind::Bool),
        ]
    }

    /// Values that break naive writers: separators, quotes, line breaks, NULL, the text NULL, Unicode.
    fn nasty() -> Vec<Vec<Value>> {
        vec![
            vec![json!(1), json!("plain"), json!("12.50"), json!(true)],
            vec![
                json!(2),
                json!("tab\there, \"quoted\"\nnew line"),
                Value::Null,
                json!(false),
            ],
            vec![
                json!(3),
                json!("NULL"),
                json!("9223372036854775807.123456789"),
                Value::Null,
            ],
            vec![
                json!(4),
                json!("O'Brien; Grüße 🚀 小林 |x| \\n"),
                json!("-0.5"),
                json!(true),
            ],
            vec![json!(5), json!(""), json!("1e3"), json!(true)],
        ]
    }

    fn run(format: Format, options: Options) -> String {
        extract(format, options, columns(), &nasty())
    }

    /// Reads TSV/CSV back the way a spreadsheet does.
    fn read_delimited(text: &str, delimiter: char) -> Vec<Vec<String>> {
        let mut rows = vec![vec![String::new()]];
        let mut quoted = false;
        let mut chars = text.chars().peekable();
        while let Some(c) = chars.next() {
            let row = rows.last_mut().unwrap();
            let field = row.last_mut().unwrap();
            if quoted {
                if c == '"' {
                    if chars.peek() == Some(&'"') {
                        field.push('"');
                        chars.next();
                    } else {
                        quoted = false;
                    }
                } else {
                    field.push(c);
                }
            } else if c == '"' && field.is_empty() {
                quoted = true;
            } else if c == delimiter {
                row.push(String::new());
            } else if c == '\n' {
                rows.push(vec![String::new()]);
            } else if c != '\r' {
                field.push(c);
            }
        }
        rows
    }

    #[test]
    fn tsv_and_csv_survive_the_round_trip_through_a_spreadsheet() {
        for (format, delimiter, crlf) in [
            (Format::Tsv, '\t', false),
            (Format::Csv, ',', false),
            (Format::Csv, ';', true),
        ] {
            let options = Options {
                delimiter,
                crlf,
                null_as: "\\N".into(),
                ..Options::default()
            };
            let text = run(format, options);
            let back = read_delimited(&text, delimiter);
            assert_eq!(back.len(), 6, "{text}");
            assert_eq!(back[0], vec!["id", "name", "price", "ok"]);
            assert_eq!(back[2][1], "tab\there, \"quoted\"\nnew line");
            assert_eq!(back[2][2], "\\N");
            assert_eq!(back[3][1], "NULL");
            assert_eq!(back[3][2], "9223372036854775807.123456789");
            assert_eq!(back[4][1], "O'Brien; Grüße 🚀 小林 |x| \\n");
            assert_eq!(back[5][1], "");
            assert_eq!(text.contains("\r\n"), crlf);
            assert!(!text.ends_with('\n'));
        }
    }

    #[test]
    fn the_header_can_be_left_out() {
        let options = Options {
            header: false,
            ..Options::default()
        };
        let text = extract(Format::Tsv, options, columns(), &nasty()[..1]);
        assert_eq!(text, "1\tplain\t12.50\ttrue");
    }

    #[test]
    fn json_keeps_numbers_as_numbers_and_what_is_too_big_as_text() {
        let text = run(Format::Json, Options::default());
        let back: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(back.as_array().unwrap().len(), 5);
        assert_eq!(
            back[0],
            json!({"id": 1, "name": "plain", "price": "12.50", "ok": true})
        );
        assert_eq!(back[1]["price"], Value::Null);
        assert_eq!(back[2]["price"], json!("9223372036854775807.123456789"));
        assert_eq!(back[3]["name"], json!("O'Brien; Grüße 🚀 小林 |x| \\n"));
        assert_eq!(
            extract(Format::Json, Options::default(), columns(), &[]),
            "[]"
        );
    }

    #[test]
    fn json_columns_stay_json_and_double_names_get_a_number() {
        let cols = vec![
            col("id", ColKind::Int),
            col("id", ColKind::Json),
            col("", ColKind::Json),
        ];
        let rows = vec![vec![json!(1), json!("{\"a\": [1, 2]}"), json!("not json")]];
        let back: Value =
            serde_json::from_str(&extract(Format::Json, Options::default(), cols, &rows)).unwrap();
        assert_eq!(
            back[0],
            json!({"id": 1, "id_2": {"a": [1, 2]}, "column_3": "not json"})
        );
    }

    #[test]
    fn markdown_is_a_table_with_numbers_to_the_right() {
        let text = run(Format::Markdown, Options::default());
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "| id | name | price | ok |");
        assert_eq!(lines[1], "| ---: | --- | ---: | --- |");
        assert_eq!(
            lines[3],
            "| 2 | tab\there, \"quoted\"<br>new line |  | false |"
        );
        assert_eq!(
            lines[5],
            "| 4 | O'Brien; Grüße 🚀 小林 \\|x\\| \\\\n | -0.5 | true |"
        );
        assert_eq!(lines.len(), 7);
    }

    #[test]
    fn html_is_escaped() {
        let cols = vec![col("<b>", ColKind::Text)];
        let rows = vec![
            vec![json!("<img src=x onerror=alert(1)> & \"q\"")],
            vec![Value::Null],
        ];
        let text = extract(Format::Html, Options::default(), cols, &rows);
        assert!(!text.contains("<img"));
        assert!(text.contains("<th>&lt;b&gt;</th>"));
        assert!(text.contains("<td>&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;</td>"));
        assert!(text.starts_with("<table>") && text.ends_with("</table>"));
    }

    #[test]
    fn insert_writes_literals_of_the_dialect() {
        let pg = run(
            Format::Insert,
            Options {
                table: "shop.\"Order\"".into(),
                ..Options::default()
            },
        );
        let lines: Vec<&str> = pg.split(";\n").collect();
        assert_eq!(
            lines[0],
            "INSERT INTO shop.\"Order\" (id, name, price, ok) VALUES (1, 'plain', 12.50, TRUE)"
        );
        assert!(lines[1].ends_with("VALUES (2, 'tab\there, \"quoted\"\nnew line', NULL, FALSE)"));
        assert!(lines[2].ends_with("(3, 'NULL', 9223372036854775807.123456789, NULL)"));
        assert!(lines[3].ends_with("(4, 'O''Brien; Grüße 🚀 小林 |x| \\n', -0.5, TRUE)"));
        assert!(lines[4].ends_with("(5, '', 1e3, TRUE);"));

        let my = run(
            Format::Insert,
            Options {
                dialect: DbKind::Mysql,
                ..Options::default()
            },
        );
        assert!(my.contains("'O''Brien; Grüße 🚀 小林 |x| \\\\n'"), "{my}");
        let ms = run(
            Format::Insert,
            Options {
                dialect: DbKind::Sqlserver,
                ..Options::default()
            },
        );
        assert!(
            ms.contains("N'O''Brien; Grüße 🚀 小林 |x| \\n', -0.5, 1)"),
            "{ms}"
        );
        assert!(ms.contains("(1, 'plain', 12.50, 1)"), "{ms}");
    }

    #[test]
    fn insert_quotes_names_and_writes_binary_only_when_it_is_whole() {
        let cols = vec![col("select", ColKind::Int), col("Größe", ColKind::Bytes)];
        let rows = vec![
            vec![json!(1), json!({"bytes": 2, "hex": "cafe"})],
            vec![json!(2), json!({"bytes": 3000, "hex": "ffd8"})],
            vec![json!("NaN"), json!({"unreadable": "GEOMETRY"})],
        ];
        let text = |dialect| {
            extract(
                Format::Insert,
                Options {
                    dialect,
                    table: "t".into(),
                    ..Options::default()
                },
                cols.clone(),
                &rows,
            )
        };
        let pg = text(DbKind::Postgres);
        assert!(
            pg.contains("INSERT INTO t (\"select\", \"Größe\") VALUES (1, '\\xcafe');"),
            "{pg}"
        );
        assert!(
            pg.contains("(2, NULL /* binary, 3000 bytes: not copied */);"),
            "{pg}"
        );
        // what is no number in a number column is text
        assert!(pg.contains("('NaN', NULL /* unreadable */);"), "{pg}");
        assert!(text(DbKind::Mysql).contains("(`select`, `Größe`) VALUES (1, X'cafe');"));
        assert!(text(DbKind::Sqlserver).contains("([select], [Größe]) VALUES (1, 0xcafe);"));
        assert!(text(DbKind::Sqlite).contains("VALUES (1, X'cafe');"));
    }

    #[test]
    fn a_text_cannot_leave_its_literal() {
        for dialect in [
            DbKind::Postgres,
            DbKind::Mysql,
            DbKind::Sqlserver,
            DbKind::Sqlite,
        ] {
            let evil = json!("x'); DROP TABLE t; --");
            assert_eq!(
                literal(&evil, ColKind::Text, dialect),
                "'x''); DROP TABLE t; --'",
                "{dialect:?}"
            );
            // a number column that holds something else is quoted, never pasted
            assert_eq!(
                literal(&json!("1; DROP TABLE t"), ColKind::Int, dialect),
                "'1; DROP TABLE t'"
            );
        }
        assert_eq!(
            literal(&json!("a\\' OR 1=1 --"), ColKind::Text, DbKind::Mysql),
            "'a\\\\'' OR 1=1 --'"
        );
    }

    #[test]
    fn numbers_are_recognised_strictly() {
        for ok in ["0", "-1", "12.50", "1e3", "1.5E-7", "9223372036854775807"] {
            assert!(plain_number(ok), "{ok}");
        }
        for bad in [
            "", "-", "1.", ".5", "1e", "NaN", "Infinity", "1 ", "0x1f", "1,5", "--1",
        ] {
            assert!(!plain_number(bad), "{bad}");
        }
    }

    #[test]
    fn an_in_list_has_every_value_once_and_no_null() {
        let cols = vec![col("name", ColKind::Text)];
        let rows = vec![
            vec![json!("a")],
            vec![Value::Null],
            vec![json!("b'c")],
            vec![json!("a")],
        ];
        assert_eq!(
            extract(Format::Inlist, Options::default(), cols.clone(), &rows),
            "IN ('a', 'b''c')"
        );
        assert_eq!(
            extract(Format::Inlist, Options::default(), cols, &[]),
            "IN ()"
        );
        let ids = vec![col("id", ColKind::Int)];
        let rows = vec![vec![json!(3)], vec![json!(1)], vec![json!(3)]];
        assert_eq!(
            extract(Format::Inlist, Options::default(), ids, &rows),
            "IN (3, 1)"
        );
    }

    #[test]
    fn a_where_condition_finds_the_rows_again() {
        let cols = vec![col("id", ColKind::Int), col("Name", ColKind::Text)];
        let rows = vec![vec![json!(1), json!("a")], vec![json!(2), Value::Null]];
        assert_eq!(
            extract(Format::Where, Options::default(), cols.clone(), &rows),
            "WHERE (id = 1 AND \"Name\" = 'a')\n   OR (id = 2 AND \"Name\" IS NULL)"
        );
        assert_eq!(
            extract(
                Format::Where,
                Options::default(),
                cols[..1].to_vec(),
                &rows[..1]
            ),
            "WHERE id = 1"
        );
        assert_eq!(
            extract(Format::Where, Options::default(), cols, &[]),
            "WHERE 1 = 0"
        );
    }

    #[test]
    fn ndjson_is_an_object_per_line() {
        let options = Options {
            final_newline: true,
            ..Options::default()
        };
        let text = extract(Format::Ndjson, options, columns(), &nasty());
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 5);
        assert!(text.ends_with("}\n"));
        let second: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(second["name"], json!("tab\there, \"quoted\"\nnew line"));
        assert_eq!(second["price"], Value::Null);
    }

    #[test]
    fn insert_in_batches_writes_several_rows_per_statement() {
        let options = Options {
            batch: 2,
            table: "t".into(),
            final_newline: true,
            ..Options::default()
        };
        let cols = vec![col("id", ColKind::Int), col("name", ColKind::Text)];
        let rows: Vec<Vec<Value>> = (1..=5)
            .map(|i| vec![json!(i), json!(format!("n{i}"))])
            .collect();
        assert_eq!(
            extract(Format::Insert, options.clone(), cols.clone(), &rows),
            "INSERT INTO t (id, name) VALUES\n  (1, 'n1'),\n  (2, 'n2');\n\
             INSERT INTO t (id, name) VALUES\n  (3, 'n3'),\n  (4, 'n4');\n\
             INSERT INTO t (id, name) VALUES\n  (5, 'n5');\n"
        );
        assert_eq!(extract(Format::Insert, options, cols, &[]), "");
    }

    #[test]
    fn a_file_keeps_its_last_line_break() {
        let options = Options {
            final_newline: true,
            header: false,
            ..Options::default()
        };
        assert_eq!(
            extract(Format::Csv, options, columns(), &nasty()[..1]),
            "1,plain,12.50,true\n"
        );
    }

    #[test]
    fn plain_values_are_the_first_column_line_by_line() {
        let options = Options {
            null_as: "NULL".into(),
            ..Options::default()
        };
        let cols = vec![col("name", ColKind::Text)];
        let rows = vec![vec![json!("a")], vec![Value::Null], vec![json!("b")]];
        assert_eq!(extract(Format::Values, options, cols, &rows), "a\nNULL\nb");
    }

    #[test]
    fn the_options_have_defaults_for_what_is_not_said() {
        let o: Options =
            serde_json::from_value(json!({"nullAs": "NULL", "dialect": "mysql"})).unwrap();
        assert_eq!(o.null_as, "NULL");
        assert_eq!(o.dialect, DbKind::Mysql);
        assert!(o.header);
        assert_eq!(o.delimiter, ',');
        let f: Format = serde_json::from_value(json!("inlist")).unwrap();
        assert_eq!(f, Format::Inlist);
    }
}
