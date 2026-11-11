//! What a statement returns (prompt 003): columns with a kind, and cells as they cross the bridge.
//!
//! A cell is JSON without loss: `null`, a boolean, a number (integers only within ±2^53, finite floats),
//! or text. What JSON numbers cannot hold exactly travels as text – 64-bit integers beyond 2^53, decimals,
//! dates and times (ISO), UUIDs, JSON. Binary data is its length and its first bytes. The column's
//! [`ColKind`] says how to read a text cell.

use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime};
use serde::Serialize;

/// Text of a cell at most, in characters; longer values are cut and marked (prompt 006 brings the rest on
/// request).
pub const MAX_TEXT_CHARS: usize = 32 * 1024;
/// Bytes of a binary value shown as hex.
pub const BYTES_PREVIEW: usize = 16;
/// Integers JSON numbers hold exactly.
const MAX_SAFE_INT: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ColKind {
    Int,
    Float,
    /// Exact numbers: always text in the cell.
    Decimal,
    Bool,
    Text,
    Bytes,
    /// Date and time without a zone.
    Timestamp,
    /// An instant.
    TimestampTz,
    Date,
    Time,
    Json,
    Uuid,
    /// A type the driver does not know: its text form if there is one.
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    pub kind: ColKind,
    /// The type as the database names it (`INT4`, `VARCHAR`, `NVarchar` …); empty when unknown.
    pub type_name: String,
}

/// A value as a driver read it.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Null,
    Bool(bool),
    I64(i64),
    U64(u64),
    F64(f64),
    Decimal(String),
    Text(String),
    /// Length and the first bytes.
    Bytes(usize, Vec<u8>),
    Ts(NaiveDateTime),
    TsTz(DateTime<FixedOffset>),
    Date(NaiveDate),
    Time(NaiveTime),
    Json(String),
    Uuid(String),
    /// A value the driver could not read; the text names its type.
    Unreadable(String),
}

impl Cell {
    pub fn bytes(b: &[u8]) -> Cell {
        Cell::Bytes(b.len(), b[..b.len().min(BYTES_PREVIEW)].to_vec())
    }

    /// Roughly what the value takes in memory and on the bridge.
    pub fn size(&self) -> usize {
        match self {
            Cell::Text(s) | Cell::Json(s) | Cell::Decimal(s) | Cell::Uuid(s) => 8 + s.len(),
            Cell::Unreadable(s) => 8 + s.len(),
            Cell::Bytes(_, head) => 16 + head.len() * 2,
            _ => 16,
        }
    }
}

impl Serialize for Cell {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            Cell::Null => s.serialize_unit(),
            Cell::Bool(b) => s.serialize_bool(*b),
            Cell::I64(n) if (-MAX_SAFE_INT..=MAX_SAFE_INT).contains(n) => s.serialize_i64(*n),
            Cell::I64(n) => s.serialize_str(&n.to_string()),
            Cell::U64(n) if *n <= MAX_SAFE_INT as u64 => s.serialize_u64(*n),
            Cell::U64(n) => s.serialize_str(&n.to_string()),
            Cell::F64(f) if f.is_finite() => s.serialize_f64(*f),
            // NaN and the infinities have no JSON number
            Cell::F64(f) => s.serialize_str(&f.to_string()),
            Cell::Decimal(t) | Cell::Text(t) | Cell::Json(t) | Cell::Uuid(t) => s.serialize_str(t),
            Cell::Ts(t) => s.serialize_str(&t.format("%Y-%m-%d %H:%M:%S%.f").to_string()),
            Cell::TsTz(t) => s.serialize_str(&t.format("%Y-%m-%d %H:%M:%S%.f%:z").to_string()),
            Cell::Date(d) => s.serialize_str(&d.format("%Y-%m-%d").to_string()),
            Cell::Time(t) => s.serialize_str(&t.format("%H:%M:%S%.f").to_string()),
            Cell::Bytes(len, head) => {
                let hex: String = head.iter().map(|b| format!("{b:02x}")).collect();
                let mut m = s.serialize_map(Some(2))?;
                m.serialize_entry("bytes", len)?;
                m.serialize_entry("hex", &hex)?;
                m.end()
            }
            Cell::Unreadable(type_name) => {
                let mut m = s.serialize_map(Some(1))?;
                m.serialize_entry("unreadable", type_name)?;
                m.end()
            }
        }
    }
}

/// The rows of a statement, all in memory (see [`VecSink`]).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Cell>>,
    /// More rows existed than were read (row or memory limit).
    pub truncated: bool,
    /// Rows changed by a statement without a result; `None` for a statement with one (or when the
    /// database does not say).
    pub rows_affected: Option<u64>,
    pub elapsed_ms: u64,
}

/// Where a driver puts the rows of a statement as they arrive (prompt 006).
pub trait RowSink: Send {
    /// The statement has a result with these columns. Called once, before the first row.
    fn start(&mut self, columns: &[Column]);
    /// A row. `false`: no more rows are wanted (a limit was reached, or the sink failed).
    fn row(&mut self, cells: Vec<Cell>) -> bool;
}

/// How a statement ended; its rows went into the sink.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub columns: Vec<Column>,
    /// Rows handed to the sink.
    pub rows: u64,
    /// The sink did not want all rows.
    pub truncated: bool,
    /// Rows changed by a statement without a result; `None` for a statement with one (or when the database
    /// does not say).
    pub rows_affected: Option<u64>,
    pub elapsed_ms: u64,
}

/// A sink that keeps the rows in memory, up to a number of rows and [`MAX_RESULT_BYTES`]: for the app's own
/// small questions and for tests.
pub struct VecSink {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Cell>>,
    max_rows: usize,
    budget: Budget,
}

impl VecSink {
    pub fn new(max_rows: usize) -> Self {
        Self {
            columns: Vec::new(),
            rows: Vec::new(),
            max_rows,
            budget: Budget::default(),
        }
    }
}

impl RowSink for VecSink {
    fn start(&mut self, columns: &[Column]) {
        self.columns = columns.to_vec();
    }

    fn row(&mut self, cells: Vec<Cell>) -> bool {
        if self.rows.len() >= self.max_rows {
            return false;
        }
        let room = self.budget.add(&cells);
        self.rows.push(cells);
        room
    }
}

/// Rows a result holds at most; more are cut off and `truncated` says so.
pub const MAX_ROWS: usize = 100_000;
/// Memory of one result at most.
pub const MAX_RESULT_BYTES: usize = 256 * 1024 * 1024;

/// Counts what a result holds; true while there is room for another row.
#[derive(Debug, Default)]
pub struct Budget {
    pub bytes: usize,
}

impl Budget {
    pub fn add(&mut self, row: &[Cell]) -> bool {
        self.bytes += row.iter().map(Cell::size).sum::<usize>();
        self.bytes < MAX_RESULT_BYTES
    }
}

/// Text of a cell: cut at [`MAX_TEXT_CHARS`] with a mark.
pub fn text(s: &str) -> String {
    match s.char_indices().nth(MAX_TEXT_CHARS) {
        None => s.to_string(),
        Some((at, _)) => format!("{}…", &s[..at]),
    }
}

/// Bytes that should be UTF-8; anything else is replaced, never an error.
pub fn text_bytes(b: &[u8]) -> String {
    text(&String::from_utf8_lossy(b))
}

/// PostgreSQL's binary NUMERIC (ndigits, weight, sign, dscale, base-10000 digits) as text.
pub fn pg_numeric(bytes: &[u8]) -> Option<String> {
    let word = |i: usize| -> Option<i16> {
        Some(i16::from_be_bytes([*bytes.get(i)?, *bytes.get(i + 1)?]))
    };
    let ndigits = word(0)? as usize;
    let weight = word(2)? as i32;
    let sign = word(4)? as u16;
    let dscale = word(6)? as usize;
    match sign {
        0xC000 => return Some("NaN".into()),
        0xD000 => return Some("Infinity".into()),
        0xF000 => return Some("-Infinity".into()),
        0x0000 | 0x4000 => {}
        _ => return None,
    }
    if bytes.len() != 8 + ndigits * 2 || dscale > 1000 || ndigits > 1000 {
        return None;
    }
    let digits: Vec<u16> = (0..ndigits)
        .map(|k| word(8 + k * 2).map(|d| d as u16))
        .collect::<Option<_>>()?;
    if digits.iter().any(|&d| d > 9999) {
        return None;
    }
    let mut int = String::new();
    for w in 0..=weight.max(-1) {
        let d = digits.get(w as usize).copied().unwrap_or(0);
        if int.is_empty() {
            if d != 0 {
                int.push_str(&d.to_string());
            }
        } else {
            int.push_str(&format!("{d:04}"));
        }
    }
    if int.is_empty() {
        int.push('0');
    }
    let mut frac = String::new();
    let mut w = weight + 1;
    while frac.len() < dscale {
        let d = if w < 0 {
            0
        } else {
            digits.get(w as usize).copied().unwrap_or(0)
        };
        frac.push_str(&format!("{d:04}"));
        w += 1;
    }
    frac.truncate(dscale);
    let mut s = String::new();
    if sign == 0x4000 && (int != "0" || frac.chars().any(|c| c != '0')) {
        s.push('-');
    }
    s.push_str(&int);
    if !frac.is_empty() {
        s.push('.');
        s.push_str(&frac);
    }
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn j(cell: Cell) -> serde_json::Value {
        serde_json::to_value(cell).unwrap()
    }

    #[test]
    fn numbers_cross_the_bridge_without_loss() {
        assert_eq!(j(Cell::I64(42)), json!(42));
        assert_eq!(j(Cell::I64(MAX_SAFE_INT)), json!(9_007_199_254_740_991i64));
        assert_eq!(j(Cell::I64(i64::MAX)), json!("9223372036854775807"));
        assert_eq!(j(Cell::I64(i64::MIN)), json!("-9223372036854775808"));
        assert_eq!(j(Cell::U64(u64::MAX)), json!("18446744073709551615"));
        assert_eq!(j(Cell::F64(1.5)), json!(1.5));
        assert_eq!(j(Cell::F64(f64::NAN)), json!("NaN"));
        assert_eq!(j(Cell::F64(f64::INFINITY)), json!("inf"));
        assert_eq!(
            j(Cell::Decimal("12345678901234567890.123456789".into())),
            json!("12345678901234567890.123456789")
        );
    }

    #[test]
    fn null_is_not_text() {
        assert_eq!(j(Cell::Null), json!(null));
        assert_eq!(j(Cell::Text(String::new())), json!(""));
        assert_eq!(j(Cell::Text("NULL".into())), json!("NULL"));
        assert_eq!(j(Cell::Bool(false)), json!(false));
    }

    #[test]
    fn dates_are_iso_and_binary_is_a_length_with_a_head() {
        let d = NaiveDate::from_ymd_opt(2024, 2, 29).unwrap();
        let t = NaiveTime::from_hms_micro_opt(13, 5, 9, 250_000).unwrap();
        assert_eq!(j(Cell::Date(d)), json!("2024-02-29"));
        assert_eq!(j(Cell::Time(t)), json!("13:05:09.250"));
        assert_eq!(j(Cell::Ts(d.and_time(t))), json!("2024-02-29 13:05:09.250"));
        let zone = FixedOffset::east_opt(2 * 3600).unwrap();
        let tz = d.and_time(t).and_local_timezone(zone).unwrap();
        assert_eq!(j(Cell::TsTz(tz)), json!("2024-02-29 13:05:09.250+02:00"));
        let blob: Vec<u8> = (0u8..40).collect();
        assert_eq!(
            j(Cell::bytes(&blob)),
            json!({ "bytes": 40, "hex": "000102030405060708090a0b0c0d0e0f" })
        );
        assert_eq!(
            j(Cell::Unreadable("GEOMETRY".into())),
            json!({ "unreadable": "GEOMETRY" })
        );
    }

    #[test]
    fn long_text_is_cut_at_a_character() {
        let long = "ä".repeat(MAX_TEXT_CHARS + 10);
        let cut = text(&long);
        assert_eq!(cut.chars().count(), MAX_TEXT_CHARS + 1);
        assert!(cut.ends_with('…'));
        assert_eq!(text("kurz"), "kurz");
        assert_eq!(text_bytes(&[0x66, 0xff, 0x6f]), "f\u{fffd}o");
    }

    #[test]
    fn reads_postgres_binary_numerics() {
        // 12345.678: ndigits 3, weight 1, sign 0, dscale 3, digits 1, 2345, 6780
        let bytes = [0, 3, 0, 1, 0, 0, 0, 3, 0, 1, 0x09, 0x29, 0x1a, 0x7c];
        assert_eq!(pg_numeric(&bytes).as_deref(), Some("12345.678"));
        // 0 with scale 2
        assert_eq!(
            pg_numeric(&[0, 0, 0, 0, 0, 0, 0, 2]).as_deref(),
            Some("0.00")
        );
        // -1
        assert_eq!(
            pg_numeric(&[0, 1, 0, 0, 0x40, 0, 0, 0, 0, 1]).as_deref(),
            Some("-1")
        );
        // NaN
        assert_eq!(
            pg_numeric(&[0, 0, 0, 0, 0xc0, 0, 0, 0]).as_deref(),
            Some("NaN")
        );
        assert_eq!(pg_numeric(&[0, 1]), None);
    }
}
