//! Loading a file into a table (prompt 033) – the writing half: every record of the file becomes a row
//! through the mapping the user made, rows go to the table in shared `INSERT`s built by `edit.rs` (names
//! quoted, **every value bound**), and what cannot be written is either the end of the import or a line
//! in an error file. The file is not trusted: its column names never become SQL (the target columns are
//! named by the mapping and quoted), its values never become SQL text.

use super::edit::{self, RowInsert, SetCell, UpdatePlan};
use super::filter::{Built, MAX_PARAMS, ValueKind, invalid, name};
use super::value::VecSink;
use super::{DbKind, Limits, Session, Stop, begin_statement};
use crate::data_import::{Guess, GuessKind, Record, Source};
use crate::error::{AppError, AppResult, ErrorCode};
use serde::{Deserialize, Serialize};
use std::io::Write;

/// Columns of a target table at most.
pub const MAX_TARGET_COLUMNS: usize = 1_000;
/// Problems of single rows kept for the report (all of them go to the error file).
pub const REPORTED_ERRORS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetColumn {
    pub name: String,
    #[serde(default)]
    pub kind: ValueKind,
    /// The type as the database names it: PostgreSQL casts the value to it.
    #[serde(default)]
    pub type_name: String,
}

/// How a date in the file is written, if not as `2026-11-11`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DateOrder {
    /// `11.11.2026`, `11/11/2026`
    Dmy,
    /// `11/30/2026`
    Mdy,
}

/// Where the value of a target column comes from.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mapping {
    /// The column of the file (from 0); `None`: the fixed value.
    #[serde(default)]
    pub source: Option<usize>,
    /// The same value for every row (`None` with no source: NULL).
    #[serde(default)]
    pub fixed: Option<String>,
    pub target: TargetColumn,
    /// Take white space at both ends away.
    #[serde(default)]
    pub trim: bool,
    /// Numbers are written `1.234,56`.
    #[serde(default)]
    pub decimal_comma: bool,
    #[serde(default)]
    pub date_order: Option<DateOrder>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum OnError {
    /// The first row that cannot be written ends the import.
    #[default]
    Abort,
    /// It is left out and noted in the error file.
    Skip,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadPlan {
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    pub mappings: Vec<Mapping>,
    /// Texts that mean „no value“.
    #[serde(default)]
    pub null_texts: Vec<String>,
    /// An empty field is NULL (else an empty text).
    #[serde(default)]
    pub empty_is_null: bool,
    /// Delete every row of the table first.
    #[serde(default)]
    pub clear_first: bool,
    #[serde(default)]
    pub on_error: OnError,
    /// Everything in one transaction – all rows or none (only when errors end the import).
    #[serde(default)]
    pub whole_transaction: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowError {
    pub line: u64,
    pub reason: String,
}

/// How an import ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    /// Records read from the file.
    pub read: u64,
    /// Rows that are in the table now.
    pub written: u64,
    /// Records left out: not readable, not convertible, or refused by the database.
    pub skipped: u64,
    /// The first problems, for the report.
    pub errors: Vec<RowError>,
    /// The import was stopped by the user.
    pub cancelled: bool,
    /// The import ended early for an error (`errors` says which).
    pub failed: bool,
    /// Everything that had been written was taken back.
    pub rolled_back: bool,
    /// An error file was written.
    pub error_file: bool,
}

fn checked_plan(plan: &LoadPlan) -> AppResult<()> {
    if plan.mappings.is_empty() || plan.mappings.len() > MAX_TARGET_COLUMNS {
        return Err(invalid("an import needs one to 1000 columns"));
    }
    for (i, m) in plan.mappings.iter().enumerate() {
        if plan.mappings[..i]
            .iter()
            .any(|o| o.target.name == m.target.name)
        {
            return Err(invalid("a column of the table is filled twice"));
        }
    }
    Ok(())
}

fn table_of(kind: DbKind, schema: Option<&str>, table: &str) -> AppResult<String> {
    Ok(match schema.filter(|s| !s.is_empty()) {
        Some(schema) => format!("{}.{}", name(schema, kind)?, name(table, kind)?),
        None => name(table, kind)?,
    })
}

/// `1.234,56` → `1234.56`; spaces between the digits go.
fn decimal_point(text: &str) -> String {
    let t: String = text
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{2009}' && *c != '\u{202F}' && *c != '\'')
        .collect();
    if t.contains(',') {
        t.replace('.', "").replace(',', ".")
    } else {
        t
    }
}

/// A date written day first or month first as `yyyy-mm-dd`, a time behind it kept. What is a date
/// already stays. `None`: not a date in that order.
fn iso_date(text: &str, order: DateOrder) -> Option<String> {
    let t = text.trim();
    let (date, time) = match t.find([' ', 'T']) {
        Some(at) => (&t[..at], &t[at..]),
        None => (t, ""),
    };
    let parts: Vec<&str> = date.split(['.', '/', '-']).collect();
    let [a, b, c] = parts.as_slice() else {
        return None;
    };
    let digits = |s: &str, n: std::ops::RangeInclusive<usize>| {
        n.contains(&s.len()) && s.bytes().all(|x| x.is_ascii_digit())
    };
    // already year first
    if digits(a, 4..=4) && digits(b, 1..=2) && digits(c, 1..=2) {
        return Some(format!("{a}-{b:0>2}-{c:0>2}{time}"));
    }
    if !digits(a, 1..=2) || !digits(b, 1..=2) || !digits(c, 4..=4) {
        return None;
    }
    let (day, month) = match order {
        DateOrder::Dmy => (a, b),
        DateOrder::Mdy => (b, a),
    };
    let (d, m): (u32, u32) = (day.parse().ok()?, month.parse().ok()?);
    if !(1..=31).contains(&d) || !(1..=12).contains(&m) {
        return None;
    }
    Some(format!("{c}-{month:0>2}-{day:0>2}{time}"))
}

/// The row a record of the file becomes. `Err`: why it cannot be one.
pub fn convert(record: &Record, plan: &LoadPlan) -> Result<RowInsert, String> {
    let mut set = Vec::with_capacity(plan.mappings.len());
    for m in &plan.mappings {
        let raw: Option<&str> = match m.source {
            // a record with fewer fields than the others: what is missing is empty
            Some(i) => record.cells.get(i).map_or(Some(""), |c| c.as_deref()),
            None => m.fixed.as_deref(),
        };
        let mut value: Option<String> = raw.map(|v| {
            if m.trim {
                v.trim().to_owned()
            } else {
                v.to_owned()
            }
        });
        // the fixed value is what the user typed: taken as it is
        if m.source.is_some()
            && let Some(v) = &value
            && ((v.is_empty() && plan.empty_is_null) || plan.null_texts.iter().any(|n| n == v))
        {
            value = None;
        }
        if let Some(v) = value.as_mut() {
            if v.len() > edit::MAX_VALUE_BYTES {
                return Err(format!("{}: the value is too long", m.target.name));
            }
            if m.decimal_comma && m.target.kind == ValueKind::Number {
                *v = decimal_point(v);
            }
            if let Some(order) = m.date_order {
                *v = iso_date(v, order).ok_or_else(|| format!("{}: not a date", m.target.name))?;
            }
        }
        set.push(SetCell {
            column: m.target.name.clone(),
            kind: m.target.kind,
            type_name: m.target.type_name.clone(),
            value,
            default: false,
        });
    }
    Ok(RowInsert { set })
}

/// The `INSERT` of one row of the plan, with every column bound: what the guard of the connection is
/// asked about (the statements that run differ from it only in how many rows they carry).
pub fn shape(kind: DbKind, plan: &LoadPlan) -> AppResult<Built> {
    checked_plan(plan)?;
    let row = RowInsert {
        set: plan
            .mappings
            .iter()
            .map(|m| SetCell {
                column: m.target.name.clone(),
                kind: m.target.kind,
                type_name: m.target.type_name.clone(),
                value: Some(String::new()),
                default: false,
            })
            .collect(),
    };
    let mut steps = edit::steps(kind, &edit_plan(plan, vec![row]))?;
    Ok(steps.remove(0).built)
}

/// The statement that empties the table: a `DELETE` (it can be rolled back everywhere).
pub fn clear_statement(kind: DbKind, plan: &LoadPlan) -> AppResult<String> {
    Ok(format!(
        "DELETE FROM {}",
        table_of(kind, plan.schema.as_deref(), &plan.table)?
    ))
}

fn edit_plan(plan: &LoadPlan, inserts: Vec<RowInsert>) -> UpdatePlan {
    UpdatePlan {
        schema: plan.schema.clone(),
        table: plan.table.clone(),
        inserts,
        ..UpdatePlan::default()
    }
}

/// A `CREATE TABLE` for the columns of a file with the types guessed for them – a proposal the user
/// reads and may change before it runs. Names are quoted; nothing of the file's values is in it.
pub fn create_table(
    kind: DbKind,
    schema: Option<&str>,
    table: &str,
    columns: &[(String, Guess)],
) -> AppResult<String> {
    if columns.is_empty() || columns.len() > MAX_TARGET_COLUMNS {
        return Err(invalid("a table needs one to 1000 columns"));
    }
    let type_of = |g: &Guess| -> String {
        // room for values longer than the ones seen
        let len = (g.max_len.max(1) * 2).clamp(20, 4000);
        match (g.kind, kind) {
            (GuessKind::Int, DbKind::Sqlite) => "integer".into(),
            (GuessKind::Int, _) => "bigint".into(),
            (GuessKind::Decimal, DbKind::Postgres | DbKind::Sqlite) => "numeric".into(),
            (GuessKind::Decimal, _) => "decimal(38, 10)".into(),
            (GuessKind::Bool, DbKind::Postgres | DbKind::Mysql) => "boolean".into(),
            (GuessKind::Bool, DbKind::Sqlserver) => "bit".into(),
            (GuessKind::Bool, DbKind::Sqlite) => "integer".into(),
            (GuessKind::Date, DbKind::Sqlite) => "text".into(),
            (GuessKind::Date, _) => "date".into(),
            (GuessKind::DateTime, DbKind::Postgres) => "timestamp".into(),
            (GuessKind::DateTime, DbKind::Mysql) => "datetime(6)".into(),
            (GuessKind::DateTime, DbKind::Sqlserver) => "datetime2".into(),
            (GuessKind::DateTime, DbKind::Sqlite) => "text".into(),
            (GuessKind::Text, DbKind::Postgres | DbKind::Sqlite) => "text".into(),
            (GuessKind::Text, DbKind::Mysql) if g.max_len <= 2000 => format!("varchar({len})"),
            (GuessKind::Text, DbKind::Mysql) => "longtext".into(),
            (GuessKind::Text, DbKind::Sqlserver) if g.max_len <= 2000 => format!("nvarchar({len})"),
            (GuessKind::Text, DbKind::Sqlserver) => "nvarchar(max)".into(),
        }
    };
    let mut lines = Vec::with_capacity(columns.len());
    for (i, (column, guess)) in columns.iter().enumerate() {
        if columns[..i].iter().any(|(other, _)| other == column) {
            return Err(invalid("two columns have the same name"));
        }
        lines.push(format!("  {} {}", name(column, kind)?, type_of(guess)));
    }
    Ok(format!(
        "CREATE TABLE {} (\n{}\n)",
        table_of(kind, schema, table)?,
        lines.join(",\n")
    ))
}

/// Writes problems of single records: line, reason, and the record as it stands in the file.
struct ErrorFile<'a> {
    path: Option<&'a std::path::Path>,
    file: Option<std::io::BufWriter<std::fs::File>>,
}

impl ErrorFile<'_> {
    fn note(&mut self, line: u64, reason: &str, raw: &str) -> AppResult<()> {
        let Some(path) = self.path else {
            return Ok(());
        };
        let fail = |e: std::io::Error| AppError::new(ErrorCode::Io, format!("the error file: {e}"));
        if self.file.is_none() {
            let mut file = std::io::BufWriter::new(std::fs::File::create(path).map_err(fail)?);
            file.write_all(b"line\treason\trecord\n").map_err(fail)?;
            self.file = Some(file);
        }
        let flat = |s: &str| s.replace(['\t', '\n', '\r'], " ");
        if let Some(file) = self.file.as_mut() {
            writeln!(file, "{line}\t{}\t{}", flat(reason), flat(raw)).map_err(fail)?;
        }
        Ok(())
    }

    fn finish(&mut self) -> AppResult<bool> {
        match self.file.take() {
            Some(mut file) => {
                file.flush()
                    .map_err(|e| AppError::new(ErrorCode::Io, format!("the error file: {e}")))?;
                Ok(true)
            }
            None => Ok(false),
        }
    }
}

fn run(session: &mut dyn Session, sql: &str, stop: Stop) -> AppResult<()> {
    session.query(sql, Limits::rows(1), stop).map(|_| ())
}

/// One `INSERT` for some rows; `Ok(true)` if it made exactly those rows.
fn insert(
    session: &mut dyn Session,
    built: &Built,
    rows: usize,
    limits: Limits,
    stop: Stop,
) -> AppResult<bool> {
    let mut sink = VecSink::new(1);
    let outcome = session.execute_bound(&built.sql, &built.params, limits, &mut sink, stop)?;
    Ok(outcome.rows_affected == Some(rows as u64))
}

/// Loads the records of a file into the table of the plan.
///
/// - `whole_transaction` with [`OnError::Abort`]: one transaction – after an error or a stop the table is
///   as it was (`rolled_back`).
/// - otherwise block by block, each its own transaction: after an error or a stop the blocks written so
///   far stay. With [`OnError::Skip`] the rows of a block that fails are written one by one, and those
///   the database refuses are noted.
///
/// `progress` hears the records read so far; `stop` ends the import at the next block.
#[allow(clippy::too_many_arguments)]
pub fn load(
    session: &mut dyn Session,
    kind: DbKind,
    source: &mut Source,
    plan: &LoadPlan,
    error_file: Option<&std::path::Path>,
    timeout: Option<std::time::Duration>,
    progress: &dyn Fn(u64),
    stop: Stop,
) -> AppResult<Loaded> {
    checked_plan(plan)?;
    let width = plan.mappings.len();
    let block = edit::MAX_BATCH_ROWS.min((MAX_PARAMS / width).max(1));
    let limits = Limits {
        max_rows: 1,
        timeout,
    };
    let skip = plan.on_error == OnError::Skip;
    let whole = plan.whole_transaction && !skip;
    let mut out = Loaded::default();
    let mut errors = ErrorFile {
        path: error_file,
        file: None,
    };
    let note = |out: &mut Loaded, errors: &mut ErrorFile, line: u64, reason: String, raw: &str| {
        out.skipped += 1;
        errors.note(line, &reason, raw)?;
        if out.errors.len() < REPORTED_ERRORS {
            out.errors.push(RowError { line, reason });
        }
        Ok::<(), AppError>(())
    };
    let begin = begin_statement(kind);
    let mut in_tx = false;
    if whole {
        run(session, begin, &|| false)?;
        in_tx = true;
    }
    if plan.clear_first {
        let clear = clear_statement(kind, plan)?;
        if let Err(e) = run(session, &clear, stop) {
            if in_tx && session.is_open() {
                let _ = run(session, "ROLLBACK", &|| false);
            }
            if e.code != ErrorCode::Cancelled {
                return Err(e);
            }
            // stopped while the table was being emptied: a statement that is stopped has changed
            // nothing
            out.cancelled = true;
            out.rolled_back = whole;
            return Ok(out);
        }
    }
    // (line, row, the record as it stands in the file)
    let mut pending: Vec<(u64, RowInsert, String)> = Vec::with_capacity(block);
    let mut ended = false;
    'records: loop {
        // fill a block
        while pending.len() < block && !ended {
            match source.next_record() {
                Ok(Some(Ok(record))) => {
                    out.read += 1;
                    match convert(&record, plan) {
                        Ok(row) => pending.push((record.line, row, record.raw)),
                        Err(reason) => {
                            note(&mut out, &mut errors, record.line, reason, &record.raw)?;
                            if !skip {
                                out.failed = true;
                                break 'records;
                            }
                        }
                    }
                }
                Ok(Some(Err((line, reason, raw)))) => {
                    out.read += 1;
                    note(&mut out, &mut errors, line, reason, &raw)?;
                    if !skip {
                        out.failed = true;
                        break 'records;
                    }
                }
                Ok(None) => ended = true,
                // the file itself cannot be read on: that ends the import whatever the mode
                Err(e) => {
                    note(&mut out, &mut errors, 0, e.message.clone(), "")?;
                    out.skipped -= 1;
                    out.failed = true;
                    break 'records;
                }
            }
        }
        if stop() {
            out.cancelled = true;
            break;
        }
        if pending.is_empty() {
            break;
        }
        let rows: Vec<RowInsert> = pending.iter().map(|(_, row, _)| row.clone()).collect();
        let steps = edit::steps(kind, &edit_plan(plan, rows))?;
        if !whole {
            run(session, begin, &|| false)?;
            in_tx = true;
        }
        let mut problem: Option<AppError> = None;
        for step in &steps {
            match insert(session, &step.built, step.rows, limits, stop) {
                Ok(true) => {}
                Ok(false) => {
                    problem = Some(AppError::new(
                        ErrorCode::InvalidQuery,
                        "the table did not take all rows of a statement",
                    ));
                    break;
                }
                Err(e) => {
                    problem = Some(e);
                    break;
                }
            }
        }
        match problem {
            None => {
                if !whole {
                    run(session, "COMMIT", &|| false)?;
                    in_tx = false;
                }
                out.written += pending.len() as u64;
            }
            Some(e) if e.code == ErrorCode::Cancelled => {
                out.cancelled = true;
                break;
            }
            Some(e) => {
                if !whole && session.is_open() {
                    let _ = run(session, "ROLLBACK", &|| false);
                    in_tx = false;
                }
                if !session.is_open() {
                    return Err(e);
                }
                if !skip {
                    // which rows it was, as far as that is known: the lines of the block
                    let first = pending.first().map_or(0, |p| p.0);
                    let last = pending.last().map_or(0, |p| p.0);
                    let reason = if first == last {
                        e.message.clone()
                    } else {
                        format!("{} (one of the lines {first}–{last})", e.message)
                    };
                    out.errors.push(RowError {
                        line: first,
                        reason: reason.clone(),
                    });
                    errors.note(first, &reason, "")?;
                    out.failed = true;
                    break;
                }
                // every row of the block on its own: what the database takes stays, the rest is noted
                let singles = edit::single_inserts(
                    kind,
                    &edit_plan(plan, pending.iter().map(|p| p.1.clone()).collect()),
                    0,
                    pending.len(),
                )?;
                for (single, (line, _, raw)) in singles.iter().zip(&pending) {
                    if stop() {
                        out.cancelled = true;
                        break 'records;
                    }
                    match insert(session, single, 1, limits, stop) {
                        Ok(true) => out.written += 1,
                        Ok(false) => note(
                            &mut out,
                            &mut errors,
                            *line,
                            "the table did not take the row".into(),
                            raw,
                        )?,
                        Err(e) if e.code == ErrorCode::Cancelled => {
                            out.cancelled = true;
                            break 'records;
                        }
                        Err(e) => {
                            if !session.is_open() {
                                return Err(e);
                            }
                            note(&mut out, &mut errors, *line, e.message.clone(), raw)?;
                        }
                    }
                }
            }
        }
        pending.clear();
        progress(out.read);
        if ended {
            break;
        }
    }
    // the end: one transaction is committed only if nothing went wrong (a connection that is gone has
    // taken its transaction with it)
    if whole {
        if out.failed || out.cancelled || !session.is_open() {
            if session.is_open() {
                let _ = run(session, "ROLLBACK", &|| false);
            }
            out.rolled_back = true;
            out.written = 0;
        } else {
            run(session, "COMMIT", &|| false)?;
        }
    } else if in_tx && session.is_open() {
        let _ = run(session, "ROLLBACK", &|| false);
    }
    progress(out.read);
    out.error_file = errors.finish()?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_import::SourceOptions;
    use crate::db::sqlite;
    use tempfile::tempdir;

    const ALL: [DbKind; 4] = [
        DbKind::Postgres,
        DbKind::Mysql,
        DbKind::Sqlserver,
        DbKind::Sqlite,
    ];

    fn target(name: &str, kind: ValueKind) -> TargetColumn {
        TargetColumn {
            name: name.into(),
            kind,
            type_name: String::new(),
        }
    }

    fn map(source: usize, name: &str, kind: ValueKind) -> Mapping {
        Mapping {
            source: Some(source),
            fixed: None,
            target: target(name, kind),
            trim: false,
            decimal_comma: false,
            date_order: None,
        }
    }

    fn plan(mappings: Vec<Mapping>) -> LoadPlan {
        LoadPlan {
            schema: None,
            table: "people".into(),
            mappings,
            null_texts: vec!["NULL".into()],
            empty_is_null: true,
            clear_first: false,
            on_error: OnError::Abort,
            whole_transaction: true,
        }
    }

    fn record(cells: &[Option<&str>]) -> Record {
        Record {
            line: 1,
            cells: cells.iter().map(|c| c.map(str::to_owned)).collect(),
            raw: String::new(),
        }
    }

    #[test]
    fn turns_a_record_into_a_row_through_the_mapping() {
        let mut p = plan(vec![
            Mapping {
                trim: true,
                ..map(1, "name", ValueKind::Text)
            },
            Mapping {
                decimal_comma: true,
                ..map(0, "amount", ValueKind::Number)
            },
            Mapping {
                date_order: Some(DateOrder::Dmy),
                ..map(2, "day", ValueKind::Text)
            },
            Mapping {
                source: None,
                fixed: Some("import 7".into()),
                ..map(0, "origin", ValueKind::Text)
            },
            map(9, "missing", ValueKind::Text),
        ]);
        let row = convert(
            &record(&[Some("1.234,50"), Some("  Ada "), Some("5.3.2026 10:30")]),
            &p,
        )
        .unwrap();
        let values: Vec<Option<&str>> = row.set.iter().map(|c| c.value.as_deref()).collect();
        assert_eq!(
            values,
            [
                Some("Ada"),
                Some("1234.50"),
                Some("2026-03-05 10:30"),
                Some("import 7"),
                None
            ]
        );
        assert_eq!(row.set[1].column, "amount");
        // no value: an empty field, a null text, a JSON null – but not an empty field when it is a text
        let none = convert(
            &record(&[Some(""), Some("NULL"), None]),
            &plan(vec![
                map(0, "a", ValueKind::Text),
                map(1, "b", ValueKind::Text),
                map(2, "c", ValueKind::Text),
            ]),
        )
        .unwrap();
        assert!(none.set.iter().all(|c| c.value.is_none()));
        p.empty_is_null = false;
        p.mappings = vec![map(0, "a", ValueKind::Text)];
        assert_eq!(
            convert(&record(&[Some("")]), &p).unwrap().set[0]
                .value
                .as_deref(),
            Some("")
        );
        // a date that is none in that order is a problem of the row
        let dated = plan(vec![Mapping {
            date_order: Some(DateOrder::Mdy),
            ..map(0, "day", ValueKind::Text)
        }]);
        assert_eq!(
            convert(&record(&[Some("11/30/2026")]), &dated).unwrap().set[0]
                .value
                .as_deref(),
            Some("2026-11-30")
        );
        assert!(convert(&record(&[Some("30/11/2026")]), &dated).is_err());
        assert_eq!(
            convert(&record(&[Some("2026-1-5")]), &dated).unwrap().set[0]
                .value
                .as_deref(),
            Some("2026-01-05")
        );
        assert_eq!(decimal_point("1 234.5"), "1234.5");
        // a value no statement would take is a problem of its row, not of the import
        let long = "x".repeat(edit::MAX_VALUE_BYTES + 1);
        assert!(
            convert(
                &record(&[Some(&long)]),
                &plan(vec![map(0, "a", ValueKind::Text)])
            )
            .is_err()
        );
    }

    #[test]
    fn nothing_of_a_file_becomes_sql() {
        // names of columns and values that try: quoted, bound, or refused – never executed
        for kind in ALL {
            let p = plan(vec![
                map(0, "name\"; DROP TABLE people; --", ValueKind::Text),
                map(
                    1,
                    "x`]) VALUES (1); DELETE FROM people; --",
                    ValueKind::Number,
                ),
            ]);
            let built = shape(kind, &p).unwrap();
            assert_eq!(built.sql.matches("INSERT INTO").count(), 1, "{kind:?}");
            assert_eq!(built.params.len(), 2, "{kind:?}");
            // what is behind the names is two placeholders and nothing else
            let tail = built.sql.rsplit("VALUES").next().unwrap();
            assert!(
                !tail.contains("DROP") && !tail.contains("DELETE"),
                "{kind:?}: {}",
                built.sql
            );
            let ddl = create_table(
                kind,
                Some("s\"x"),
                "t; DROP TABLE x",
                &[(
                    "a\"); DROP TABLE y; --".into(),
                    Guess {
                        kind: GuessKind::Text,
                        max_len: 5,
                        nullable: true,
                    },
                )],
            )
            .unwrap();
            assert_eq!(ddl.matches("CREATE TABLE").count(), 1);
            assert!(ddl.lines().count() == 3, "{ddl}");
            assert!(
                clear_statement(kind, &plan(vec![map(0, "a", ValueKind::Text)]))
                    .unwrap()
                    .starts_with("DELETE FROM ")
            );
        }
        let refused = |p: LoadPlan| shape(DbKind::Postgres, &p).is_err();
        assert!(refused(plan(vec![])));
        assert!(refused(plan(vec![
            map(0, "a", ValueKind::Text),
            map(1, "a", ValueKind::Text)
        ])));
        assert!(refused(plan(vec![map(0, "", ValueKind::Text)])));
        assert!(refused(plan(vec![map(0, "a\0b", ValueKind::Text)])));
        assert!(create_table(DbKind::Postgres, None, "t", &[]).is_err());
    }

    #[test]
    fn proposes_a_table_with_the_types_of_the_dialect() {
        let g = |kind, max_len| Guess {
            kind,
            max_len,
            nullable: false,
        };
        let columns = vec![
            ("id".to_owned(), g(GuessKind::Int, 3)),
            ("Order Total".to_owned(), g(GuessKind::Decimal, 8)),
            ("ok".to_owned(), g(GuessKind::Bool, 5)),
            ("at".to_owned(), g(GuessKind::DateTime, 19)),
            ("note".to_owned(), g(GuessKind::Text, 40)),
        ];
        assert_eq!(
            create_table(DbKind::Postgres, Some("shop"), "orders", &columns).unwrap(),
            "CREATE TABLE shop.orders (\n  id bigint,\n  \"Order Total\" numeric,\n  ok boolean,\n  at timestamp,\n  note text\n)"
        );
        let ms = create_table(DbKind::Sqlserver, None, "orders", &columns).unwrap();
        assert!(
            ms.contains("[Order Total] decimal(38, 10)")
                && ms.contains("ok bit")
                && ms.contains("note nvarchar(80)")
        );
        let my = create_table(DbKind::Mysql, None, "orders", &columns).unwrap();
        assert!(my.contains("at datetime(6)") && my.contains("note varchar(80)"));
        assert!(
            create_table(DbKind::Sqlite, None, "orders", &columns)
                .unwrap()
                .contains("id integer")
        );
    }

    fn csv(dir: &std::path::Path, text: &str) -> Source {
        let path = dir.join("in.csv");
        std::fs::write(&path, text).unwrap();
        Source::open(&path, &SourceOptions::default()).unwrap()
    }

    fn people(s: &mut sqlite::Lite) -> serde_json::Value {
        let r = s
            .query(
                "SELECT id, name, age FROM people ORDER BY id",
                Limits::rows(100_000),
                &|| false,
            )
            .unwrap();
        serde_json::to_value(&r.rows).unwrap()
    }

    fn maps() -> Vec<Mapping> {
        vec![
            map(0, "id", ValueKind::Number),
            map(1, "name", ValueKind::Text),
            map(2, "age", ValueKind::Number),
        ]
    }

    #[test]
    fn loads_a_file_all_or_nothing_or_row_by_row() {
        use serde_json::json;
        let dir = tempdir().unwrap();
        let mut s = sqlite::open(&sqlite::demo_profile()).unwrap();
        s.execute_batch_for_tests(
            "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER CHECK (age < 150));
             INSERT INTO people VALUES (100, 'there before', 1);",
        );
        let good = "id,name,age\n1,\"O'Hara; DROP TABLE people; --\",40\n2,Bob,\n3,ä😀,7\n";
        let bad = "id,name,age\n4,Dee,30\n5,,31\n6,Old,200\n7,Fay,33\n";
        let none = |_: u64| {};
        // one transaction: all rows
        let done = load(
            &mut s,
            DbKind::Sqlite,
            &mut csv(dir.path(), good),
            &plan(maps()),
            None,
            None,
            &none,
            &|| false,
        )
        .unwrap();
        assert_eq!(
            (done.read, done.written, done.skipped, done.failed),
            (3, 3, 0, false)
        );
        assert_eq!(
            people(&mut s),
            json!([
                [1, "O'Hara; DROP TABLE people; --", 40],
                [2, "Bob", null],
                [3, "ä😀", 7],
                [100, "there before", 1]
            ])
        );
        // one transaction and a row the table refuses: nothing of the file is written
        let errors = dir.path().join("errors.tsv");
        let failed = load(
            &mut s,
            DbKind::Sqlite,
            &mut csv(dir.path(), bad),
            &plan(maps()),
            Some(&errors),
            None,
            &none,
            &|| false,
        )
        .unwrap();
        assert!(failed.failed && failed.rolled_back);
        assert_eq!(failed.written, 0);
        assert_eq!(failed.errors.len(), 1);
        assert!(
            failed.errors[0].reason.contains("lines 2–5"),
            "{:?}",
            failed.errors
        );
        assert_eq!(people(&mut s).as_array().unwrap().len(), 4);
        // skipping: the rows the table takes are in, the others in the error file with line and record
        let skipping = LoadPlan {
            on_error: OnError::Skip,
            ..plan(maps())
        };
        let skipped = load(
            &mut s,
            DbKind::Sqlite,
            &mut csv(dir.path(), bad),
            &skipping,
            Some(&errors),
            None,
            &none,
            &|| false,
        )
        .unwrap();
        assert_eq!((skipped.read, skipped.written, skipped.skipped), (4, 2, 2));
        assert!(skipped.error_file && !skipped.failed && !skipped.rolled_back);
        assert_eq!(
            skipped.errors.iter().map(|e| e.line).collect::<Vec<_>>(),
            [3, 4]
        );
        let file = std::fs::read_to_string(&errors).unwrap();
        let lines: Vec<&str> = file.lines().collect();
        assert_eq!(lines[0], "line\treason\trecord");
        assert!(
            lines[1].starts_with("3\t") && lines[1].ends_with("\t5,,31"),
            "{file}"
        );
        assert!(
            lines[2].starts_with("4\t") && lines[2].ends_with("\t6,Old,200"),
            "{file}"
        );
        assert_eq!(people(&mut s).as_array().unwrap().len(), 6);
        // emptying first, in the same transaction: a failure leaves the table as it was
        let clearing = LoadPlan {
            clear_first: true,
            ..plan(maps())
        };
        let kept = load(
            &mut s,
            DbKind::Sqlite,
            &mut csv(dir.path(), bad),
            &clearing,
            None,
            None,
            &none,
            &|| false,
        )
        .unwrap();
        assert!(kept.rolled_back);
        assert_eq!(people(&mut s).as_array().unwrap().len(), 6);
        let cleared = load(
            &mut s,
            DbKind::Sqlite,
            &mut csv(dir.path(), good),
            &clearing,
            None,
            None,
            &none,
            &|| false,
        )
        .unwrap();
        assert_eq!(cleared.written, 3);
        assert_eq!(people(&mut s).as_array().unwrap().len(), 3);
    }

    #[test]
    fn loads_many_rows_block_by_block_and_stops_when_asked() {
        let dir = tempdir().unwrap();
        let mut s = sqlite::open(&sqlite::demo_profile()).unwrap();
        s.execute_batch_for_tests(
            "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, age INTEGER);",
        );
        let text: String = std::iter::once("id,name,age\n".to_owned())
            .chain((1..=20_000).map(|i| format!("{i},name {i},{}\n", i % 90)))
            .collect();
        let seen = std::cell::Cell::new(0u64);
        let blocks = LoadPlan {
            whole_transaction: false,
            ..plan(maps())
        };
        let done = load(
            &mut s,
            DbKind::Sqlite,
            &mut csv(dir.path(), &text),
            &blocks,
            None,
            None,
            &|n| seen.set(n),
            &|| false,
        )
        .unwrap();
        assert_eq!((done.read, done.written), (20_000, 20_000));
        assert_eq!(seen.get(), 20_000);
        let count = |s: &mut sqlite::Lite| {
            let r = s
                .query(
                    "SELECT COUNT(*), SUM(age) FROM people",
                    Limits::rows(1),
                    &|| false,
                )
                .unwrap();
            serde_json::to_value(&r.rows).unwrap()
        };
        assert_eq!(count(&mut s)[0][0], 20_000);
        // stopped in one transaction: nothing stays
        s.execute_batch_for_tests("DELETE FROM people;");
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let stop_later = || calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed) >= 30;
        let stopped = load(
            &mut s,
            DbKind::Sqlite,
            &mut csv(dir.path(), &text),
            &plan(maps()),
            None,
            None,
            &|_| {},
            &stop_later,
        )
        .unwrap();
        assert!(stopped.cancelled && stopped.rolled_back);
        assert_eq!(count(&mut s)[0][0], 0);
        // stopped block by block: the blocks written so far stay, and the report says how many rows
        calls.store(0, std::sync::atomic::Ordering::Relaxed);
        let partly = load(
            &mut s,
            DbKind::Sqlite,
            &mut csv(dir.path(), &text),
            &blocks,
            None,
            None,
            &|_| {},
            &stop_later,
        )
        .unwrap();
        assert!(partly.cancelled && !partly.rolled_back);
        assert!(partly.written > 0 && partly.written < 20_000);
        assert_eq!(count(&mut s)[0][0], partly.written);
    }
}
