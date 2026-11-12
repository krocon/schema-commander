//! A chart of a result (prompt 042): the rows of the result store → the points that are drawn. Pure: no
//! Tauri, no database.
//!
//! Two steps. [`prepare`] reads the result once and keeps what the chart needs as numbers (aggregated per
//! category, or sorted by X with equal X merged). [`sample`] gives the points for a width in pixels and a
//! range of X – thinned so that no peak is lost (first, lowest, highest and last value of each pixel
//! column). Zooming asks `sample` again; the result is not read a second time.

use std::collections::HashMap;

use serde::de::{IgnoredAny, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};

use crate::db::value::{ColKind, Column};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::results::ResultStore;

/// Series a chart has at most; further groups are counted and left out.
pub const MAX_SERIES: usize = 12;
/// Categories a chart shows at most (bars); the rest is counted and left out.
pub const MAX_CATEGORIES: usize = 500;
/// Distinct categories that are told apart while reading; rows of further ones are left out.
const MAX_DISTINCT: usize = 200_000;
/// Points kept for one chart (16 bytes each).
pub const MAX_POINTS: u64 = 40_000_000;
/// Characters of a category or of the name of a group.
const NAME_CHARS: usize = 60;
const LOOK_EVERY: u64 = 8192;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Line,
    Bar,
    Scatter,
}

/// What becomes of several values at one X (or in one category).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Agg {
    Sum,
    Avg,
    Count,
    Min,
    Max,
}

/// The order of categories.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Sort {
    /// As they come in the result.
    #[default]
    None,
    /// By their name.
    Label,
    /// By the value of the first series, the largest first.
    ValueDesc,
    ValueAsc,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartSpec {
    pub kind: Kind,
    /// The column of X; `None` = the number of the row.
    pub x: Option<u32>,
    /// The columns of the values, a series each.
    pub ys: Vec<u32>,
    /// A column whose values split every series: a series per value.
    #[serde(default)]
    pub group: Option<u32>,
    pub agg: Agg,
    #[serde(default)]
    pub sort: Sort,
}

/// What X is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum XKind {
    /// Milliseconds since 1970-01-01 (dates and timestamps; a timestamp without a zone counts as UTC).
    Time,
    /// Milliseconds since midnight.
    Clock,
    Number,
    /// The index of a category.
    Category,
    /// The number of the row, from 1.
    Row,
}

fn is_number(kind: ColKind) -> bool {
    matches!(kind, ColKind::Int | ColKind::Float | ColKind::Decimal)
}

fn is_time(kind: ColKind) -> bool {
    matches!(
        kind,
        ColKind::Date | ColKind::Timestamp | ColKind::TimestampTz | ColKind::Time
    )
}

/// Names that say „a key“, not „a measure“.
fn looks_like_key(name: &str) -> bool {
    let n = name.to_lowercase();
    n == "id" || n.ends_with("_id") || n.ends_with(" id")
}

/// The chart the types of the columns suggest: a time column → lines over time; a text column and a
/// number → bars; two numbers → a scatter plot; one number → a line over the rows. `None`: nothing to draw.
pub fn suggest(columns: &[Column]) -> Option<ChartSpec> {
    let numbers: Vec<u32> = (0..columns.len() as u32)
        .filter(|&c| is_number(columns[c as usize].kind))
        .collect();
    // keys are numbers too, but nobody wants to see their sum – unless there is nothing else
    let measures: Vec<u32> = {
        let real: Vec<u32> = numbers
            .iter()
            .copied()
            .filter(|&c| !looks_like_key(&columns[c as usize].name))
            .collect();
        if real.is_empty() {
            numbers.clone()
        } else {
            real
        }
    };
    if measures.is_empty() {
        return None;
    }
    let first = |f: &dyn Fn(ColKind) -> bool| {
        (0..columns.len() as u32).find(|&c| f(columns[c as usize].kind))
    };
    if let Some(x) = first(&|k| is_time(k) && k != ColKind::Time) {
        return Some(ChartSpec {
            kind: Kind::Line,
            x: Some(x),
            ys: measures.into_iter().take(4).collect(),
            group: None,
            agg: Agg::Sum,
            sort: Sort::None,
        });
    }
    if let Some(x) = first(&|k| matches!(k, ColKind::Text | ColKind::Bool | ColKind::Uuid)) {
        return Some(ChartSpec {
            kind: Kind::Bar,
            x: Some(x),
            ys: measures.into_iter().take(4).collect(),
            group: None,
            agg: Agg::Sum,
            sort: Sort::None,
        });
    }
    if measures.len() >= 2 {
        return Some(ChartSpec {
            kind: Kind::Scatter,
            x: Some(measures[0]),
            ys: vec![measures[1]],
            group: None,
            agg: Agg::Avg,
            sort: Sort::None,
        });
    }
    // one measure: over a key if there is one, else over the rows
    let x = numbers.iter().copied().find(|c| *c != measures[0]);
    Some(ChartSpec {
        kind: Kind::Line,
        x,
        ys: vec![measures[0]],
        group: None,
        agg: Agg::Sum,
        sort: Sort::None,
    })
}

/// A cell as the chart reads it.
#[derive(Debug, Clone, PartialEq)]
enum Val {
    Null,
    Num(f64),
    Text(String),
    /// Bytes, or what the driver could not read.
    Other,
}

impl<'de> Deserialize<'de> for Val {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Val;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a cell")
            }
            fn visit_unit<E>(self) -> Result<Val, E> {
                Ok(Val::Null)
            }
            fn visit_bool<E>(self, b: bool) -> Result<Val, E> {
                Ok(Val::Text(b.to_string()))
            }
            fn visit_i64<E>(self, n: i64) -> Result<Val, E> {
                Ok(Val::Num(n as f64))
            }
            fn visit_u64<E>(self, n: u64) -> Result<Val, E> {
                Ok(Val::Num(n as f64))
            }
            fn visit_f64<E>(self, n: f64) -> Result<Val, E> {
                Ok(Val::Num(n))
            }
            fn visit_str<E>(self, s: &str) -> Result<Val, E> {
                Ok(Val::Text(s.to_owned()))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Val, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(Val::Other)
            }
        }
        d.deserialize_any(V)
    }
}

/// Reads of a stored row only the cells that are wanted (`wanted` in rising order).
struct Pick<'a> {
    wanted: &'a [usize],
    out: &'a mut Vec<Val>,
}

impl<'de> Visitor<'de> for Pick<'_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a row")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        self.out.clear();
        let mut at = 0usize;
        for &w in self.wanted {
            while at < w {
                if seq.next_element::<IgnoredAny>()?.is_none() {
                    break;
                }
                at += 1;
            }
            self.out
                .push(seq.next_element::<Val>()?.unwrap_or(Val::Null));
            at += 1;
        }
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(())
    }
}

fn pick(row: &str, wanted: &[usize], out: &mut Vec<Val>) -> AppResult<()> {
    use serde::Deserializer;
    let mut d = serde_json::Deserializer::from_str(row);
    d.deserialize_seq(Pick { wanted, out })
        .map_err(|e| AppError::new(ErrorCode::Io, format!("a stored row is damaged: {e}")))
}

/// Days since 1970-01-01 of a date of the proleptic Gregorian calendar.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn digits(b: &[u8]) -> Option<i64> {
    if b.is_empty() || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(b.iter().fold(0i64, |n, d| n * 10 + (d - b'0') as i64))
}

/// `HH:MM[:SS[.fff]]` → milliseconds, and what follows it.
fn clock_ms(b: &[u8]) -> Option<(f64, &[u8])> {
    if b.len() < 5 || b[2] != b':' {
        return None;
    }
    let h = digits(&b[0..2])?;
    let m = digits(&b[3..5])?;
    let mut ms = (h * 3_600_000 + m * 60_000) as f64;
    let mut rest = &b[5..];
    if rest.len() >= 3 && rest[0] == b':' {
        ms += (digits(&rest[1..3])? * 1000) as f64;
        rest = &rest[3..];
        if rest.first() == Some(&b'.') {
            let n = rest[1..].iter().take_while(|c| c.is_ascii_digit()).count();
            let frac = digits(&rest[1..1 + n])? as f64 / 10f64.powi(n as i32);
            ms += frac * 1000.0;
            rest = &rest[1 + n..];
        }
    }
    Some((ms, rest))
}

/// A date or a timestamp as the store writes it (`2026-01-31`, `2026-01-31 12:00:00.5`, with `+02:00`)
/// → milliseconds since 1970-01-01. Without a zone the time counts as UTC.
pub fn time_ms(text: &str) -> Option<f64> {
    let b = text.as_bytes();
    let (neg, b) = match b.first() {
        Some(b'-') => (true, &b[1..]),
        _ => (false, b),
    };
    let dash = b.iter().position(|c| *c == b'-')?;
    if b.len() < dash + 6 || b[dash + 3] != b'-' {
        return None;
    }
    let y = digits(&b[..dash])? * if neg { -1 } else { 1 };
    let m = digits(&b[dash + 1..dash + 3])?;
    let d = digits(&b[dash + 4..dash + 6])?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let mut ms = days_from_civil(y, m, d) as f64 * 86_400_000.0;
    let rest = &b[dash + 6..];
    if rest.is_empty() {
        return Some(ms);
    }
    if rest[0] != b' ' && rest[0] != b'T' {
        return None;
    }
    let (clock, rest) = clock_ms(&rest[1..])?;
    ms += clock;
    match rest.first() {
        None => Some(ms),
        Some(b'Z') if rest.len() == 1 => Some(ms),
        Some(sign @ (b'+' | b'-')) => {
            let (offset, tail) = clock_ms(&rest[1..]).or_else(|| {
                Some((
                    (digits(&rest[1..])? * 3_600_000) as f64,
                    &rest[rest.len()..],
                ))
            })?;
            if !tail.is_empty() {
                return None;
            }
            Some(if *sign == b'+' {
                ms - offset
            } else {
                ms + offset
            })
        }
        _ => None,
    }
}

fn number_of(v: &Val) -> Option<f64> {
    match v {
        Val::Num(n) => Some(*n),
        Val::Text(s) => s.trim().parse::<f64>().ok().filter(|n| n.is_finite()),
        _ => None,
    }
}

fn label_of(v: &Val) -> String {
    let text = match v {
        Val::Null => "NULL".to_owned(),
        Val::Num(n) => n.to_string(),
        Val::Text(s) => s.clone(),
        Val::Other => "?".to_owned(),
    };
    // one line, not endless: a label is drawn
    let mut out: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(NAME_CHARS + 1)
        .collect();
    if out.chars().count() > NAME_CHARS {
        out = out.chars().take(NAME_CHARS).collect::<String>() + "…";
    }
    out
}

/// What is collected of the values at one place.
#[derive(Debug, Clone, Copy)]
struct Acc {
    sum: f64,
    count: u64,
    min: f64,
    max: f64,
}

impl Acc {
    const EMPTY: Acc = Acc {
        sum: 0.0,
        count: 0,
        min: f64::INFINITY,
        max: f64::NEG_INFINITY,
    };

    fn add(&mut self, v: f64) {
        self.sum += v;
        self.count += 1;
        self.min = self.min.min(v);
        self.max = self.max.max(v);
    }

    /// `None`: no value was there (a gap) – but the count of nothing is 0.
    fn value(&self, agg: Agg) -> Option<f64> {
        if self.count == 0 {
            return (agg == Agg::Count).then_some(0.0);
        }
        Some(match agg {
            Agg::Sum => self.sum,
            Agg::Avg => self.sum / self.count as f64,
            Agg::Count => self.count as f64,
            Agg::Min => self.min,
            Agg::Max => self.max,
        })
    }
}

/// A series as it is kept: its points in the order of X; `NaN` is a gap (a NULL).
#[derive(Debug, Clone, Default)]
struct Series {
    name: String,
    x: Vec<f64>,
    y: Vec<f64>,
}

/// A result made ready for a chart.
#[derive(Debug, Clone)]
pub struct Prepared {
    kind: Kind,
    x_kind: XKind,
    categories: Vec<String>,
    series: Vec<Series>,
    /// The smallest and the largest X.
    extent: Option<(f64, f64)>,
    rows: u64,
    nulls: u64,
    skipped: u64,
    cut_groups: u64,
    cut_categories: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesData {
    pub name: String,
    pub x: Vec<f64>,
    /// `null` is a gap.
    pub y: Vec<Option<f64>>,
    /// Points the series has in the range, before thinning.
    pub points: u64,
}

/// The points to draw.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartData {
    pub kind: Kind,
    pub x_kind: XKind,
    /// The names of the categories; X of a point is an index into them.
    pub categories: Vec<String>,
    pub series: Vec<SeriesData>,
    /// The whole extent of X (not only of the range asked for); `None` without a point.
    pub x_min: Option<f64>,
    pub x_max: Option<f64>,
    /// Rows of the result that were read.
    pub rows: u64,
    /// Values that are NULL (gaps).
    pub nulls: u64,
    /// Rows left out: X is NULL or no number/time, or a value is no number.
    pub skipped: u64,
    /// Groups and categories beyond the limits.
    pub cut_groups: u64,
    pub cut_categories: u64,
    /// Not every point is drawn.
    pub thinned: bool,
}

fn invalid(message: &str) -> AppError {
    AppError::new(ErrorCode::Unsupported, message)
}

/// Reads a result into what its chart needs. `stop` is asked now and then.
pub fn prepare(
    store: &ResultStore,
    result_id: u64,
    spec: &ChartSpec,
    stop: &dyn Fn() -> bool,
) -> AppResult<Prepared> {
    let columns = store.columns(result_id)?;
    let col = |c: u32| {
        columns
            .get(c as usize)
            .ok_or_else(|| invalid("the chart names a column the result does not have"))
    };
    if spec.ys.is_empty() || spec.ys.len() > MAX_SERIES {
        return Err(invalid("a chart needs one to twelve value columns"));
    }
    for y in &spec.ys {
        col(*y)?;
    }
    let x_col = spec.x.map(col).transpose()?;
    if let Some(g) = spec.group {
        col(g)?;
    }
    let x_kind = match x_col.map(|c| c.kind) {
        None => XKind::Row,
        Some(_) if spec.kind == Kind::Bar => XKind::Category,
        Some(ColKind::Time) => XKind::Clock,
        Some(k) if is_time(k) => XKind::Time,
        Some(k) if is_number(k) => XKind::Number,
        Some(_) => XKind::Category,
    };
    // the cells to read, in rising order, and where each of ours is among them
    let mut wanted: Vec<usize> = spec
        .ys
        .iter()
        .chain(spec.x.iter())
        .chain(spec.group.iter())
        .map(|c| *c as usize)
        .collect();
    wanted.sort_unstable();
    wanted.dedup();
    let at = |c: u32| wanted.binary_search(&(c as usize)).unwrap_or(0);
    let y_at: Vec<usize> = spec.ys.iter().map(|c| at(*c)).collect();
    let x_at = spec.x.map(at);
    let group_at = spec.group.map(at);

    let categorical = x_kind == XKind::Category;
    let mut categories: Vec<String> = Vec::new();
    let mut category_index: HashMap<String, u32> = HashMap::new();
    let mut groups: Vec<String> = Vec::new();
    let mut group_index: HashMap<String, usize> = HashMap::new();
    let mut cut_groups: HashMap<String, ()> = HashMap::new();
    // categorical: an accumulator per series and category; else: the points as they come
    let mut accs: Vec<Vec<Acc>> = Vec::new();
    let mut raw: Vec<Series> = Vec::new();
    let mut sorted: Vec<bool> = Vec::new();
    let (mut rows, mut nulls, mut skipped, mut points) = (0u64, 0u64, 0u64, 0u64);
    let mut lost_categories = false;
    let mut cells: Vec<Val> = Vec::new();
    let mut failed: Option<AppError> = None;
    let total = store.rows(result_id)?;
    let per_group = spec.ys.len();
    store.each_row(result_id, 0, total, &mut |row| {
        rows += 1;
        if rows.is_multiple_of(LOOK_EVERY) && stop() {
            failed = Some(crate::db::cancelled());
            return false;
        }
        if let Err(e) = pick(row, &wanted, &mut cells) {
            failed = Some(e);
            return false;
        }
        // the group of the row: its series start at `base`
        let base = match group_at {
            None => {
                if groups.is_empty() {
                    groups.push(String::new());
                }
                0
            }
            Some(g) => {
                let name = label_of(&cells[g]);
                match group_index.get(&name) {
                    Some(i) => *i * per_group,
                    None if (groups.len() + 1) * per_group > MAX_SERIES => {
                        cut_groups.insert(name, ());
                        skipped += 1;
                        return true;
                    }
                    None => {
                        group_index.insert(name.clone(), groups.len());
                        groups.push(name);
                        (groups.len() - 1) * per_group
                    }
                }
            }
        };
        let x = match (x_kind, x_at) {
            (XKind::Row, _) | (_, None) => rows as f64,
            (XKind::Category, Some(i)) => {
                let name = label_of(&cells[i]);
                match category_index.get(&name) {
                    Some(c) => *c as f64,
                    None if categories.len() >= MAX_DISTINCT => {
                        lost_categories = true;
                        skipped += 1;
                        return true;
                    }
                    None => {
                        category_index.insert(name.clone(), categories.len() as u32);
                        categories.push(name);
                        (categories.len() - 1) as f64
                    }
                }
            }
            (kind, Some(i)) => {
                let value = match (&cells[i], kind) {
                    (Val::Text(s), XKind::Time) => time_ms(s),
                    (Val::Text(s), XKind::Clock) => {
                        clock_ms(s.as_bytes()).filter(|(_, r)| r.is_empty()).map(|(ms, _)| ms)
                    }
                    (v, XKind::Number) => number_of(v),
                    _ => None,
                };
                match value {
                    Some(x) => x,
                    None => {
                        skipped += 1;
                        return true;
                    }
                }
            }
        };
        for (s, &y_i) in y_at.iter().enumerate() {
            let series = base + s;
            let value = match &cells[y_i] {
                Val::Null => {
                    nulls += 1;
                    None
                }
                v => match number_of(v) {
                    Some(n) => Some(n),
                    None => {
                        skipped += 1;
                        continue;
                    }
                },
            };
            if categorical {
                if accs.len() <= series {
                    accs.resize_with(series + 1, Vec::new);
                }
                let acc = &mut accs[series];
                let c = x as usize;
                if acc.len() <= c {
                    acc.resize(c + 1, Acc::EMPTY);
                }
                if let Some(v) = value {
                    acc[c].add(v);
                }
            } else {
                if raw.len() <= series {
                    raw.resize_with(series + 1, Series::default);
                    sorted.resize(series + 1, true);
                }
                let line = &mut raw[series];
                if line.x.last().is_some_and(|last| *last > x) {
                    sorted[series] = false;
                }
                line.x.push(x);
                line.y.push(value.unwrap_or(f64::NAN));
                points += 1;
                if points > MAX_POINTS {
                    failed = Some(AppError::new(
                        ErrorCode::TooLarge,
                        "too many points for a chart: aggregate in the query, or choose fewer columns",
                    ));
                    return false;
                }
            }
        }
        true
    })?;
    if let Some(e) = failed {
        return Err(e);
    }
    let series_count = groups.len().max(1) * per_group;
    let name_of = |series: usize| {
        let group = groups.get(series / per_group).map_or("", String::as_str);
        let y = columns[spec.ys[series % per_group] as usize].name.as_str();
        match (spec.group.is_some(), per_group > 1) {
            (false, _) => y.to_owned(),
            (true, false) => group.to_owned(),
            (true, true) => format!("{y} · {group}"),
        }
    };
    let mut cut_categories = 0u64;
    let series: Vec<Series> = if categorical {
        accs.resize_with(series_count, Vec::new);
        for acc in &mut accs {
            acc.resize(categories.len(), Acc::EMPTY);
        }
        // the order of the categories, and how many of them are shown
        let mut order: Vec<usize> = (0..categories.len()).collect();
        let first = |c: usize| accs[0][c].value(spec.agg);
        match spec.sort {
            Sort::None => {}
            Sort::Label => order.sort_by(|a, b| categories[*a].cmp(&categories[*b])),
            Sort::ValueDesc => order.sort_by(|a, b| {
                first(*b)
                    .unwrap_or(f64::NEG_INFINITY)
                    .total_cmp(&first(*a).unwrap_or(f64::NEG_INFINITY))
            }),
            Sort::ValueAsc => order.sort_by(|a, b| {
                first(*a)
                    .unwrap_or(f64::INFINITY)
                    .total_cmp(&first(*b).unwrap_or(f64::INFINITY))
            }),
        }
        if order.len() > MAX_CATEGORIES {
            cut_categories = (order.len() - MAX_CATEGORIES) as u64;
            order.truncate(MAX_CATEGORIES);
        }
        if lost_categories {
            cut_categories += 1;
        }
        let out = (0..series_count)
            .map(|s| Series {
                name: name_of(s),
                x: (0..order.len()).map(|i| i as f64).collect(),
                y: order
                    .iter()
                    .map(|&c| accs[s][c].value(spec.agg).unwrap_or(f64::NAN))
                    .collect(),
            })
            .collect();
        categories = order.iter().map(|&c| categories[c].clone()).collect();
        out
    } else {
        raw.resize_with(series_count, Series::default);
        sorted.resize(series_count, true);
        raw.into_iter()
            .enumerate()
            .map(|(s, mut line)| {
                line.name = name_of(s);
                if spec.kind == Kind::Line {
                    if !sorted[s] {
                        let mut order: Vec<u32> = (0..line.x.len() as u32).collect();
                        order.sort_by(|a, b| line.x[*a as usize].total_cmp(&line.x[*b as usize]));
                        line.x = order
                            .iter()
                            .map(|&i| line.x[i as usize])
                            .collect::<Vec<_>>();
                        line.y = order
                            .iter()
                            .map(|&i| line.y[i as usize])
                            .collect::<Vec<_>>();
                    }
                    merge_equal_x(&mut line, spec.agg);
                }
                line
            })
            .collect()
    };
    let mut extent: Option<(f64, f64)> = None;
    for line in &series {
        for x in &line.x {
            extent = Some(extent.map_or((*x, *x), |(a, b): (f64, f64)| (a.min(*x), b.max(*x))));
        }
    }
    Ok(Prepared {
        kind: spec.kind,
        x_kind,
        categories,
        series,
        extent,
        rows,
        nulls,
        skipped,
        cut_groups: cut_groups.len() as u64,
        cut_categories,
    })
}

/// Several values at one X become one (a line has one value per X); a gap stays a gap only where no
/// value is there.
fn merge_equal_x(line: &mut Series, agg: Agg) {
    let n = line.x.len();
    let mut out = 0usize;
    let mut i = 0usize;
    while i < n {
        let x = line.x[i];
        let mut j = i + 1;
        while j < n && line.x[j] == x {
            j += 1;
        }
        let y = if j == i + 1 && agg != Agg::Count {
            line.y[i]
        } else {
            let mut acc = Acc::EMPTY;
            for v in &line.y[i..j] {
                if !v.is_nan() {
                    acc.add(*v);
                }
            }
            acc.value(agg).unwrap_or(f64::NAN)
        };
        line.x[out] = x;
        line.y[out] = y;
        out += 1;
        i = j;
    }
    line.x.truncate(out);
    line.y.truncate(out);
}

/// The points of a chart for `width` pixels, of the range `range` of X (`None` = everything).
pub fn sample(chart: &Prepared, range: Option<(f64, f64)>, width: u32) -> ChartData {
    let width = width.clamp(50, 8000) as usize;
    let (lo, hi) = range
        .filter(|(a, b)| a.is_finite() && b.is_finite() && a <= b)
        .unwrap_or((f64::NEG_INFINITY, f64::INFINITY));
    let mut thinned = false;
    let series = chart
        .series
        .iter()
        .map(|s| {
            let (data, was_thinned) = match (chart.kind, chart.x_kind) {
                (_, XKind::Category) => (all_in(s, lo, hi), false),
                (Kind::Scatter, _) => scatter(s, lo, hi, width),
                _ => line(s, lo, hi, width),
            };
            thinned |= was_thinned;
            data
        })
        .collect();
    ChartData {
        kind: chart.kind,
        x_kind: chart.x_kind,
        categories: chart.categories.clone(),
        series,
        x_min: chart.extent.map(|e| e.0),
        x_max: chart.extent.map(|e| e.1),
        rows: chart.rows,
        nulls: chart.nulls,
        skipped: chart.skipped,
        cut_groups: chart.cut_groups,
        cut_categories: chart.cut_categories,
        thinned,
    }
}

fn gap(y: f64) -> Option<f64> {
    (!y.is_nan()).then_some(y)
}

fn all_in(s: &Series, lo: f64, hi: f64) -> SeriesData {
    let mut out = SeriesData {
        name: s.name.clone(),
        x: Vec::new(),
        y: Vec::new(),
        points: 0,
    };
    for (x, y) in s.x.iter().zip(&s.y) {
        if *x >= lo && *x <= hi {
            out.x.push(*x);
            out.y.push(gap(*y));
        }
    }
    out.points = out.x.len() as u64;
    out
}

/// A line in the range, one point more on each side (so it runs to the edge). More points than a few per
/// pixel: of each pixel column the first, the lowest, the highest and the last one – and a gap, if a NULL
/// lies in it.
fn line(s: &Series, lo: f64, hi: f64, width: usize) -> (SeriesData, bool) {
    let from = s.x.partition_point(|x| *x < lo).saturating_sub(1);
    let to = (s.x.partition_point(|x| *x <= hi) + 1).min(s.x.len());
    let (xs, ys) = (&s.x[from..to.max(from)], &s.y[from..to.max(from)]);
    let mut out = SeriesData {
        name: s.name.clone(),
        x: Vec::new(),
        y: Vec::new(),
        points: xs.len() as u64,
    };
    if xs.len() <= width * 4 {
        out.x = xs.to_vec();
        out.y = ys.iter().map(|y| gap(*y)).collect();
        return (out, false);
    }
    let (a, b) = (xs[0], xs[xs.len() - 1]);
    let span = (b - a).max(f64::MIN_POSITIVE);
    let bucket_of = |x: f64| (((x - a) / span) * width as f64).min(width as f64 - 1.0) as usize;
    let mut i = 0usize;
    while i < xs.len() {
        let bucket = bucket_of(xs[i]);
        let mut j = i;
        let (mut first, mut last, mut low, mut high) = (None, None, None::<usize>, None::<usize>);
        let mut hole = false;
        while j < xs.len() && bucket_of(xs[j]) == bucket {
            if ys[j].is_nan() {
                hole = true;
            } else {
                first.get_or_insert(j);
                last = Some(j);
                if low.is_none_or(|l| ys[j] < ys[l]) {
                    low = Some(j);
                }
                if high.is_none_or(|h| ys[j] > ys[h]) {
                    high = Some(j);
                }
            }
            j += 1;
        }
        let mut picked: Vec<usize> = [first, low, high, last].into_iter().flatten().collect();
        picked.sort_unstable();
        picked.dedup();
        if hole {
            // the gap stands where the bucket starts when it has no value before it, else at its end
            if picked.first().is_none_or(|p| *p > i) {
                out.x.push(xs[i]);
                out.y.push(None);
            }
            for p in &picked {
                out.x.push(xs[*p]);
                out.y.push(Some(ys[*p]));
            }
            if picked.first().is_some_and(|p| *p == i) {
                out.x.push(xs[j - 1]);
                out.y.push(None);
            }
        } else {
            for p in &picked {
                out.x.push(xs[*p]);
                out.y.push(Some(ys[*p]));
            }
        }
        i = j;
    }
    (out, true)
}

/// Points of a scatter plot that are all drawn.
const SCATTER_ALL: usize = 3_000;

/// The points of a scatter plot in the range; more than fit: one per cell of a grid as fine as the pixels.
fn scatter(s: &Series, lo: f64, hi: f64, width: usize) -> (SeriesData, bool) {
    let mut out = SeriesData {
        name: s.name.clone(),
        x: Vec::new(),
        y: Vec::new(),
        points: 0,
    };
    let inside = |x: f64, y: f64| x >= lo && x <= hi && !y.is_nan();
    let (mut x0, mut x1, mut y0, mut y1) = (
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
    );
    for (x, y) in s.x.iter().zip(&s.y) {
        if inside(*x, *y) {
            out.points += 1;
            x0 = x0.min(*x);
            x1 = x1.max(*x);
            y0 = y0.min(*y);
            y1 = y1.max(*y);
        }
    }
    // cells of a few pixels: a point is drawn that large, and the window draws every point
    let width = (width / 4).max(40);
    let height = (width / 2).max(20);
    if out.points as usize <= SCATTER_ALL {
        for (x, y) in s.x.iter().zip(&s.y) {
            if inside(*x, *y) {
                out.x.push(*x);
                out.y.push(Some(*y));
            }
        }
        return (out, false);
    }
    let cell = |v: f64, a: f64, b: f64, n: usize| {
        (((v - a) / (b - a).max(f64::MIN_POSITIVE)) * n as f64).min(n as f64 - 1.0) as usize
    };
    let mut taken = vec![0u64; (width * height).div_ceil(64)];
    for (x, y) in s.x.iter().zip(&s.y) {
        if !inside(*x, *y) {
            continue;
        }
        let at = cell(*y, y0, y1, height) * width + cell(*x, x0, x1, width);
        if taken[at / 64] & (1 << (at % 64)) == 0 {
            taken[at / 64] |= 1 << (at % 64);
            out.x.push(*x);
            out.y.push(Some(*y));
        }
    }
    (out, true)
}

/// The charts that are prepared: the last few, so that zooming does not read the result again.
#[derive(Default)]
pub struct ChartCache {
    next: std::sync::atomic::AtomicU64,
    charts: parking_lot::Mutex<std::collections::VecDeque<(u64, std::sync::Arc<Prepared>)>>,
}

/// Charts kept at a time (one per result area on screen, and one to spare).
const KEPT_CHARTS: usize = 3;

impl ChartCache {
    pub fn keep(&self, chart: Prepared) -> (u64, std::sync::Arc<Prepared>) {
        let id = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        let chart = std::sync::Arc::new(chart);
        let mut charts = self.charts.lock();
        charts.push_back((id, chart.clone()));
        while charts.len() > KEPT_CHARTS {
            charts.pop_front();
        }
        (id, chart)
    }

    pub fn get(&self, id: u64) -> Option<std::sync::Arc<Prepared>> {
        self.charts
            .lock()
            .iter()
            .find(|(i, _)| *i == id)
            .map(|(_, c)| c.clone())
    }

    pub fn free(&self, id: u64) {
        self.charts.lock().retain(|(i, _)| *i != id);
    }
}

#[cfg(test)]
#[path = "chart_tests.rs"]
mod tests;
