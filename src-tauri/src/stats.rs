//! Figures of a selection of a result (prompt 028): how many cells, how many of them hold a value, how
//! many different ones, and – for numbers – sum, mean, smallest and largest; for dates and times the
//! first, the last and the span; for text the shortest and the longest. Worked out here over the result
//! store: a selection can be millions of cells. Pure (no Tauri), tested below.
//!
//! Numbers are added **exactly**: every number of a result is decimal text (an integer, a `NUMERIC`, the
//! shortest form of a float), and [`Dec`] adds decimal digits – no binary floating point, no overflow at
//! 64 bits. The sum of a `NUMERIC(38,10)` column is the sum the database would give.

use crate::copy::{Selection, merge_rows, pick_columns};
use crate::db::value::ColKind;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::results::ResultStore;
use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime};
use serde::Serialize;
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

/// Different values counted at most; beyond, the count says „more than“.
pub const MAX_DISTINCT: usize = 5_000_000;
/// Different values remembered for „the most frequent“; beyond, new ones are not counted.
pub const MAX_TOP_KEYS: usize = 200_000;
/// Digits the mean has behind those of the sum.
const MEAN_DIGITS: usize = 6;

/// A decimal number of any length: sign, digits (most significant first, no leading zero except for a
/// lone `0`) and how many of them stand behind the point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dec {
    neg: bool,
    digits: Vec<u8>,
    scale: usize,
}

impl Dec {
    pub fn zero() -> Dec {
        Dec {
            neg: false,
            digits: vec![0],
            scale: 0,
        }
    }

    /// `-12.50`, `+3`, `.5`, `1e-7`, `2.5E3`; `None` for anything else (`NaN`, `Infinity`, text).
    pub fn parse(text: &str) -> Option<Dec> {
        let t = text.trim();
        let (neg, rest) = match t.as_bytes().first()? {
            b'-' => (true, &t[1..]),
            b'+' => (false, &t[1..]),
            _ => (false, t),
        };
        let (mantissa, exponent) = match rest.find(['e', 'E']) {
            Some(at) => (&rest[..at], rest[at + 1..].parse::<i64>().ok()?),
            None => (rest, 0),
        };
        let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
        if int.is_empty() && frac.is_empty() {
            return None;
        }
        if !int.bytes().chain(frac.bytes()).all(|b| b.is_ascii_digit()) {
            return None;
        }
        if int.len() + frac.len() > 4000 || exponent.unsigned_abs() > 4000 {
            return None;
        }
        let mut digits: Vec<u8> = int.bytes().chain(frac.bytes()).map(|b| b - b'0').collect();
        let mut scale = frac.len() as i64 - exponent;
        if scale < 0 {
            digits.extend(std::iter::repeat_n(0, (-scale) as usize));
            scale = 0;
        }
        let mut dec = Dec {
            neg,
            digits,
            scale: scale as usize,
        };
        dec.normalise();
        Some(dec)
    }

    /// At least one digit before the point, no leading zeros, no negative zero.
    fn normalise(&mut self) {
        while self.digits.len() <= self.scale {
            self.digits.insert(0, 0);
        }
        let lead = self
            .digits
            .iter()
            .take(self.digits.len() - self.scale - 1)
            .take_while(|d| **d == 0)
            .count();
        self.digits.drain(..lead);
        if self.digits.iter().all(|d| *d == 0) {
            self.neg = false;
        }
    }

    /// The digits of both with the same scale.
    fn aligned(&self, other: &Dec) -> (Vec<u8>, Vec<u8>, usize) {
        let scale = self.scale.max(other.scale);
        let pad = |d: &Dec| {
            let mut v = d.digits.clone();
            v.extend(std::iter::repeat_n(0, scale - d.scale));
            v
        };
        let (mut a, mut b) = (pad(self), pad(other));
        let len = a.len().max(b.len());
        for v in [&mut a, &mut b] {
            let missing = len - v.len();
            v.splice(0..0, std::iter::repeat_n(0, missing));
        }
        (a, b, scale)
    }

    fn cmp_abs(a: &[u8], b: &[u8]) -> Ordering {
        a.cmp(b)
    }

    pub fn add(&self, other: &Dec) -> Dec {
        let (a, b, scale) = self.aligned(other);
        let (neg, digits) = if self.neg == other.neg {
            let mut out = vec![0u8; a.len() + 1];
            let mut carry = 0;
            for i in (0..a.len()).rev() {
                let sum = a[i] + b[i] + carry;
                out[i + 1] = sum % 10;
                carry = sum / 10;
            }
            out[0] = carry;
            (self.neg, out)
        } else {
            // the larger one decides the sign; the smaller is taken from it
            let (big, small, neg) = if Self::cmp_abs(&a, &b) == Ordering::Less {
                (b, a, other.neg)
            } else {
                (a, b, self.neg)
            };
            let mut out = vec![0u8; big.len()];
            let mut borrow = 0i8;
            for i in (0..big.len()).rev() {
                let mut d = big[i] as i8 - small[i] as i8 - borrow;
                borrow = i8::from(d < 0);
                if d < 0 {
                    d += 10;
                }
                out[i] = d as u8;
            }
            (neg, out)
        };
        let mut dec = Dec { neg, digits, scale };
        dec.normalise();
        dec
    }

    /// The number divided by a count, with [`MEAN_DIGITS`] more digits, rounded half away from zero.
    pub fn div(&self, by: u64) -> Dec {
        if by == 0 {
            return Dec::zero();
        }
        let mut digits = self.digits.clone();
        digits.extend(std::iter::repeat_n(0, MEAN_DIGITS));
        let mut out = Vec::with_capacity(digits.len());
        let mut rem: u128 = 0;
        for d in digits {
            rem = rem * 10 + u128::from(d);
            out.push((rem / u128::from(by)) as u8);
            rem %= u128::from(by);
        }
        let mut dec = Dec {
            neg: self.neg,
            digits: out,
            scale: self.scale + MEAN_DIGITS,
        };
        if rem * 2 >= u128::from(by) {
            let one = Dec {
                neg: self.neg,
                digits: vec![1],
                scale: dec.scale,
            };
            dec.normalise();
            let mut unit = one;
            unit.normalise();
            dec = dec.add(&unit);
        }
        dec.normalise();
        // the digits added for the division that say nothing go again
        let mut cut = 0;
        while cut < MEAN_DIGITS
            && dec.digits.len() > 1
            && dec.digits[dec.digits.len() - 1 - cut] == 0
        {
            cut += 1;
        }
        dec.digits.truncate(dec.digits.len() - cut);
        dec.scale -= cut;
        dec.normalise();
        dec
    }

    /// Which is the larger; `1.50` and `1.5` are equal here.
    pub fn order(&self, other: &Dec) -> Ordering {
        match (self.neg, other.neg) {
            (false, true) => Ordering::Greater,
            (true, false) => Ordering::Less,
            (neg, _) => {
                let (a, b, _) = self.aligned(other);
                let abs = Self::cmp_abs(&a, &b);
                if neg { abs.reverse() } else { abs }
            }
        }
    }
}

impl std::fmt::Display for Dec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text: String = self.digits.iter().map(|d| (b'0' + d) as char).collect();
        let (int, frac) = text.split_at(text.len() - self.scale);
        if self.neg {
            f.write_str("-")?;
        }
        f.write_str(int)?;
        if !frac.is_empty() {
            write!(f, ".{frac}")?;
        }
        Ok(())
    }
}

/// A value and how often it occurs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frequent {
    /// `None` = NULL.
    pub value: Option<String>,
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Cells looked at.
    pub cells: u64,
    pub non_null: u64,
    /// Different values among those that are not NULL.
    pub distinct: u64,
    /// There are more different values than were counted.
    pub distinct_capped: bool,
    /// Cells that are numbers; sum, mean, min and max are theirs.
    pub numbers: u64,
    /// Cells with a value that is no number, while others are: not part of the number figures.
    pub ignored: u64,
    pub sum: Option<String>,
    pub mean: Option<String>,
    pub min: Option<String>,
    pub max: Option<String>,
    /// Dates and times: the first and the last as they are written, and what lies between in milliseconds
    /// (`None` when the cells are of different kinds of time).
    pub first: Option<String>,
    pub last: Option<String>,
    pub span_ms: Option<i64>,
    /// Texts: characters of the shortest and the longest.
    pub shortest: Option<u64>,
    pub longest: Option<u64>,
    /// The most frequent values (only when asked for), the most frequent first.
    pub top: Vec<Frequent>,
    /// More different values than were remembered: the list may miss some.
    pub top_partial: bool,
}

/// A moment for comparing: milliseconds on one line of time per kind.
fn moment(text: &str, kind: ColKind) -> Option<i64> {
    match kind {
        ColKind::Date => NaiveDate::parse_from_str(text, "%Y-%m-%d")
            .ok()
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .map(|t| t.and_utc().timestamp_millis()),
        ColKind::Timestamp => NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f")
            .ok()
            .map(|t| t.and_utc().timestamp_millis()),
        ColKind::TimestampTz => {
            DateTime::<FixedOffset>::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f%:z")
                .ok()
                .map(|t| t.timestamp_millis())
        }
        ColKind::Time => NaiveTime::parse_from_str(text, "%H:%M:%S%.f")
            .ok()
            .map(|t| {
                use chrono::Timelike;
                i64::from(t.num_seconds_from_midnight()) * 1000
                    + i64::from(t.nanosecond() / 1_000_000)
            }),
        _ => None,
    }
}

fn hash(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

/// The text of a cell that holds a value: what is counted as „the same value“.
fn text_of(cell: &Value) -> Option<String> {
    match cell {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// The figures of the selected cells of a result. `top`: also the ten most frequent values. `stop` is
/// asked now and then; `true` ends the work with `cancelled`.
pub fn stats(
    store: &ResultStore,
    result_id: u64,
    selection: &Selection,
    top: bool,
    stop: &dyn Fn() -> bool,
) -> AppResult<Stats> {
    let columns = store.columns(result_id)?;
    let picked = pick_columns(&selection.columns, columns.len());
    let ranges = merge_rows(&selection.rows, store.rows(result_id)?);
    let numeric: Vec<bool> = picked
        .iter()
        .map(|&c| {
            matches!(
                columns[c].kind,
                ColKind::Int | ColKind::Float | ColKind::Decimal
            )
        })
        .collect();
    let timed: Vec<Option<ColKind>> = picked
        .iter()
        .map(|&c| {
            let k = columns[c].kind;
            matches!(
                k,
                ColKind::Date | ColKind::Timestamp | ColKind::TimestampTz | ColKind::Time
            )
            .then_some(k)
        })
        .collect();
    let mut out = Stats::default();
    let mut seen: HashSet<u64> = HashSet::new();
    let mut counts: HashMap<Option<String>, u64> = HashMap::new();
    let mut sum = Dec::zero();
    let (mut min, mut max): (Option<Dec>, Option<Dec>) = (None, None);
    // (moment, text) of the first and the last, and the one kind of time they are of
    let mut first: Option<(i64, String)> = None;
    let mut last: Option<(i64, String)> = None;
    let mut time_kind: Option<ColKind> = None;
    let mut time_mixed = false;
    let mut other_values = 0u64;
    let mut rows = 0u64;
    let mut failed: Option<AppError> = None;
    for (from, to) in ranges {
        store.each_row(result_id, from, to + 1, &mut |row| {
            rows += 1;
            if rows.is_multiple_of(2048) && stop() {
                failed = Some(crate::db::cancelled());
                return false;
            }
            let cells: Vec<Value> = match serde_json::from_str(row) {
                Ok(cells) => cells,
                Err(e) => {
                    failed = Some(AppError::new(
                        ErrorCode::Io,
                        format!("a stored row is damaged: {e}"),
                    ));
                    return false;
                }
            };
            for (i, &c) in picked.iter().enumerate() {
                let cell = cells.get(c).unwrap_or(&Value::Null);
                out.cells += 1;
                let text = text_of(cell);
                if top {
                    let key = text
                        .as_ref()
                        .map(|t| t.chars().take(200).collect::<String>());
                    if counts.len() < MAX_TOP_KEYS || counts.contains_key(&key) {
                        *counts.entry(key).or_insert(0) += 1;
                    } else {
                        out.top_partial = true;
                    }
                }
                let Some(text) = text else { continue };
                out.non_null += 1;
                if seen.len() < MAX_DISTINCT {
                    seen.insert(hash(&text));
                } else if !seen.contains(&hash(&text)) {
                    out.distinct_capped = true;
                }
                let number = if numeric[i] { Dec::parse(&text) } else { None };
                if let Some(n) = number {
                    out.numbers += 1;
                    sum = sum.add(&n);
                    if min.as_ref().is_none_or(|m| n.order(m) == Ordering::Less) {
                        min = Some(n.clone());
                    }
                    if max.as_ref().is_none_or(|m| n.order(m) == Ordering::Greater) {
                        max = Some(n);
                    }
                    continue;
                }
                other_values += 1;
                if let Some(kind) = timed[i]
                    && let Some(at) = moment(&text, kind)
                {
                    if time_kind.is_some_and(|k| k != kind) {
                        time_mixed = true;
                    }
                    time_kind = Some(kind);
                    if first.as_ref().is_none_or(|f| at < f.0) {
                        first = Some((at, text.clone()));
                    }
                    if last.as_ref().is_none_or(|l| at > l.0) {
                        last = Some((at, text));
                    }
                    continue;
                }
                if matches!(cell, Value::String(_)) && timed[i].is_none() && !numeric[i] {
                    let len = text.chars().count() as u64;
                    out.shortest = Some(out.shortest.map_or(len, |s| s.min(len)));
                    out.longest = Some(out.longest.map_or(len, |l| l.max(len)));
                }
            }
            true
        })?;
        if let Some(e) = failed.take() {
            return Err(e);
        }
    }
    out.distinct = seen.len() as u64;
    if out.numbers > 0 {
        out.mean = Some(sum.div(out.numbers).to_string());
        out.sum = Some(sum.to_string());
        out.min = min.map(|d| d.to_string());
        out.max = max.map(|d| d.to_string());
        // values that are no numbers, in a selection that has numbers
        out.ignored = other_values;
    }
    if !time_mixed && let (Some(f), Some(l)) = (&first, &last) {
        out.span_ms = Some(l.0 - f.0);
    }
    if !time_mixed {
        out.first = first.map(|f| f.1);
        out.last = last.map(|l| l.1);
    }
    if top {
        let mut all: Vec<Frequent> = counts
            .into_iter()
            .map(|(value, count)| Frequent { value, count })
            .collect();
        // the most frequent first; among equals NULL, then by the value
        all.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.value.cmp(&b.value)));
        all.truncate(10);
        out.top = all;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::value::{Cell, Column, RowSink};
    use crate::results::{Progress, StoreSink};
    use tempfile::tempdir;

    fn dec(text: &str) -> Dec {
        Dec::parse(text).unwrap_or_else(|| panic!("{text}"))
    }

    #[test]
    fn reads_and_writes_decimals() {
        for (text, written) in [
            ("0", "0"),
            ("-0", "0"),
            ("007", "7"),
            ("-12.50", "-12.50"),
            ("+3", "3"),
            (".5", "0.5"),
            ("5.", "5"),
            ("1e3", "1000"),
            ("2.5E3", "2500"),
            ("1e-7", "0.0000001"),
            (
                "12345678901234567890123456789012345678.1234567890",
                "12345678901234567890123456789012345678.1234567890",
            ),
        ] {
            assert_eq!(dec(text).to_string(), written, "{text}");
        }
        for not in [
            "", "-", ".", "abc", "NaN", "Infinity", "1,5", "1e", "0x10", "1 2",
        ] {
            assert!(Dec::parse(not).is_none(), "{not}");
        }
    }

    #[test]
    fn adds_exactly_whatever_the_signs_and_lengths() {
        let sum = |a: &str, b: &str| dec(a).add(&dec(b)).to_string();
        assert_eq!(sum("0.1", "0.2"), "0.3");
        assert_eq!(sum("1.10", "2.2"), "3.30");
        assert_eq!(sum("999", "1"), "1000");
        assert_eq!(sum("-5", "3"), "-2");
        assert_eq!(sum("5", "-3"), "2");
        assert_eq!(sum("3", "-5"), "-2");
        assert_eq!(sum("-3", "-5"), "-8");
        assert_eq!(sum("1.5", "-1.5"), "0.0");
        assert_eq!(sum("100", "-0.01"), "99.99");
        // beyond 64 bits, and beyond 128
        assert_eq!(sum("9223372036854775807", "1"), "9223372036854775808");
        assert_eq!(
            sum(
                "99999999999999999999999999999999999999.9999999999",
                "0.0000000001"
            ),
            "100000000000000000000000000000000000000.0000000000"
        );
    }

    #[test]
    fn compares_and_divides() {
        assert_eq!(dec("2").order(&dec("10")), Ordering::Less);
        assert_eq!(dec("-2").order(&dec("-10")), Ordering::Greater);
        assert_eq!(dec("1.50").order(&dec("1.5")), Ordering::Equal);
        assert_eq!(dec("-0.1").order(&dec("0")), Ordering::Less);
        let mean = |text: &str, n: u64| dec(text).div(n).to_string();
        assert_eq!(mean("10", 4), "2.5");
        assert_eq!(mean("10", 3), "3.333333");
        assert_eq!(mean("2", 3), "0.666667");
        assert_eq!(mean("-2", 3), "-0.666667");
        assert_eq!(mean("3.30", 3), "1.10");
        assert_eq!(mean("0", 7), "0");
        assert_eq!(mean("1", 0), "0");
    }

    fn store_with(
        columns: &[(&str, ColKind)],
        rows: Vec<Vec<Cell>>,
    ) -> (tempfile::TempDir, ResultStore, u64) {
        let dir = tempdir().unwrap();
        let store = ResultStore::new(dir.path());
        let report = |_: Progress| {};
        let id = {
            let mut sink = StoreSink::new(&store, &report);
            let columns: Vec<Column> = columns
                .iter()
                .map(|(name, kind)| Column {
                    name: (*name).into(),
                    kind: *kind,
                    type_name: String::new(),
                })
                .collect();
            sink.start(&columns);
            for row in rows {
                assert!(sink.row(row));
            }
            sink.finish();
            sink.result_id().unwrap()
        };
        (dir, store, id)
    }

    fn all() -> Selection {
        Selection::default()
    }

    /// The acceptance criterion: the sum of NUMERIC(38,10) values is right to the last digit.
    #[test]
    fn sums_big_decimals_to_the_last_digit() {
        let values = [
            "12345678901234567890123456.1234567891",
            "0.0000000009",
            "-345678901234567890123456.9999999999",
            "99999999999999999999999999.9999999999",
        ];
        let rows = values
            .iter()
            .map(|v| vec![Cell::Decimal((*v).into())])
            .collect();
        let (_dir, store, id) = store_with(&[("n", ColKind::Decimal)], rows);
        let s = stats(&store, id, &all(), false, &|| false).unwrap();
        // checked by hand: 12345678901234567890123456.1234567900 − 345678901234567890123456.9999999999
        // = 11999999999999999999999999.1234567901, plus 99999999999999999999999999.9999999999
        assert_eq!(
            s.sum.as_deref(),
            Some("111999999999999999999999999.1234567900")
        );
        assert_eq!(
            s.min.as_deref(),
            Some("-345678901234567890123456.9999999999")
        );
        assert_eq!(
            s.max.as_deref(),
            Some("99999999999999999999999999.9999999999")
        );
        assert_eq!((s.cells, s.numbers, s.distinct, s.ignored), (4, 4, 4, 0));
    }

    #[test]
    fn counts_and_figures_of_a_mixed_selection() {
        let rows = vec![
            vec![Cell::I64(10), Cell::Text("Köln".into()), Cell::F64(0.1)],
            vec![
                Cell::I64(i64::MAX),
                Cell::Text("Bonn 😀".into()),
                Cell::F64(0.2),
            ],
            vec![Cell::Null, Cell::Null, Cell::F64(f64::NAN)],
            vec![Cell::I64(10), Cell::Text("".into()), Cell::Null],
            vec![Cell::I64(1), Cell::Text("Köln".into()), Cell::F64(-1.5e-3)],
        ];
        let (_dir, store, id) = store_with(
            &[
                ("id", ColKind::Int),
                ("city", ColKind::Text),
                ("f", ColKind::Float),
            ],
            rows,
        );
        let never = || false;
        // one numeric column: beyond 64 bits without an overflow
        let ids = Selection {
            rows: vec![],
            columns: vec![0],
        };
        let s = stats(&store, id, &ids, false, &never).unwrap();
        assert_eq!((s.cells, s.non_null, s.distinct, s.numbers), (5, 4, 3, 4));
        assert_eq!(s.sum.as_deref(), Some("9223372036854775828"));
        assert_eq!(s.mean.as_deref(), Some("2305843009213693957"));
        assert_eq!(
            (s.min.as_deref(), s.max.as_deref()),
            (Some("1"), Some("9223372036854775807"))
        );
        assert_eq!(s.shortest, None);
        // floats: 0.1 + 0.2 is 0.3 here; what is no number (NaN) is said to be ignored
        let floats = Selection {
            rows: vec![],
            columns: vec![2],
        };
        let s = stats(&store, id, &floats, false, &never).unwrap();
        assert_eq!(s.sum.as_deref(), Some("0.2985"));
        assert_eq!((s.numbers, s.ignored, s.non_null), (3, 1, 4));
        // text: lengths in characters, no number figures
        let text = Selection {
            rows: vec![(0, 3)],
            columns: vec![1],
        };
        let s = stats(&store, id, &text, false, &never).unwrap();
        assert_eq!((s.cells, s.non_null, s.distinct), (4, 3, 3));
        assert_eq!((s.shortest, s.longest), (Some(0), Some(6)));
        assert_eq!((s.sum, s.numbers, s.ignored), (None, 0, 0));
        // numbers and text together: the number figures are of the numbers, the rest is counted as ignored
        let mixed = Selection {
            rows: vec![(0, 1)],
            columns: vec![0, 1],
        };
        let s = stats(&store, id, &mixed, false, &never).unwrap();
        assert_eq!((s.cells, s.numbers, s.ignored), (4, 2, 2));
        assert_eq!(s.sum.as_deref(), Some("9223372036854775817"));
        // rows chosen twice or out of range count once, or not
        let twice = Selection {
            rows: vec![(0, 1), (1, 1), (9, 12)],
            columns: vec![0, 0, 7],
        };
        assert_eq!(stats(&store, id, &twice, false, &never).unwrap().cells, 2);
        assert_eq!(
            stats(&store, id, &all(), false, &|| true).unwrap().cells,
            15
        );
    }

    #[test]
    fn first_last_and_span_of_dates_and_times() {
        let ts = |s: &str| Cell::Ts(NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap());
        let tz = |s: &str| Cell::TsTz(DateTime::parse_from_rfc3339(s).unwrap());
        let rows = vec![
            vec![
                ts("2026-11-11 12:00:00"),
                tz("2026-11-11T12:00:00+01:00"),
                Cell::Date(NaiveDate::from_ymd_opt(2026, 3, 1).unwrap()),
            ],
            vec![
                ts("2026-11-10 11:30:00"),
                tz("2026-11-11T10:30:00-05:00"),
                Cell::Null,
            ],
            vec![
                Cell::Null,
                tz("2026-11-11T11:15:00Z"),
                Cell::Date(NaiveDate::from_ymd_opt(2024, 2, 29).unwrap()),
            ],
        ];
        let (_dir, store, id) = store_with(
            &[
                ("ts", ColKind::Timestamp),
                ("tz", ColKind::TimestampTz),
                ("d", ColKind::Date),
            ],
            rows,
        );
        let col = |c: usize| Selection {
            rows: vec![],
            columns: vec![c],
        };
        let s = stats(&store, id, &col(0), false, &|| false).unwrap();
        assert_eq!(s.first.as_deref(), Some("2026-11-10 11:30:00"));
        assert_eq!(s.last.as_deref(), Some("2026-11-11 12:00:00"));
        assert_eq!(s.span_ms, Some((24 * 60 + 30) * 60 * 1000));
        // instants are compared as instants, whatever their offset
        let s = stats(&store, id, &col(1), false, &|| false).unwrap();
        assert_eq!(s.first.as_deref(), Some("2026-11-11 12:00:00+01:00"));
        assert_eq!(s.last.as_deref(), Some("2026-11-11 10:30:00-05:00"));
        assert_eq!(s.span_ms, Some(4 * 60 * 60 * 1000 + 30 * 60 * 1000));
        let s = stats(&store, id, &col(2), false, &|| false).unwrap();
        assert_eq!(
            (s.first.as_deref(), s.last.as_deref()),
            (Some("2024-02-29"), Some("2026-03-01"))
        );
        assert_eq!(s.span_ms, Some(731 * 24 * 60 * 60 * 1000));
        // dates and instants together have no common line of time
        let s = stats(&store, id, &all(), false, &|| false).unwrap();
        assert_eq!((s.first, s.last, s.span_ms), (None, None, None));
    }

    #[test]
    fn the_most_frequent_values_of_a_column() {
        let mut rows: Vec<Vec<Cell>> = Vec::new();
        for (value, times) in [("paid", 5), ("open", 3), ("void", 3), ("x", 1)] {
            for _ in 0..times {
                rows.push(vec![Cell::Text(value.into())]);
            }
        }
        for _ in 0..4 {
            rows.push(vec![Cell::Null]);
        }
        let (_dir, store, id) = store_with(&[("state", ColKind::Text)], rows);
        let s = stats(&store, id, &all(), true, &|| false).unwrap();
        let top: Vec<(Option<&str>, u64)> = s
            .top
            .iter()
            .map(|f| (f.value.as_deref(), f.count))
            .collect();
        assert_eq!(
            top,
            vec![
                (Some("paid"), 5),
                (None, 4),
                (Some("open"), 3),
                (Some("void"), 3),
                (Some("x"), 1)
            ]
        );
        assert!(!s.top_partial);
        assert_eq!((s.cells, s.non_null, s.distinct), (16, 12, 4));
        assert!(
            stats(&store, id, &all(), false, &|| false)
                .unwrap()
                .top
                .is_empty()
        );
    }

    /// The window reads these names (`ResultStats` in query.models.ts).
    #[test]
    fn crosses_the_bridge_in_camel_case() {
        let rows = vec![vec![Cell::I64(2)], vec![Cell::I64(3)], vec![Cell::Null]];
        let (_dir, store, id) = store_with(&[("n", ColKind::Int)], rows);
        let s = stats(&store, id, &all(), true, &|| false).unwrap();
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({
                "cells": 3, "nonNull": 2, "distinct": 2, "distinctCapped": false,
                "numbers": 2, "ignored": 0,
                "sum": "5", "mean": "2.5", "min": "2", "max": "3",
                "first": null, "last": null, "spanMs": null,
                "shortest": null, "longest": null,
                "top": [
                    {"value": null, "count": 1},
                    {"value": "2", "count": 1},
                    {"value": "3", "count": 1}
                ],
                "topPartial": false
            })
        );
    }

    #[test]
    fn stops_when_asked_and_knows_no_result() {
        let rows = (0..10_000).map(|i| vec![Cell::I64(i)]).collect();
        let (_dir, store, id) = store_with(&[("n", ColKind::Int)], rows);
        assert_eq!(
            stats(&store, id, &all(), false, &|| true).unwrap_err().code,
            ErrorCode::Cancelled
        );
        assert_eq!(
            stats(&store, 999, &all(), false, &|| false)
                .unwrap_err()
                .code,
            ErrorCode::UnknownResult
        );
        let s = stats(&store, id, &all(), false, &|| false).unwrap();
        assert_eq!(s.sum.as_deref(), Some("49995000"));
        assert_eq!(s.mean.as_deref(), Some("4999.5"));
    }
}
