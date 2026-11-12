//! Comparing two results (prompt 041) over the result store: rows are matched by key columns or by
//! position; the outcome is a result of its own – every row with what became of it – plus a view of the
//! rows that differ. Pure: no Tauri, no database.
//!
//! Nothing here holds the rows of a side in memory: a side is read a few times from start to end, and what
//! is remembered of a row is a digest of its key (128 bits) and of its cells (64 bits). Two different keys
//! with the same digest would be taken for one key; with 128 bits that does not happen in practice.

use std::collections::{HashMap, HashSet};
use std::hash::Hasher;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::value::{ColKind, Column, MAX_TEXT_CHARS};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::results::ResultStore;

/// What became of a row, as the first cell of a row of the outcome. Signs, not words: they read the same
/// in every language and none starts a formula in a spreadsheet.
pub const SAME: &str = "≡";
pub const ONLY_LEFT: &str = "←";
pub const ONLY_RIGHT: &str = "→";
/// A row that is on both sides with other values: once as it is on the left, once as on the right.
pub const CHANGED_LEFT: &str = "≠←";
pub const CHANGED_RIGHT: &str = "≠→";
/// A row whose key occurs more than once on one of the sides: it is matched to nothing.
pub const DUPLICATE_LEFT: &str = "‼←";
pub const DUPLICATE_RIGHT: &str = "‼→";

/// The columns the outcome has before those of the results: the state and the names of changed columns.
pub const STATE_COLUMN: &str = "Δ";
pub const CHANGED_COLUMN: &str = "≠";
pub const EXTRA_COLUMNS: usize = 2;

/// Keys with duplicates that are named in the report.
const MAX_DUPLICATES_NAMED: usize = 10;
/// Characters of a key value in the report.
const KEY_CHARS: usize = 80;
/// Rows between two looks at `stop`.
const LOOK_EVERY: u64 = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareSpec {
    pub left: u64,
    pub right: u64,
    /// Columns of the left result that say which rows belong together; empty = by position.
    #[serde(default)]
    pub keys: Vec<u32>,
    /// Columns of the left result that are not compared.
    #[serde(default)]
    pub ignore: Vec<u32>,
    /// Leading and trailing white space does not count.
    #[serde(default)]
    pub trim: bool,
    #[serde(default)]
    pub ignore_case: bool,
    /// Numbers are the same when they are after rounding to so many decimals; `None` = as written.
    #[serde(default)]
    pub decimals: Option<u32>,
}

/// Which column of the left result goes with which of the right one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    /// `(left, right)`.
    pub pairs: Vec<(u32, u32)>,
    pub left_only: Vec<String>,
    pub right_only: Vec<String>,
    /// No two columns have the same name: the columns were paired by their place.
    pub by_position: bool,
}

/// Columns go together by name (case does not matter; of several with one name the first that is free).
/// When no name occurs on both sides, they go by position.
pub fn pair(left: &[Column], right: &[Column]) -> Pairing {
    let mut used = vec![false; right.len()];
    let mut pairs = Vec::new();
    for (l, column) in left.iter().enumerate() {
        let name = column.name.to_lowercase();
        if let Some(r) =
            (0..right.len()).find(|&r| !used[r] && right[r].name.to_lowercase() == name)
        {
            used[r] = true;
            pairs.push((l as u32, r as u32));
        }
    }
    let by_position = pairs.is_empty() && !left.is_empty() && !right.is_empty();
    if by_position {
        for (i, used) in used.iter_mut().enumerate().take(left.len()) {
            *used = true;
            pairs.push((i as u32, i as u32));
        }
    }
    let left_only = left
        .iter()
        .enumerate()
        .filter(|(l, _)| !pairs.iter().any(|p| p.0 as usize == *l))
        .map(|(_, c)| c.name.clone())
        .collect();
    let right_only = right
        .iter()
        .enumerate()
        .filter(|(r, _)| !used[*r])
        .map(|(_, c)| c.name.clone())
        .collect();
    Pairing {
        pairs,
        left_only,
        right_only,
        by_position,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnCount {
    pub name: String,
    pub rows: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareReport {
    /// The outcome: every row with its state. Freed like a result; the view goes with it.
    pub result_id: u64,
    pub columns: Vec<Column>,
    pub rows: u64,
    /// The view of the rows that are not the same on both sides.
    pub diff_id: u64,
    pub diff_rows: u64,
    pub left_rows: u64,
    pub right_rows: u64,
    pub same: u64,
    /// Rows on both sides with other values (each is two rows of the outcome).
    pub changed: u64,
    pub left_only: u64,
    pub right_only: u64,
    /// Rows that were not matched because their key is there more than once on one of the sides.
    pub duplicate_left: u64,
    pub duplicate_right: u64,
    /// Some of those keys, as text.
    pub duplicate_keys: Vec<String>,
    /// In how many rows each column differs (only columns that do).
    pub changed_by_column: Vec<ColumnCount>,
    pub left_columns_only: Vec<String>,
    pub right_columns_only: Vec<String>,
    pub by_position: bool,
    /// The outcome has more rows than the store takes: the numbers are right, rows are missing.
    pub cut: bool,
}

fn invalid(message: &str) -> AppError {
    AppError::new(ErrorCode::Unsupported, message)
}

fn damaged(e: serde_json::Error) -> AppError {
    AppError::new(ErrorCode::Io, format!("a stored row is damaged: {e}"))
}

/// A number as written → rounded to `decimals` (half away from zero), without zeros that say nothing.
/// `None`: the text is no number.
pub fn round_number(text: &str, decimals: u32) -> Option<String> {
    let t = text.trim();
    let (neg, rest) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    if rest.contains(['e', 'E']) {
        // with an exponent: by its value (a float anyway)
        let f: f64 = t.parse().ok()?;
        if !f.is_finite() {
            return None;
        }
        return round_number(&format!("{f:.*}", decimals.min(30) as usize + 2), decimals);
    }
    let (int, frac) = rest.split_once('.').unwrap_or((rest, ""));
    if (int.is_empty() && frac.is_empty())
        || !int.bytes().all(|b| b.is_ascii_digit())
        || !frac.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let keep = (decimals as usize).min(frac.len());
    let mut digits: Vec<u8> = int.bytes().chain(frac.bytes().take(keep)).collect();
    let up = frac.as_bytes().get(keep).is_some_and(|d| *d >= b'5');
    if up {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, b'1');
                break;
            }
            i -= 1;
            if digits[i] == b'9' {
                digits[i] = b'0';
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    let split = digits.len() - keep;
    let int: String = String::from_utf8_lossy(&digits[..split])
        .trim_start_matches('0')
        .to_owned();
    let frac: String = String::from_utf8_lossy(&digits[split..])
        .trim_end_matches('0')
        .to_owned();
    let mut out = String::new();
    let zero = int.is_empty() && frac.is_empty();
    if neg && !zero {
        out.push('-');
    }
    out.push_str(if int.is_empty() { "0" } else { &int });
    if !frac.is_empty() {
        out.push('.');
        out.push_str(&frac);
    }
    Some(out)
}

/// How cells are made comparable.
#[derive(Debug, Clone, Copy)]
struct Tolerance {
    trim: bool,
    ignore_case: bool,
    decimals: Option<u32>,
}

/// A cell as it is compared: `None` = NULL (which is equal to NULL and to nothing else).
type Norm = Option<String>;

fn norm(cell: &Value, numeric: bool, t: Tolerance) -> Norm {
    let text = match cell {
        Value::Null => return None,
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if let Some(decimals) = t.decimals
        && (numeric || cell.is_number())
        && let Some(n) = round_number(&text, decimals)
    {
        return Some(n);
    }
    let text = if t.trim { text.trim().to_owned() } else { text };
    Some(if t.ignore_case {
        text.to_lowercase()
    } else {
        text
    })
}

/// Whether a stored cell shows only the start of its value (see `Cell::serialize`).
fn is_cut(cell: &Value) -> bool {
    match cell {
        Value::String(s) => {
            s.len() > MAX_TEXT_CHARS && s.ends_with('…') && s.chars().count() == MAX_TEXT_CHARS + 1
        }
        Value::Object(o) => {
            let bytes = o.get("bytes").and_then(Value::as_u64).unwrap_or(0);
            let shown = o.get("hex").and_then(Value::as_str).map_or(0, str::len) as u64 / 2;
            bytes > shown
        }
        _ => false,
    }
}

fn sip(prefix: u8) -> std::collections::hash_map::DefaultHasher {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    h.write_u8(prefix);
    h
}

/// A digest of cells: 128 bits.
fn digest<'a>(cells: impl Iterator<Item = &'a Norm> + Clone) -> u128 {
    let one = |prefix: u8| {
        let mut h = sip(prefix);
        for cell in cells.clone() {
            match cell {
                None => h.write_u8(0),
                Some(text) => {
                    h.write_u8(1);
                    h.write_usize(text.len());
                    h.write(text.as_bytes());
                }
            }
        }
        h.finish()
    };
    ((one(0x4b) as u128) << 64) | one(0xa7) as u128
}

/// One side of the comparison.
struct Side<'a> {
    store: &'a ResultStore,
    id: u64,
    /// For each pair of columns: the column of this side.
    columns: Vec<usize>,
}

/// What is the same for both sides.
struct Plan {
    /// For each pair: is one of its columns a number?
    numeric: Vec<bool>,
    /// Pairs that are the key.
    keys: Vec<usize>,
    /// Pairs that are compared.
    compared: Vec<usize>,
    tolerance: Tolerance,
}

impl Side<'_> {
    fn parse(row: &str) -> AppResult<Vec<Value>> {
        serde_json::from_str(row).map_err(damaged)
    }

    /// The cell of pair `p` as it is compared. A value the row shows only the start of is read whole and
    /// stands as its digest (the tolerances do not reach into such values).
    fn norm(&self, row: u64, cells: &[Value], p: usize, plan: &Plan) -> AppResult<Norm> {
        let col = self.columns[p];
        let cell = cells.get(col).unwrap_or(&Value::Null);
        if is_cut(cell) {
            let (mut a, mut b) = (sip(1), sip(2));
            let mut bytes = 0u64;
            self.store
                .each_part(self.id, row, col as u32, &mut |part| {
                    a.write(part);
                    b.write(part);
                    bytes += part.len() as u64;
                    true
                })?;
            return Ok(Some(format!(
                "\u{0}whole:{bytes}:{:016x}{:016x}",
                a.finish(),
                b.finish()
            )));
        }
        Ok(norm(cell, plan.numeric[p], plan.tolerance))
    }

    fn norms(
        &self,
        row: u64,
        cells: &[Value],
        pairs: &[usize],
        plan: &Plan,
    ) -> AppResult<Vec<Norm>> {
        pairs
            .iter()
            .map(|&p| self.norm(row, cells, p, plan))
            .collect()
    }

    /// The cells of the pairs, in their order: what a row of the outcome shows.
    fn shown(&self, cells: &mut [Value]) -> Vec<Value> {
        self.columns
            .iter()
            .map(|&c| cells.get_mut(c).map(Value::take).unwrap_or(Value::Null))
            .collect()
    }

    /// Calls `f` with each row and its number; an error of `f` ends the walk.
    fn each(&self, f: &mut dyn FnMut(u64, &str) -> AppResult<()>) -> AppResult<()> {
        let rows = self.store.rows(self.id)?;
        let mut at = 0u64;
        let mut failed = None;
        self.store.each_row(self.id, 0, rows, &mut |row| {
            let result = f(at, row);
            at += 1;
            match result {
                Ok(()) => true,
                Err(e) => {
                    failed = Some(e);
                    false
                }
            }
        })?;
        failed.map_or(Ok(()), Err)
    }
}

/// Reads the rows of a result one after the other, a stretch at a time.
struct Reader<'a> {
    store: &'a ResultStore,
    id: u64,
    rows: u64,
    next: u64,
    buffer: std::collections::VecDeque<String>,
}

impl Reader<'_> {
    fn next(&mut self) -> AppResult<Option<(u64, String)>> {
        if self.buffer.is_empty() && self.next + (self.buffer.len() as u64) < self.rows {
            let to = (self.next + 1000).min(self.rows);
            let buffer = &mut self.buffer;
            self.store.each_row(self.id, self.next, to, &mut |row| {
                buffer.push_back(row.to_owned());
                true
            })?;
        }
        Ok(self.buffer.pop_front().map(|row| {
            self.next += 1;
            (self.next - 1, row)
        }))
    }
}

fn key_text(key: &[Norm]) -> String {
    key.iter()
        .map(|k| match k {
            None => "NULL".to_owned(),
            Some(text) if text.chars().count() > KEY_CHARS => {
                format!("{}…", text.chars().take(KEY_CHARS).collect::<String>())
            }
            Some(text) => text.clone(),
        })
        .collect::<Vec<_>>()
        .join(" | ")
}

/// Collects the rows of the outcome and counts.
struct Outcome<'a> {
    writer: crate::results::RawWriter<'a>,
    /// Rows of the outcome that are not `SAME`.
    diff: Vec<u64>,
    /// Rows the outcome would have without a limit.
    wanted: u64,
    same: u64,
    changed: u64,
    left_only: u64,
    right_only: u64,
    duplicate_left: u64,
    duplicate_right: u64,
    duplicate_keys: Vec<String>,
    named: HashSet<u128>,
    by_column: Vec<u64>,
}

impl Outcome<'_> {
    fn write(&mut self, state: &str, changed: Option<&str>, cells: Vec<Value>) -> AppResult<()> {
        let mut row = Vec::with_capacity(cells.len() + EXTRA_COLUMNS);
        row.push(Value::String(state.to_owned()));
        row.push(changed.map_or(Value::Null, |c| Value::String(c.to_owned())));
        row.extend(cells);
        let json = serde_json::to_vec(&row).map_err(damaged)?;
        let at = self.writer.rows();
        self.wanted += 1;
        if self.writer.row(&json)? && state != SAME {
            self.diff.push(at);
        }
        Ok(())
    }

    fn duplicate(&mut self, digest: u128, key: &[Norm]) {
        if self.duplicate_keys.len() < MAX_DUPLICATES_NAMED && self.named.insert(digest) {
            self.duplicate_keys.push(key_text(key));
        }
    }
}

/// Compares two results. `tell(done, of)` reports how far the work is (in rows read), `stop` is asked now
/// and then; `true` ends the work with `cancelled` and leaves nothing in the store.
pub fn compare(
    store: &ResultStore,
    spec: &CompareSpec,
    tell: &dyn Fn(u64, u64),
    stop: &dyn Fn() -> bool,
) -> AppResult<CompareReport> {
    let left_columns = store.columns(spec.left)?;
    let right_columns = store.columns(spec.right)?;
    let pairing = pair(&left_columns, &right_columns);
    if pairing.pairs.is_empty() {
        return Err(invalid("the results have no column in common"));
    }
    let pair_of = |left: u32| pairing.pairs.iter().position(|p| p.0 == left);
    let mut keys = Vec::new();
    for k in &spec.keys {
        let p =
            pair_of(*k).ok_or_else(|| invalid("a key column must be a column of both results"))?;
        if !keys.contains(&p) {
            keys.push(p);
        }
    }
    let compared: Vec<usize> = (0..pairing.pairs.len())
        .filter(|p| !spec.ignore.contains(&pairing.pairs[*p].0) && !keys.contains(p))
        .collect();
    let numeric_kind =
        |c: &Column| matches!(c.kind, ColKind::Int | ColKind::Float | ColKind::Decimal);
    let plan = Plan {
        numeric: pairing
            .pairs
            .iter()
            .map(|(l, r)| {
                numeric_kind(&left_columns[*l as usize])
                    || numeric_kind(&right_columns[*r as usize])
            })
            .collect(),
        keys,
        compared,
        tolerance: Tolerance {
            trim: spec.trim,
            ignore_case: spec.ignore_case,
            decimals: spec.decimals,
        },
    };
    let left = Side {
        store,
        id: spec.left,
        columns: pairing.pairs.iter().map(|p| p.0 as usize).collect(),
    };
    let right = Side {
        store,
        id: spec.right,
        columns: pairing.pairs.iter().map(|p| p.1 as usize).collect(),
    };
    let names: Vec<&str> = left
        .columns
        .iter()
        .map(|&c| left_columns[c].name.as_str())
        .collect();
    let text = |name: &str| Column {
        name: name.to_owned(),
        kind: ColKind::Text,
        type_name: String::new(),
    };
    let mut columns = vec![text(STATE_COLUMN), text(CHANGED_COLUMN)];
    columns.extend(left.columns.iter().map(|&c| left_columns[c].clone()));
    let mut out = Outcome {
        writer: store.writer(columns.clone())?,
        diff: Vec::new(),
        wanted: 0,
        same: 0,
        changed: 0,
        left_only: 0,
        right_only: 0,
        duplicate_left: 0,
        duplicate_right: 0,
        duplicate_keys: Vec::new(),
        named: HashSet::new(),
        by_column: vec![0; pairing.pairs.len()],
    };
    let out_id = out.writer.id();
    let left_rows = store.rows(spec.left)?;
    let right_rows = store.rows(spec.right)?;
    let worked = if plan.keys.is_empty() {
        by_position(&left, &right, &plan, &names, &mut out, tell, stop)
    } else {
        by_key(&left, &right, &plan, &names, &mut out, tell, stop)
    }
    .and_then(|()| out.writer.finish())
    .and_then(|rows| {
        let diff = store.subset(out_id, std::mem::take(&mut out.diff))?;
        Ok((rows, diff))
    });
    let (rows, diff) = match worked {
        Ok(done) => done,
        Err(e) => {
            store.free(out_id);
            return Err(e);
        }
    };
    Ok(CompareReport {
        result_id: out_id,
        columns,
        rows,
        diff_id: diff.result_id,
        diff_rows: diff.rows,
        left_rows,
        right_rows,
        same: out.same,
        changed: out.changed,
        left_only: out.left_only,
        right_only: out.right_only,
        duplicate_left: out.duplicate_left,
        duplicate_right: out.duplicate_right,
        duplicate_keys: out.duplicate_keys,
        changed_by_column: out
            .by_column
            .iter()
            .enumerate()
            .filter(|(_, n)| **n > 0)
            .map(|(p, n)| ColumnCount {
                name: names[p].to_owned(),
                rows: *n,
            })
            .collect(),
        left_columns_only: pairing.left_only,
        right_columns_only: pairing.right_only,
        by_position: pairing.by_position,
        cut: out.wanted > rows,
    })
}

/// Writes a pair of rows: the same, or changed with the columns that differ.
fn write_pair(
    plan: &Plan,
    names: &[&str],
    out: &mut Outcome,
    left: (&[Norm], Vec<Value>),
    right: (&[Norm], Vec<Value>),
) -> AppResult<()> {
    let differing: Vec<usize> = (0..plan.compared.len())
        .filter(|&i| left.0[i] != right.0[i])
        .map(|i| plan.compared[i])
        .collect();
    if differing.is_empty() {
        out.same += 1;
        return out.write(SAME, None, left.1);
    }
    out.changed += 1;
    for &p in &differing {
        out.by_column[p] += 1;
    }
    let changed = differing
        .iter()
        .map(|&p| names[p])
        .collect::<Vec<_>>()
        .join(", ");
    out.write(CHANGED_LEFT, Some(&changed), left.1)?;
    out.write(CHANGED_RIGHT, Some(&changed), right.1)
}

struct Ticker<'a> {
    done: u64,
    of: u64,
    tell: &'a dyn Fn(u64, u64),
    stop: &'a dyn Fn() -> bool,
}

impl Ticker<'_> {
    fn tick(&mut self) -> AppResult<()> {
        self.done += 1;
        if self.done.is_multiple_of(LOOK_EVERY) {
            if (self.stop)() {
                return Err(crate::db::cancelled());
            }
            (self.tell)(self.done, self.of);
        }
        Ok(())
    }
}

fn by_position(
    left: &Side,
    right: &Side,
    plan: &Plan,
    names: &[&str],
    out: &mut Outcome,
    tell: &dyn Fn(u64, u64),
    stop: &dyn Fn() -> bool,
) -> AppResult<()> {
    let right_rows = right.store.rows(right.id)?;
    let mut ticker = Ticker {
        done: 0,
        of: left.store.rows(left.id)? + right_rows,
        tell,
        stop,
    };
    let mut other = Reader {
        store: right.store,
        id: right.id,
        rows: right_rows,
        next: 0,
        buffer: Default::default(),
    };
    left.each(&mut |row, text| {
        ticker.tick()?;
        let mut cells = Side::parse(text)?;
        let Some((r, text)) = other.next()? else {
            out.left_only += 1;
            return out.write(ONLY_LEFT, None, left.shown(&mut cells));
        };
        ticker.tick()?;
        let mut theirs = Side::parse(&text)?;
        let a = left.norms(row, &cells, &plan.compared, plan)?;
        let b = right.norms(r, &theirs, &plan.compared, plan)?;
        write_pair(
            plan,
            names,
            out,
            (&a, left.shown(&mut cells)),
            (&b, right.shown(&mut theirs)),
        )
    })?;
    while let Some((_, text)) = other.next()? {
        ticker.tick()?;
        let mut cells = Side::parse(&text)?;
        out.right_only += 1;
        out.write(ONLY_RIGHT, None, right.shown(&mut cells))?;
    }
    Ok(())
}

/// The keys of a side that occur more than once.
fn duplicates(side: &Side, plan: &Plan, ticker: &mut Ticker) -> AppResult<HashSet<u128>> {
    let mut seen = HashSet::new();
    let mut twice = HashSet::new();
    side.each(&mut |row, text| {
        ticker.tick()?;
        let cells = Side::parse(text)?;
        let key = digest(side.norms(row, &cells, &plan.keys, plan)?.iter());
        if !seen.insert(key) {
            twice.insert(key);
        }
        Ok(())
    })?;
    Ok(twice)
}

fn by_key(
    left: &Side,
    right: &Side,
    plan: &Plan,
    names: &[&str],
    out: &mut Outcome,
    tell: &dyn Fn(u64, u64),
    stop: &dyn Fn() -> bool,
) -> AppResult<()> {
    let left_rows = left.store.rows(left.id)?;
    let right_rows = right.store.rows(right.id)?;
    if right_rows > u32::MAX as u64 {
        return Err(AppError::new(
            ErrorCode::TooLarge,
            "the right result has too many rows to compare by key",
        ));
    }
    let mut ticker = Ticker {
        done: 0,
        of: 2 * (left_rows + right_rows),
        tell,
        stop,
    };
    let left_twice = duplicates(left, plan, &mut ticker)?;
    // the right side: where each key is, and a digest of its row
    let mut where_right: HashMap<u128, (u32, u64)> = HashMap::with_capacity(right_rows as usize);
    let mut right_twice = HashSet::new();
    right.each(&mut |row, text| {
        ticker.tick()?;
        let cells = Side::parse(text)?;
        let key = digest(right.norms(row, &cells, &plan.keys, plan)?.iter());
        let rest = digest(right.norms(row, &cells, &plan.compared, plan)?.iter()) as u64;
        if where_right.insert(key, (row as u32, rest)).is_some() {
            right_twice.insert(key);
        }
        Ok(())
    })?;
    let mut matched = vec![0u64; (right_rows as usize).div_ceil(64)];
    left.each(&mut |row, text| {
        ticker.tick()?;
        let mut cells = Side::parse(text)?;
        let key = left.norms(row, &cells, &plan.keys, plan)?;
        let k = digest(key.iter());
        if left_twice.contains(&k) || right_twice.contains(&k) {
            // a key that is there twice – on either side – says not which rows belong together
            out.duplicate(k, &key);
            out.duplicate_left += 1;
            return out.write(DUPLICATE_LEFT, None, left.shown(&mut cells));
        }
        let Some(&(r, rest)) = where_right.get(&k) else {
            out.left_only += 1;
            return out.write(ONLY_LEFT, None, left.shown(&mut cells));
        };
        matched[r as usize / 64] |= 1 << (r % 64);
        let a = left.norms(row, &cells, &plan.compared, plan)?;
        if digest(a.iter()) as u64 == rest {
            out.same += 1;
            return out.write(SAME, None, left.shown(&mut cells));
        }
        let mut theirs = Side::parse(&right.store.row(right.id, r as u64)?)?;
        let b = right.norms(r as u64, &theirs, &plan.compared, plan)?;
        write_pair(
            plan,
            names,
            out,
            (&a, left.shown(&mut cells)),
            (&b, right.shown(&mut theirs)),
        )
    })?;
    right.each(&mut |row, text| {
        ticker.tick()?;
        if matched[row as usize / 64] & (1 << (row % 64)) != 0 {
            return Ok(());
        }
        let mut cells = Side::parse(text)?;
        let key = right.norms(row, &cells, &plan.keys, plan)?;
        let k = digest(key.iter());
        if right_twice.contains(&k) || left_twice.contains(&k) {
            out.duplicate(k, &key);
            out.duplicate_right += 1;
            return out.write(DUPLICATE_RIGHT, None, right.shown(&mut cells));
        }
        out.right_only += 1;
        out.write(ONLY_RIGHT, None, right.shown(&mut cells))
    })
}

#[cfg(test)]
#[path = "result_compare_tests.rs"]
mod tests;
