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
}

impl ResultData {
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
    }
}

/// All results of this process.
pub struct ResultStore {
    /// The folder of this process for results that left memory.
    dir: PathBuf,
    next: AtomicU64,
    results: Mutex<HashMap<u64, Arc<Mutex<ResultData>>>>,
    limits: StoreLimits,
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
        Ok(self.get(id)?.lock().rows())
    }

    pub fn columns(&self, id: u64) -> AppResult<Vec<Column>> {
        Ok(self.get(id)?.lock().columns.clone())
    }

    /// Whether the result lives in a file by now.
    pub fn on_disk(&self, id: u64) -> AppResult<bool> {
        Ok(self.get(id)?.lock().file.is_some())
    }

    /// Rows `from..from + count` (as far as they exist) as a JSON array of rows, ready for the bridge. Long
    /// texts are cut to [`WINDOW_TEXT_CHARS`].
    pub fn window(&self, id: u64, from: u64, count: u64) -> AppResult<String> {
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

    /// Forgets a result and removes its file. Unknown ids are fine (freed twice).
    pub fn free(&self, id: u64) {
        self.results.lock().remove(&id);
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
}
