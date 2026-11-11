//! Where the rows of a statement live (prompt 006): in Rust, not in the web view. A driver writes rows into
//! a result as they arrive from the server; the window asks for the slice it shows (`window`). A result
//! starts in memory and moves to a file in the app's cache folder when it grows; the web view's memory does
//! not grow with the number of rows.
//!
//! A row is stored as the JSON it crosses the bridge with (`[cell, cell, …]`), so a window is cut out of the
//! store without building values again. Pure (no Tauri), tested below.

use crate::db::value::{Cell, Column, RowSink};
use crate::error::{AppError, AppResult, ErrorCode};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// A result is kept in memory up to this size, then in a file.
pub const MEMORY_BYTES: u64 = 32 * 1024 * 1024;
/// A result at most (bytes of its rows as JSON); more rows are cut off.
pub const MAX_RESULT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// Rows of a result at most: every row costs 8 bytes of index in memory.
pub const MAX_RESULT_ROWS: u64 = 50_000_000;
/// Rows of one window at most.
pub const MAX_WINDOW_ROWS: u64 = 5_000;
/// Text of a cell in a window, in characters; the stored value is longer (prompt 026 shows it in full).
pub const WINDOW_TEXT_CHARS: usize = 1_000;
/// Folders of results that old are leftovers of a crash.
const STALE: Duration = Duration::from_secs(24 * 3600);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreLimits {
    pub memory_bytes: u64,
    pub max_bytes: u64,
    pub max_rows: u64,
}

impl Default for StoreLimits {
    fn default() -> Self {
        Self {
            memory_bytes: MEMORY_BYTES,
            max_bytes: MAX_RESULT_BYTES,
            max_rows: MAX_RESULT_ROWS,
        }
    }
}

/// The rows of one statement.
struct ResultData {
    columns: Vec<Column>,
    /// Where each row starts; one more entry than rows (the end of the last one).
    offsets: Vec<u64>,
    /// The rows while they fit into memory.
    memory: Vec<u8>,
    /// The rows once they do not; `memory` is empty then.
    file: Option<File>,
    path: PathBuf,
    limits: StoreLimits,
    /// Values a row does not show whole (prompt 026): where each lies in the file of whole values. In the
    /// order they came, so sorted by row and column.
    whole: Vec<Whole>,
    /// The file of whole values: always a file – such values are large by definition.
    whole_file: Option<File>,
    whole_path: PathBuf,
    whole_bytes: u64,
}

#[derive(Debug, Clone, Copy)]
struct Whole {
    row: u64,
    col: u32,
    offset: u64,
    len: u64,
    binary: bool,
}

impl ResultData {
    /// Keeps the whole value of a cell whose row shows only its start.
    fn keep_whole(
        &mut self,
        row: u64,
        col: u32,
        bytes: &[u8],
        binary: bool,
    ) -> std::io::Result<()> {
        if self.whole_file.is_none() {
            self.whole_file = Some(
                File::options()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .open(&self.whole_path)?,
            );
        }
        let Some(file) = &mut self.whole_file else {
            return Ok(());
        };
        file.seek(SeekFrom::Start(self.whole_bytes))?;
        file.write_all(bytes)?;
        self.whole.push(Whole {
            row,
            col,
            offset: self.whole_bytes,
            len: bytes.len() as u64,
            binary,
        });
        self.whole_bytes += bytes.len() as u64;
        Ok(())
    }

    fn whole_of(&self, row: u64, col: u32) -> Option<Whole> {
        self.whole
            .binary_search_by(|w| (w.row, w.col).cmp(&(row, col)))
            .ok()
            .map(|i| self.whole[i])
    }

    fn read_whole(&mut self, whole: Whole, from: u64, len: u64) -> std::io::Result<Vec<u8>> {
        let from = from.min(whole.len);
        let len = len.min(whole.len - from);
        let mut out = vec![0u8; len as usize];
        if let Some(file) = &mut self.whole_file {
            file.seek(SeekFrom::Start(whole.offset + from))?;
            file.read_exact(&mut out)?;
        }
        Ok(out)
    }

    fn rows(&self) -> u64 {
        (self.offsets.len() - 1) as u64
    }

    fn bytes(&self) -> u64 {
        *self.offsets.last().unwrap_or(&0)
    }

    /// Appends serialized rows (`lengths` are theirs in `bytes`).
    fn append(&mut self, bytes: &[u8], lengths: &[usize]) -> std::io::Result<()> {
        if self.file.is_none() && self.bytes() + bytes.len() as u64 > self.limits.memory_bytes {
            // too big for memory: everything so far goes to the file, and the rest follows there
            let mut file = File::options()
                .read(true)
                .write(true)
                .create_new(true)
                .open(&self.path)?;
            file.write_all(&self.memory)?;
            self.memory = Vec::new();
            self.file = Some(file);
        }
        match &mut self.file {
            Some(file) => {
                file.seek(SeekFrom::End(0))?;
                file.write_all(bytes)?;
            }
            None => self.memory.extend_from_slice(bytes),
        }
        let mut end = self.bytes();
        for len in lengths {
            end += *len as u64;
            self.offsets.push(end);
        }
        Ok(())
    }

    /// The bytes of rows `from..to`.
    fn read(&mut self, from: u64, to: u64) -> std::io::Result<Vec<u8>> {
        let start = self.offsets[from as usize];
        let end = self.offsets[to as usize];
        match &mut self.file {
            Some(file) => {
                let mut out = vec![0u8; (end - start) as usize];
                file.seek(SeekFrom::Start(start))?;
                file.read_exact(&mut out)?;
                Ok(out)
            }
            None => Ok(self.memory[start as usize..end as usize].to_vec()),
        }
    }
}

impl Drop for ResultData {
    fn drop(&mut self) {
        if self.file.take().is_some() {
            let _ = fs::remove_file(&self.path);
        }
        if self.whole_file.take().is_some() {
            let _ = fs::remove_file(&self.whole_path);
        }
    }
}

/// All results of this process.
pub struct ResultStore {
    /// The folder of this process for results that left memory.
    dir: PathBuf,
    next: AtomicU64,
    results: Mutex<HashMap<u64, Arc<Mutex<ResultData>>>>,
    /// Views of results (prompt 027): the rows of a result in another order, or some of them. A view has
    /// an id like a result and is read like one; it holds no rows of its own.
    views: Mutex<HashMap<u64, Arc<View>>>,
    limits: StoreLimits,
}

/// Rows of a result, chosen and ordered: `order[i]` is the row of the result that is row `i` of the view.
struct View {
    base: u64,
    data: Arc<Mutex<ResultData>>,
    order: Vec<u64>,
}

/// Rows a result may have to be sorted here; beyond, sorting belongs on the server.
pub const MAX_SORT_ROWS: u64 = 5_000_000;
/// Rows a result may have to be filtered here.
pub const MAX_FILTER_ROWS: u64 = 50_000_000;

/// How to look at a result: only rows that hold a text, in the order of some columns.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSpec {
    /// Rows in which this text occurs (case does not matter); empty = all rows.
    #[serde(default)]
    pub text: String,
    /// The column to look in; `None` = every column.
    #[serde(default)]
    pub column: Option<u32>,
    #[serde(default)]
    pub sort: Vec<SortKey>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortKey {
    pub column: u32,
    #[serde(default)]
    pub desc: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewed {
    /// The id of the view: ask for its rows like for those of a result, free it like one.
    pub result_id: u64,
    pub rows: u64,
}

/// What a cell is for sorting: NULLs last, numbers by their value, the rest as text without regard to case.
#[derive(Debug, PartialEq)]
enum Key {
    Num(f64),
    Text(String),
    Null,
}

impl Key {
    fn of(cell: &serde_json::Value, numeric: bool) -> Key {
        match cell {
            serde_json::Value::Null => Key::Null,
            serde_json::Value::Bool(b) => Key::Num(f64::from(u8::from(*b))),
            serde_json::Value::Number(n) => Key::Num(n.as_f64().unwrap_or(0.0)),
            // big integers and decimals are text in a row: of a numeric column they sort as numbers
            serde_json::Value::String(s) if numeric => s
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|f| !f.is_nan())
                .map_or_else(|| Key::Text(s.to_lowercase()), Key::Num),
            serde_json::Value::String(s) => Key::Text(s.to_lowercase()),
            other => Key::Text(other.to_string()),
        }
    }

    fn cmp(&self, other: &Key) -> std::cmp::Ordering {
        use std::cmp::Ordering::{Equal, Greater, Less};
        match (self, other) {
            (Key::Null, Key::Null) => Equal,
            (Key::Null, _) => Greater,
            (_, Key::Null) => Less,
            (Key::Num(a), Key::Num(b)) => a.partial_cmp(b).unwrap_or(Equal),
            (Key::Num(_), Key::Text(_)) => Less,
            (Key::Text(_), Key::Num(_)) => Greater,
            (Key::Text(a), Key::Text(b)) => a.cmp(b),
        }
    }
}

/// The text of a cell as a filter reads it; `None` for NULL (a text never occurs in nothing).
fn cell_text(cell: &serde_json::Value) -> Option<std::borrow::Cow<'_, str>> {
    match cell {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(std::borrow::Cow::Borrowed(s)),
        serde_json::Value::Object(o) => o
            .get("hex")
            .and_then(|h| h.as_str())
            .map(std::borrow::Cow::Borrowed),
        other => Some(std::borrow::Cow::Owned(other.to_string())),
    }
}

fn unknown(id: u64) -> AppError {
    AppError::new(ErrorCode::UnknownResult, format!("no result {id}"))
}

fn io(e: std::io::Error) -> AppError {
    AppError::new(ErrorCode::Io, e.to_string())
}

impl ResultStore {
    /// `cache`: the app's cache folder. Results live in `cache/results/<pid>`; folders of processes that are
    /// long gone are removed.
    pub fn new(cache: &Path) -> Self {
        Self::with_limits(cache, StoreLimits::default())
    }

    pub fn with_limits(cache: &Path, limits: StoreLimits) -> Self {
        let root = cache.join("results");
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                let old = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age > STALE);
                if old {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
        let dir = root.join(std::process::id().to_string());
        // what a process with the same id left behind (after a restart of the machine) is not ours
        let _ = fs::remove_dir_all(&dir);
        Self {
            dir,
            next: AtomicU64::new(1),
            results: Mutex::new(HashMap::new()),
            views: Mutex::new(HashMap::new()),
            limits,
        }
    }

    /// A new, empty result with these columns.
    pub fn create(&self, columns: Vec<Column>) -> AppResult<u64> {
        fs::create_dir_all(&self.dir).map_err(io)?;
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let data = ResultData {
            columns,
            offsets: vec![0],
            memory: Vec::new(),
            file: None,
            path: self.dir.join(format!("{id}.rows")),
            limits: self.limits,
            whole: Vec::new(),
            whole_file: None,
            whole_path: self.dir.join(format!("{id}.values")),
            whole_bytes: 0,
        };
        self.results.lock().insert(id, Arc::new(Mutex::new(data)));
        Ok(id)
    }

    fn get(&self, id: u64) -> AppResult<Arc<Mutex<ResultData>>> {
        self.results
            .lock()
            .get(&id)
            .cloned()
            .ok_or_else(|| unknown(id))
    }

    pub fn rows(&self, id: u64) -> AppResult<u64> {
        if let Some(view) = self.view(id) {
            return Ok(view.order.len() as u64);
        }
        Ok(self.get(id)?.lock().rows())
    }

    pub fn columns(&self, id: u64) -> AppResult<Vec<Column>> {
        if let Some(view) = self.view(id) {
            return Ok(view.data.lock().columns.clone());
        }
        Ok(self.get(id)?.lock().columns.clone())
    }

    /// Whether the result lives in a file by now.
    pub fn on_disk(&self, id: u64) -> AppResult<bool> {
        Ok(self.get(id)?.lock().file.is_some())
    }

    /// Rows `from..from + count` (as far as they exist) as a JSON array of rows, ready for the bridge. Long
    /// texts are cut to [`WINDOW_TEXT_CHARS`].
    pub fn window(&self, id: u64, from: u64, count: u64) -> AppResult<String> {
        if let Some(view) = self.view(id) {
            // the rows of a view lie anywhere in its result: one by one
            let total = view.order.len() as u64;
            let from = from.min(total);
            let to = from.saturating_add(count.min(MAX_WINDOW_ROWS)).min(total);
            let mut out = String::from("[");
            for i in from..to {
                if i > from {
                    out.push(',');
                }
                push_row(
                    &mut out,
                    &Self::base_row(&view.data, view.order[i as usize])?,
                );
            }
            out.push(']');
            return Ok(out);
        }
        let data = self.get(id)?;
        let mut data = data.lock();
        let total = data.rows();
        let from = from.min(total);
        let to = from.saturating_add(count.min(MAX_WINDOW_ROWS)).min(total);
        if from == to {
            return Ok("[]".to_string());
        }
        let bytes = data.read(from, to).map_err(io)?;
        let base = data.offsets[from as usize];
        let mut out = String::with_capacity(bytes.len() + (to - from) as usize + 2);
        out.push('[');
        for row in from..to {
            let start = (data.offsets[row as usize] - base) as usize;
            let end = (data.offsets[row as usize + 1] - base) as usize;
            if row > from {
                out.push(',');
            }
            let text = std::str::from_utf8(&bytes[start..end]).map_err(|e| {
                AppError::new(ErrorCode::Io, format!("a stored row is damaged: {e}"))
            })?;
            push_row(&mut out, text);
        }
        out.push(']');
        Ok(out)
    }

    /// A part of the value of one cell – the whole value, not what a row shows of it (prompt 026).
    /// `from` and `max` are bytes; a text part ends at a character, so `to` can lie a few bytes behind
    /// `from + max`. Ask on from `to` until it is `total`.
    pub fn value(&self, id: u64, row: u64, col: u32, from: u64, max: u64) -> AppResult<CellValue> {
        // a row of a view is a row of its result
        let (data, row) = match self.view(id) {
            Some(view) => match view.order.get(row as usize) {
                Some(base_row) => (view.data.clone(), *base_row),
                None => return Err(AppError::new(ErrorCode::NotFound, "no such cell")),
            },
            None => (self.get(id)?, row),
        };
        let mut data = data.lock();
        if row >= data.rows() || col as usize >= data.columns.len() {
            return Err(AppError::new(ErrorCode::NotFound, "no such cell"));
        }
        let max = max.clamp(1, MAX_VALUE_PART);
        if let Some(whole) = data.whole_of(row, col) {
            let from = from.min(whole.len);
            // a few bytes more: a text part ends at a character
            let mut bytes = data.read_whole(whole, from, max + 4).map_err(io)?;
            if whole.binary {
                bytes.truncate(max as usize);
                let image = if from == 0 {
                    let head = data
                        .read_whole(whole, 0, crate::image_info::HEAD_BYTES as u64)
                        .map_err(io)?;
                    crate::image_info::image_info(&head)
                } else {
                    None
                };
                return Ok(CellValue::bytes(whole.len, from, &bytes, image));
            }
            return Ok(CellValue::text_part(whole.len, from, bytes, max as usize));
        }
        // the row shows the cell whole
        let stored = data.read(row, row + 1).map_err(io)?;
        let cells: Vec<serde_json::Value> = serde_json::from_slice(&stored)
            .map_err(|e| AppError::new(ErrorCode::Io, format!("a stored row is damaged: {e}")))?;
        let cell = cells
            .get(col as usize)
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        Ok(match cell {
            serde_json::Value::Null => CellValue::empty("null"),
            serde_json::Value::String(s) => {
                let total = s.len() as u64;
                let from = from.min(total) as usize;
                CellValue::text_part(
                    total,
                    from as u64,
                    s.as_bytes()[from..].to_vec(),
                    max as usize,
                )
            }
            serde_json::Value::Object(o) if o.contains_key("unreadable") => CellValue {
                text: o
                    .get("unreadable")
                    .and_then(|t| t.as_str())
                    .map(str::to_owned),
                ..CellValue::empty("unreadable")
            },
            serde_json::Value::Object(o) => {
                let bytes = data_encoding::HEXLOWER_PERMISSIVE
                    .decode(
                        o.get("hex")
                            .and_then(|h| h.as_str())
                            .unwrap_or("")
                            .as_bytes(),
                    )
                    .unwrap_or_default();
                let from = from.min(bytes.len() as u64) as usize;
                let image = crate::image_info::image_info(&bytes);
                CellValue::bytes(bytes.len() as u64, from as u64, &bytes[from..], image)
            }
            other => {
                let s = other.to_string();
                let total = s.len() as u64;
                CellValue::text_part(total, 0, s.into_bytes(), max as usize)
            }
        })
    }

    /// Calls `f` with the whole value of a cell piece by piece (for a file or the clipboard); answers with
    /// whether it is binary. `f` returns `false` to stop.
    pub fn each_part(
        &self,
        id: u64,
        row: u64,
        col: u32,
        f: &mut dyn FnMut(&[u8]) -> bool,
    ) -> AppResult<bool> {
        let mut from = 0;
        loop {
            let part = self.value(id, row, col, from, MAX_VALUE_PART)?;
            let binary = part.kind == "bytes";
            let bytes = match (&part.text, &part.base64) {
                (Some(text), _) if part.kind == "text" => text.as_bytes().to_vec(),
                (_, Some(b64)) => data_encoding::BASE64
                    .decode(b64.as_bytes())
                    .unwrap_or_default(),
                _ => Vec::new(),
            };
            if !bytes.is_empty() && !f(&bytes) {
                return Ok(binary);
            }
            if part.to >= part.total || part.to <= from {
                return Ok(binary);
            }
            from = part.to;
        }
    }

    /// Forgets a result and removes its file. Unknown ids are fine (freed twice).
    /// Calls `f` with the stored JSON of each row `from..to` (the cells whole, nothing cut), a chunk at a
    /// time so that windows can be read meanwhile. `f` returns `false` to stop.
    pub fn each_row(
        &self,
        id: u64,
        from: u64,
        to: u64,
        f: &mut dyn FnMut(&str) -> bool,
    ) -> AppResult<()> {
        const CHUNK: u64 = 1_000;
        if let Some(view) = self.view(id) {
            let to = to.min(view.order.len() as u64);
            for i in from..to {
                if !f(&Self::base_row(&view.data, view.order[i as usize])?) {
                    break;
                }
            }
            return Ok(());
        }
        let data = self.get(id)?;
        let mut at = from;
        loop {
            let mut data = data.lock();
            let end = to.min(data.rows());
            if at >= end {
                return Ok(());
            }
            let upto = (at + CHUNK).min(end);
            let bytes = data.read(at, upto).map_err(io)?;
            let base = data.offsets[at as usize];
            let bounds: Vec<(usize, usize)> = (at..upto)
                .map(|row| {
                    (
                        (data.offsets[row as usize] - base) as usize,
                        (data.offsets[row as usize + 1] - base) as usize,
                    )
                })
                .collect();
            drop(data);
            for (start, end) in bounds {
                let text = std::str::from_utf8(&bytes[start..end]).map_err(|e| {
                    AppError::new(ErrorCode::Io, format!("a stored row is damaged: {e}"))
                })?;
                if !f(text) {
                    return Ok(());
                }
            }
            at = upto;
        }
    }

    pub fn free(&self, id: u64) {
        self.results.lock().remove(&id);
        // a view goes with its id, and with the result it looks at
        self.views
            .lock()
            .retain(|view, v| *view != id && v.base != id);
    }

    fn view(&self, id: u64) -> Option<Arc<View>> {
        self.views.lock().get(&id).cloned()
    }

    /// Looks at a result through a filter and in an order (prompt 027): answers with the id of a view,
    /// which is read, copied and exported like a result. The rows stay where they are; the view is a list
    /// of row numbers. `stop` is asked now and then. Comparing is done here, not by the database: text
    /// without regard to case by its characters (no collation), NULLs last.
    pub fn derive(&self, id: u64, spec: &ViewSpec, stop: &dyn Fn() -> bool) -> AppResult<Viewed> {
        // a view of a view is a view of its result
        let (base, data) = match self.view(id) {
            Some(view) => (view.base, view.data.clone()),
            None => (id, self.get(id)?),
        };
        let (total, columns) = {
            let d = data.lock();
            (d.rows(), d.columns.clone())
        };
        let sorting = !spec.sort.is_empty();
        if sorting && total > MAX_SORT_ROWS {
            return Err(AppError::new(
                ErrorCode::TooLarge,
                format!("{total} rows are too many to sort here"),
            ));
        }
        if total > MAX_FILTER_ROWS {
            return Err(AppError::new(
                ErrorCode::TooLarge,
                "too many rows to filter here",
            ));
        }
        let wanted = |c: u32| (c as usize) < columns.len();
        if spec.sort.iter().any(|k| !wanted(k.column)) || spec.column.is_some_and(|c| !wanted(c)) {
            return Err(AppError::new(ErrorCode::NotFound, "no such column"));
        }
        let numeric: Vec<bool> = spec
            .sort
            .iter()
            .map(|k| {
                matches!(
                    columns[k.column as usize].kind,
                    crate::db::value::ColKind::Int
                        | crate::db::value::ColKind::Float
                        | crate::db::value::ColKind::Decimal
                )
            })
            .collect();
        let needle = spec.text.to_lowercase();
        let mut order: Vec<u64> = Vec::new();
        let mut keys: Vec<Vec<Key>> = Vec::new();
        let mut row = 0u64;
        let mut stopped = false;
        let mut damaged = false;
        self.each_base_row(&data, 0, total, &mut |text| {
            if row.is_multiple_of(4096) && stop() {
                stopped = true;
                return false;
            }
            let this = row;
            row += 1;
            // a row without the text cannot match: no need to read its cells
            let cells: Vec<serde_json::Value> = match serde_json::from_str(text) {
                Ok(cells) => cells,
                Err(_) => {
                    damaged = true;
                    return false;
                }
            };
            if !needle.is_empty() {
                let hit = |cell: &serde_json::Value| {
                    cell_text(cell).is_some_and(|t| t.to_lowercase().contains(&needle))
                };
                let found = match spec.column {
                    Some(c) => cells.get(c as usize).is_some_and(hit),
                    None => cells.iter().any(hit),
                };
                if !found {
                    return true;
                }
            }
            order.push(this);
            if sorting {
                keys.push(
                    spec.sort
                        .iter()
                        .zip(&numeric)
                        .map(|(k, numeric)| {
                            Key::of(
                                cells
                                    .get(k.column as usize)
                                    .unwrap_or(&serde_json::Value::Null),
                                *numeric,
                            )
                        })
                        .collect(),
                );
            }
            true
        })?;
        if stopped {
            return Err(AppError::new(ErrorCode::Cancelled, "stopped"));
        }
        if damaged {
            return Err(AppError::new(ErrorCode::Io, "a stored row is damaged"));
        }
        if sorting {
            let mut index: Vec<usize> = (0..order.len()).collect();
            index.sort_by(|a, b| {
                for (i, k) in spec.sort.iter().enumerate() {
                    let (x, y) = (&keys[*a][i], &keys[*b][i]);
                    // NULLs stay last in both directions
                    let ordering = match (x, y) {
                        (Key::Null, _) | (_, Key::Null) => x.cmp(y),
                        _ if k.desc => y.cmp(x),
                        _ => x.cmp(y),
                    };
                    if ordering != std::cmp::Ordering::Equal {
                        return ordering;
                    }
                }
                // equal keys: as the result has them
                order[*a].cmp(&order[*b])
            });
            order = index.into_iter().map(|i| order[i]).collect();
        }
        let rows = order.len() as u64;
        let view_id = self.next.fetch_add(1, Ordering::Relaxed);
        self.views
            .lock()
            .insert(view_id, Arc::new(View { base, data, order }));
        Ok(Viewed {
            result_id: view_id,
            rows,
        })
    }

    /// The stored JSON of rows `from..to` of a result, a chunk at a time.
    fn each_base_row(
        &self,
        data: &Arc<Mutex<ResultData>>,
        from: u64,
        to: u64,
        f: &mut dyn FnMut(&str) -> bool,
    ) -> AppResult<()> {
        const CHUNK: u64 = 1_000;
        let mut at = from;
        loop {
            let mut d = data.lock();
            let end = to.min(d.rows());
            if at >= end {
                return Ok(());
            }
            let upto = (at + CHUNK).min(end);
            let bytes = d.read(at, upto).map_err(io)?;
            let base = d.offsets[at as usize];
            let bounds: Vec<(usize, usize)> = (at..upto)
                .map(|row| {
                    (
                        (d.offsets[row as usize] - base) as usize,
                        (d.offsets[row as usize + 1] - base) as usize,
                    )
                })
                .collect();
            drop(d);
            for (start, end) in bounds {
                let text = std::str::from_utf8(&bytes[start..end]).map_err(|e| {
                    AppError::new(ErrorCode::Io, format!("a stored row is damaged: {e}"))
                })?;
                if !f(text) {
                    return Ok(());
                }
            }
            at = upto;
        }
    }

    /// One row of a result as it is stored.
    fn base_row(data: &Arc<Mutex<ResultData>>, row: u64) -> AppResult<String> {
        let mut d = data.lock();
        if row >= d.rows() {
            return Err(AppError::new(ErrorCode::NotFound, "no such row"));
        }
        let bytes = d.read(row, row + 1).map_err(io)?;
        String::from_utf8(bytes)
            .map_err(|e| AppError::new(ErrorCode::Io, format!("a stored row is damaged: {e}")))
    }

    pub fn len(&self) -> usize {
        self.results.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Drop for ResultStore {
    fn drop(&mut self) {
        self.results.lock().clear();
        let _ = fs::remove_dir(&self.dir);
    }
}

/// A stored row for a window: as it is when no text in it is long, else with its long texts cut.
fn push_row(out: &mut String, row: &str) {
    // a row shorter than the limit cannot hold a text longer than it
    if row.len() <= WINDOW_TEXT_CHARS {
        out.push_str(row);
        return;
    }
    match serde_json::from_str::<Vec<serde_json::Value>>(row) {
        Ok(mut cells) => {
            for cell in &mut cells {
                if let serde_json::Value::String(s) = cell
                    && let Some((at, _)) = s.char_indices().nth(WINDOW_TEXT_CHARS)
                {
                    s.truncate(at);
                    s.push('…');
                }
            }
            out.push_str(&serde_json::to_string(&cells).unwrap_or_else(|_| "[]".to_string()));
        }
        Err(_) => out.push_str(row),
    }
}

/// Bytes of a value handed out in one piece at most.
pub const MAX_VALUE_PART: u64 = 8 * 1024 * 1024;

/// A part of the value of a cell, as it crosses the bridge (prompt 026).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellValue {
    /// `null`, `text`, `bytes` or `unreadable` (then `text` names the type).
    pub kind: &'static str,
    /// Bytes of the whole value (of a text: in UTF-8).
    pub total: u64,
    /// The bytes this part covers.
    pub from: u64,
    pub to: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Binary data, Base64.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
    /// What picture a binary value is, read from its header (only with the first part).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<crate::image_info::ImageInfo>,
}

impl CellValue {
    fn empty(kind: &'static str) -> Self {
        Self {
            kind,
            total: 0,
            from: 0,
            to: 0,
            text: None,
            base64: None,
            image: None,
        }
    }

    fn bytes(
        total: u64,
        from: u64,
        part: &[u8],
        image: Option<crate::image_info::ImageInfo>,
    ) -> Self {
        Self {
            total,
            from,
            to: from + part.len() as u64,
            base64: Some(data_encoding::BASE64.encode(part)),
            image,
            ..Self::empty("bytes")
        }
    }

    /// `bytes` start at `from` and may hold a little more than `max`: the part ends at the first
    /// character boundary at or behind `max` (or where the bytes end).
    fn text_part(total: u64, from: u64, mut bytes: Vec<u8>, max: usize) -> Self {
        // a start inside a character (only a caller that does not use `to` gets there): skip its rest
        let lead = bytes
            .iter()
            .take(3)
            .take_while(|b| (**b & 0xc0) == 0x80)
            .count();
        let mut end = max.min(bytes.len());
        while end < bytes.len() && (bytes[end] & 0xc0) == 0x80 {
            end += 1;
        }
        bytes.truncate(end);
        let text = String::from_utf8_lossy(&bytes[lead.min(bytes.len())..]).into_owned();
        Self {
            total,
            from,
            to: from + end as u64,
            text: Some(text),
            ..Self::empty("text")
        }
    }
}

/// How often a sink tells how many rows there are.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
/// Rows a sink collects before it writes them into the store.
const BATCH_ROWS: usize = 512;
const BATCH_BYTES: usize = 256 * 1024;

/// What a sink reports while rows arrive.
pub enum Progress<'a> {
    /// The statement has a result: its id and columns. Sent once, before the first row is stored.
    Started { id: u64, columns: &'a [Column] },
    /// So many rows are stored by now.
    Rows(u64),
}

/// Writes the rows of a statement into the store, in batches, and reports progress.
pub struct StoreSink<'a> {
    store: &'a ResultStore,
    report: &'a (dyn Fn(Progress) + Send + Sync),
    id: Option<u64>,
    data: Option<Arc<Mutex<ResultData>>>,
    buffer: Vec<u8>,
    lengths: Vec<usize>,
    rows: u64,
    bytes: u64,
    last_report: Instant,
    /// The store could not take a row (disk full …): reading stops, the statement fails with this.
    pub error: Option<AppError>,
    /// A limit of the store was reached: the rest of the rows is cut off.
    pub full: bool,
}

impl<'a> StoreSink<'a> {
    pub fn new(store: &'a ResultStore, report: &'a (dyn Fn(Progress) + Send + Sync)) -> Self {
        Self {
            store,
            report,
            id: None,
            data: None,
            buffer: Vec::new(),
            lengths: Vec::new(),
            rows: 0,
            bytes: 0,
            last_report: Instant::now(),
            error: None,
            full: false,
        }
    }

    /// The result the rows went into, if the statement had one.
    pub fn result_id(&self) -> Option<u64> {
        self.id
    }

    pub fn rows(&self) -> u64 {
        self.rows
    }

    fn flush(&mut self) {
        if self.lengths.is_empty() {
            return;
        }
        if let Some(data) = &self.data
            && let Err(e) = data.lock().append(&self.buffer, &self.lengths)
        {
            self.error = Some(io(e));
        }
        self.buffer.clear();
        self.lengths.clear();
    }

    /// Writes what is still collected and reports the final count. Call when the statement ended.
    pub fn finish(&mut self) {
        self.flush();
        if self.id.is_some() {
            (self.report)(Progress::Rows(self.rows));
        }
    }
}

impl RowSink for StoreSink<'_> {
    fn start(&mut self, columns: &[Column]) {
        if self.id.is_some() {
            return;
        }
        match self.store.create(columns.to_vec()) {
            Ok(id) => {
                self.data = self.store.get(id).ok();
                self.id = Some(id);
                (self.report)(Progress::Started { id, columns });
            }
            Err(e) => self.error = Some(e),
        }
    }

    fn row(&mut self, cells: Vec<Cell>) -> bool {
        if self.error.is_some() || self.full {
            return false;
        }
        let limits = self.store.limits;
        // what the row will not show whole is kept apart, under the number this row gets
        let mut whole_bytes = 0u64;
        for (col, cell) in cells.iter().enumerate() {
            let Some((bytes, binary)) = cell.overflow() else {
                continue;
            };
            whole_bytes += bytes.len() as u64;
            if self.bytes + whole_bytes > limits.max_bytes {
                self.full = true;
                self.flush();
                return false;
            }
            if let Some(data) = &self.data
                && let Err(e) = data.lock().keep_whole(self.rows, col as u32, bytes, binary)
            {
                self.error = Some(io(e));
                return false;
            }
        }
        self.bytes += whole_bytes;
        let before = self.buffer.len();
        if serde_json::to_writer(&mut self.buffer, &cells).is_err() {
            self.buffer.truncate(before);
            self.buffer.extend_from_slice(b"[]");
        }
        let len = self.buffer.len() - before;
        if self.rows >= limits.max_rows || self.bytes + len as u64 > limits.max_bytes {
            self.buffer.truncate(before);
            self.full = true;
            self.flush();
            return false;
        }
        self.lengths.push(len);
        self.rows += 1;
        self.bytes += len as u64;
        if self.lengths.len() >= BATCH_ROWS || self.buffer.len() >= BATCH_BYTES {
            self.flush();
        }
        if self.last_report.elapsed() >= PROGRESS_EVERY {
            // what is reported is stored: the window can ask for it
            self.flush();
            self.last_report = Instant::now();
            (self.report)(Progress::Rows(self.rows));
        }
        self.error.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::value::ColKind;
    use serde_json::{Value, json};
    use tempfile::tempdir;

    fn columns() -> Vec<Column> {
        vec![
            Column {
                name: "id".into(),
                kind: ColKind::Int,
                type_name: "INT".into(),
            },
            Column {
                name: "name".into(),
                kind: ColKind::Text,
                type_name: "TEXT".into(),
            },
        ]
    }

    fn fill(store: &ResultStore, rows: u64) -> (u64, bool) {
        let quiet = |_: Progress| {};
        let mut sink = StoreSink::new(store, &quiet);
        sink.start(&columns());
        for i in 0..rows {
            if !sink.row(vec![
                Cell::I64(i as i64),
                Cell::Text(format!("Zeile {i} ä🚀")),
            ]) {
                break;
            }
        }
        sink.finish();
        assert!(sink.error.is_none());
        (sink.result_id().unwrap(), sink.full)
    }

    fn window(store: &ResultStore, id: u64, from: u64, count: u64) -> Value {
        serde_json::from_str(&store.window(id, from, count).unwrap()).unwrap()
    }

    #[test]
    fn gives_any_window_of_a_result_in_memory() {
        let dir = tempdir().unwrap();
        let store = ResultStore::new(dir.path());
        let (id, full) = fill(&store, 2000);
        assert!(!full);
        assert_eq!(store.rows(id).unwrap(), 2000);
        assert!(!store.on_disk(id).unwrap());
        assert_eq!(store.columns(id).unwrap().len(), 2);
        assert_eq!(
            window(&store, id, 0, 2),
            json!([[0, "Zeile 0 ä🚀"], [1, "Zeile 1 ä🚀"]])
        );
        assert_eq!(
            window(&store, id, 1998, 10),
            json!([[1998, "Zeile 1998 ä🚀"], [1999, "Zeile 1999 ä🚀"]])
        );
        assert_eq!(window(&store, id, 5000, 10), json!([]));
        assert_eq!(window(&store, id, 700, 1), json!([[700, "Zeile 700 ä🚀"]]));
    }

    #[test]
    fn moves_to_a_file_when_it_grows_and_cleans_up() {
        let dir = tempdir().unwrap();
        let limits = StoreLimits {
            memory_bytes: 10_000,
            ..StoreLimits::default()
        };
        let store = ResultStore::with_limits(dir.path(), limits);
        let (id, _) = fill(&store, 5000);
        assert!(store.on_disk(id).unwrap());
        assert_eq!(store.rows(id).unwrap(), 5000);
        // the same answers as from memory, also across the place where it moved
        assert_eq!(window(&store, id, 0, 1), json!([[0, "Zeile 0 ä🚀"]]));
        assert_eq!(
            window(&store, id, 4999, 1),
            json!([[4999, "Zeile 4999 ä🚀"]])
        );
        let middle = window(&store, id, 380, 40);
        assert_eq!(middle.as_array().unwrap().len(), 40);
        assert_eq!(middle[39], json!([419, "Zeile 419 ä🚀"]));
        let file = dir
            .path()
            .join("results")
            .join(std::process::id().to_string())
            .join(format!("{id}.rows"));
        assert!(file.exists());
        store.free(id);
        store.free(id);
        assert!(!file.exists());
        assert_eq!(
            store.window(id, 0, 1).unwrap_err().code,
            ErrorCode::UnknownResult
        );
        assert!(store.is_empty());
    }

    #[test]
    fn cuts_off_at_the_limits() {
        let dir = tempdir().unwrap();
        let store = ResultStore::with_limits(
            dir.path(),
            StoreLimits {
                max_rows: 100,
                ..StoreLimits::default()
            },
        );
        let (id, full) = fill(&store, 500);
        assert!(full);
        assert_eq!(store.rows(id).unwrap(), 100);
        let store = ResultStore::with_limits(
            dir.path(),
            StoreLimits {
                max_bytes: 1000,
                ..StoreLimits::default()
            },
        );
        let (id, full) = fill(&store, 500);
        assert!(full);
        let rows = store.rows(id).unwrap();
        assert!(rows > 10 && rows < 100, "{rows}");
    }

    #[test]
    fn a_window_cuts_long_texts_but_the_store_keeps_them() {
        let dir = tempdir().unwrap();
        let store = ResultStore::new(dir.path());
        let quiet = |_: Progress| {};
        let mut sink = StoreSink::new(&store, &quiet);
        sink.start(&columns());
        let long = "ä".repeat(WINDOW_TEXT_CHARS + 500);
        sink.row(vec![Cell::I64(1), Cell::Text(long.clone())]);
        sink.row(vec![Cell::Null, Cell::Text("kurz".into())]);
        sink.finish();
        let id = sink.result_id().unwrap();
        let w = window(&store, id, 0, 2);
        let cut = w[0][1].as_str().unwrap();
        assert_eq!(cut.chars().count(), WINDOW_TEXT_CHARS + 1);
        assert!(cut.ends_with('…'));
        assert_eq!(w[1], json!([null, "kurz"]));
    }

    #[test]
    fn reports_the_start_once_and_the_rows_as_they_come() {
        let dir = tempdir().unwrap();
        let store = ResultStore::new(dir.path());
        let seen = Mutex::new(Vec::new());
        let report = |p: Progress| {
            seen.lock().push(match p {
                Progress::Started { id, columns } => format!("started {id} {}", columns.len()),
                Progress::Rows(n) => format!("rows {n}"),
            })
        };
        let mut sink = StoreSink::new(&store, &report);
        sink.start(&columns());
        sink.start(&columns());
        for i in 0..10 {
            sink.row(vec![Cell::I64(i), Cell::Null]);
        }
        std::thread::sleep(PROGRESS_EVERY + Duration::from_millis(20));
        sink.row(vec![Cell::I64(10), Cell::Null]);
        // what was reported can be read at once
        assert_eq!(store.rows(sink.result_id().unwrap()).unwrap(), 11);
        sink.finish();
        let seen = seen.lock().clone();
        assert_eq!(seen.first().map(String::as_str), Some("started 1 2"));
        assert_eq!(seen.iter().filter(|s| s.starts_with("started")).count(), 1);
        assert_eq!(seen.last().map(String::as_str), Some("rows 11"));
    }

    #[test]
    fn removes_what_an_old_process_left_behind() {
        let dir = tempdir().unwrap();
        let old = dir.path().join("results").join("999999");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("1.rows"), b"x").unwrap();
        let long_ago = std::time::SystemTime::now() - Duration::from_secs(3 * 24 * 3600);
        File::open(&old).unwrap().set_modified(long_ago).unwrap();
        let fresh = dir.path().join("results").join("999998");
        fs::create_dir_all(&fresh).unwrap();
        let _store = ResultStore::new(dir.path());
        assert!(!old.exists());
        assert!(fresh.exists());
    }

    /// Prompt 026: the rows stay small, the whole value is there on request.
    #[test]
    fn keeps_whole_values_apart_and_hands_them_out_in_parts() {
        use crate::db::value::{MAX_TEXT_CHARS, text};
        let dir = tempdir().unwrap();
        let store = ResultStore::new(dir.path());
        let report = |_: Progress| {};
        let mut sink = StoreSink::new(&store, &report);
        sink.start(&columns());
        // row 0: short values; row 1: a long text with characters of several bytes; row 2: binary data
        let long: String = "ä😀x".repeat(MAX_TEXT_CHARS);
        let blob: Vec<u8> = (0..100_000u32).map(|n| (n % 251) as u8).collect();
        assert!(sink.row(vec![Cell::I64(1), Cell::Text("kurz".into())]));
        assert!(sink.row(vec![Cell::I64(2), Cell::Text(text(&long))]));
        assert!(sink.row(vec![Cell::Null, Cell::bytes(&blob)]));
        assert!(sink.row(vec![Cell::I64(4), Cell::bytes(&[1, 2, 3])]));
        sink.finish();
        let id = sink.result_id().unwrap();
        // the window still gets the start of the long text and of the bytes
        let window: Value = serde_json::from_str(&store.window(id, 0, 10).unwrap()).unwrap();
        assert_eq!(
            window[1][1].as_str().unwrap().chars().count(),
            WINDOW_TEXT_CHARS + 1
        );
        assert_eq!(window[2][1]["bytes"], json!(100_000));
        // a short value comes from its row
        let short = store.value(id, 0, 1, 0, 1000).unwrap();
        assert_eq!(
            (short.kind, short.text.as_deref(), short.total),
            ("text", Some("kurz"), 4)
        );
        assert_eq!(
            store.value(id, 0, 0, 0, 1000).unwrap().text.as_deref(),
            Some("1")
        );
        assert_eq!(store.value(id, 2, 0, 0, 1000).unwrap().kind, "null");
        let few = store.value(id, 3, 1, 0, 1000).unwrap();
        assert_eq!(
            (few.kind, few.total, few.base64.as_deref()),
            ("bytes", 3, Some("AQID"))
        );
        // the long text: piece by piece, each ending at a character, together the whole value
        let mut got = String::new();
        let mut from = 0;
        let mut parts = 0;
        loop {
            let part = store.value(id, 1, 1, from, 1000).unwrap();
            assert_eq!(part.total, long.len() as u64);
            assert_eq!(part.from, from);
            got.push_str(part.text.as_deref().unwrap());
            parts += 1;
            if part.to >= part.total {
                break;
            }
            assert!(part.to > from && part.to - from <= 1004);
            from = part.to;
        }
        assert_eq!(got, long);
        assert!(parts > 200);
        // the bytes: every one of them
        let mut all = Vec::new();
        let binary = store.each_part(id, 2, 1, &mut |b| {
            all.extend_from_slice(b);
            true
        });
        assert!(binary.unwrap());
        assert_eq!(all, blob);
        let mut text_bytes = Vec::new();
        assert_eq!(
            store.each_part(id, 1, 1, &mut |b| {
                text_bytes.extend_from_slice(b);
                true
            }),
            Ok(false)
        );
        assert_eq!(text_bytes, long.as_bytes());
        // a place behind the end, a cell that is not there
        let end = store.value(id, 1, 1, u64::MAX, 10).unwrap();
        assert_eq!(
            (end.from, end.to, end.text.as_deref()),
            (end.total, end.total, Some(""))
        );
        assert_eq!(
            store.value(id, 9, 0, 0, 10).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(
            store.value(id, 0, 9, 0, 10).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(
            store.value(999, 0, 0, 0, 10).unwrap_err().code,
            ErrorCode::UnknownResult
        );
        // the file of whole values goes with the result
        let values = dir
            .path()
            .join("results")
            .join(std::process::id().to_string())
            .join(format!("{id}.values"));
        assert!(values.exists());
        // the sink holds the result too: it is gone when both let go
        drop(sink);
        store.free(id);
        assert!(!values.exists());
    }

    #[test]
    fn says_what_picture_a_binary_value_is_and_counts_whole_values_against_the_limit() {
        let dir = tempdir().unwrap();
        let limits = StoreLimits {
            max_bytes: 50_000,
            ..StoreLimits::default()
        };
        let store = ResultStore::with_limits(dir.path(), limits);
        let report = |_: Progress| {};
        let mut sink = StoreSink::new(&store, &report);
        sink.start(&columns());
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR\0\0\x02\x80\0\0\x01\xe0".to_vec();
        png.resize(20_000, 7);
        assert!(sink.row(vec![Cell::I64(1), Cell::bytes(&png)]));
        assert!(sink.row(vec![Cell::I64(2), Cell::bytes(&png)]));
        // the third does not fit any more: the result is cut there
        assert!(!sink.row(vec![Cell::I64(3), Cell::bytes(&png)]));
        assert!(sink.full);
        sink.finish();
        let id = sink.result_id().unwrap();
        assert_eq!(store.rows(id).unwrap(), 2);
        let first = store.value(id, 1, 1, 0, 1000).unwrap();
        let image = first.image.unwrap();
        assert_eq!(
            (image.mime, image.width, image.height),
            ("image/png", 640, 480)
        );
        // only the first part says it
        assert!(store.value(id, 1, 1, 1000, 1000).unwrap().image.is_none());
    }

    /// Prompt 027: a result seen through a filter and in an order – without a row being copied.
    #[test]
    fn views_filter_and_sort_a_result_where_it_lies() {
        let dir = tempdir().unwrap();
        let store = ResultStore::new(dir.path());
        let report = |_: Progress| {};
        let mut sink = StoreSink::new(&store, &report);
        sink.start(&columns());
        let names = ["Zoe", "anna", "Ärger", "Bob", "anna-lena", "10", "9"];
        for (i, name) in names.iter().enumerate() {
            let id = if i == 3 {
                Cell::Null
            } else {
                Cell::I64(20 - i as i64 * 3)
            };
            assert!(sink.row(vec![id, Cell::Text((*name).into())]));
        }
        assert!(sink.row(vec![Cell::I64(7), Cell::Null]));
        sink.finish();
        let id = sink.result_id().unwrap();
        let never = || false;
        let col = |view: u64, c: usize| -> Value {
            let rows: Vec<Vec<Value>> =
                serde_json::from_str(&store.window(view, 0, 100).unwrap()).unwrap();
            Value::Array(rows.into_iter().map(|r| r[c].clone()).collect())
        };
        let sort = |column: u32, desc: bool| ViewSpec {
            sort: vec![SortKey { column, desc }],
            ..ViewSpec::default()
        };
        // numbers by their value, NULL last – also downwards
        let up = store.derive(id, &sort(0, false), &never).unwrap();
        assert_eq!(up.rows, 8);
        assert_eq!(col(up.result_id, 0), json!([2, 5, 7, 8, 14, 17, 20, null]));
        let down = store.derive(id, &sort(0, true), &never).unwrap();
        assert_eq!(
            col(down.result_id, 0),
            json!([20, 17, 14, 8, 7, 5, 2, null])
        );
        // text without regard to case, by its characters (no collation: Ä comes behind z)
        let by_name = store.derive(id, &sort(1, false), &never).unwrap();
        assert_eq!(
            col(by_name.result_id, 1),
            json!(["10", "9", "anna", "anna-lena", "Bob", "Zoe", "Ärger", null])
        );
        // a filter: rows that hold the text anywhere, or in one column
        let anna = ViewSpec {
            text: "ANNA".into(),
            ..ViewSpec::default()
        };
        let found = store.derive(id, &anna, &never).unwrap();
        assert_eq!(col(found.result_id, 1), json!(["anna", "anna-lena"]));
        let in_id = ViewSpec {
            text: "1".into(),
            column: Some(0),
            sort: vec![SortKey {
                column: 0,
                desc: true,
            }],
        };
        let ones = store.derive(id, &in_id, &never).unwrap();
        assert_eq!(col(ones.result_id, 0), json!([17, 14]));
        // a view is read like a result: rows, columns, values, rows for copying
        assert_eq!(store.rows(ones.result_id).unwrap(), 2);
        assert_eq!(store.columns(ones.result_id).unwrap().len(), 2);
        assert_eq!(
            store
                .value(ones.result_id, 1, 1, 0, 100)
                .unwrap()
                .text
                .as_deref(),
            Some("Ärger")
        );
        assert_eq!(
            store.value(ones.result_id, 2, 1, 0, 100).unwrap_err().code,
            ErrorCode::NotFound
        );
        let mut copied = Vec::new();
        store
            .each_row(ones.result_id, 0, 10, &mut |row| {
                copied.push(row.to_owned());
                true
            })
            .unwrap();
        assert_eq!(copied, vec![r#"[17,"anna"]"#, r#"[14,"Ärger"]"#]);
        // a view of a view looks at the result; nothing found is an empty view
        let again = store
            .derive(ones.result_id, &sort(0, false), &never)
            .unwrap();
        assert_eq!(again.rows, 8);
        let none = ViewSpec {
            text: "gibt es nicht".into(),
            ..ViewSpec::default()
        };
        assert_eq!(store.derive(id, &none, &never).unwrap().rows, 0);
        // stopping, a column that is not there
        assert_eq!(
            store
                .derive(id, &sort(0, false), &|| true)
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        assert_eq!(
            store.derive(id, &sort(9, false), &never).unwrap_err().code,
            ErrorCode::NotFound
        );
        // a view goes alone, and all of them with their result
        store.free(up.result_id);
        assert_eq!(
            store.rows(up.result_id).unwrap_err().code,
            ErrorCode::UnknownResult
        );
        assert_eq!(store.rows(down.result_id).unwrap(), 8);
        drop(sink);
        store.free(id);
        assert_eq!(
            store.rows(down.result_id).unwrap_err().code,
            ErrorCode::UnknownResult
        );
    }

    #[test]
    fn sorts_many_rows_stably_and_fast() {
        let dir = tempdir().unwrap();
        let store = ResultStore::new(dir.path());
        let report = |_: Progress| {};
        let mut sink = StoreSink::new(&store, &report);
        sink.start(&columns());
        for i in 0..200_000i64 {
            sink.row(vec![Cell::I64(i % 1000), Cell::Text(format!("n{i}"))]);
        }
        sink.finish();
        let id = sink.result_id().unwrap();
        let started = Instant::now();
        let spec = ViewSpec {
            sort: vec![SortKey {
                column: 0,
                desc: true,
            }],
            ..ViewSpec::default()
        };
        let view = store.derive(id, &spec, &|| false).unwrap();
        assert!(started.elapsed() < Duration::from_secs(20));
        let rows: Vec<Vec<Value>> =
            serde_json::from_str(&store.window(view.result_id, 0, 3).unwrap()).unwrap();
        // equal keys keep the order of the result
        assert_eq!(
            rows,
            vec![
                vec![json!(999), json!("n999")],
                vec![json!(999), json!("n1999")],
                vec![json!(999), json!("n2999")]
            ]
        );
    }
}
