//! Rows into a file (prompt 011): from the result store or straight from the server, in the formats of
//! [`crate::extract`] plus Excel. Written next to the target and renamed at the end – a target is never
//! left half written; a failure or a stop removes what was begun. Pure of Tauri.

use crate::db::value::{Cell, ColKind, Column, RowSink};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::extract::{Extractor, Format, Options};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Rows a sheet of Excel takes, with its header.
pub const XLSX_MAX_ROWS: u64 = 1_048_576;
/// Characters a cell of Excel takes.
pub const XLSX_MAX_CHARS: usize = 32_767;
/// The text is written to the file when it has grown to this.
const FLUSH_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileFormat {
    Csv,
    Tsv,
    Json,
    Ndjson,
    Insert,
    Markdown,
    Html,
    Xlsx,
}

impl FileFormat {
    fn text(self) -> Option<Format> {
        Some(match self {
            FileFormat::Csv => Format::Csv,
            FileFormat::Tsv => Format::Tsv,
            FileFormat::Json => Format::Json,
            FileFormat::Ndjson => Format::Ndjson,
            FileFormat::Insert => Format::Insert,
            FileFormat::Markdown => Format::Markdown,
            FileFormat::Html => Format::Html,
            FileFormat::Xlsx => return None,
        })
    }
}

/// What to write and how.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub format: FileFormat,
    #[serde(default)]
    pub options: Options,
    /// Start a text file with the byte order mark (Excel reads UTF-8 CSV only with it).
    #[serde(default)]
    pub bom: bool,
    /// Compress a text file (`.gz`).
    #[serde(default)]
    pub gzip: bool,
    /// Indices of the columns to write; none = all.
    #[serde(default)]
    pub columns: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exported {
    pub rows: u64,
    /// Size of the file.
    pub bytes: u64,
    /// Rows were left out: Excel takes no more.
    pub truncated: bool,
    /// Cells whose text was cut to what Excel takes.
    pub cut_cells: u64,
}

fn io(path: &Path, e: &std::io::Error) -> AppError {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => AppError::new(
            ErrorCode::PermissionDenied,
            format!("no permission to write „{name}“"),
        ),
        std::io::ErrorKind::StorageFull => {
            AppError::new(ErrorCode::Io, format!("the disk is full („{name}“)"))
        }
        std::io::ErrorKind::NotFound => AppError::new(
            ErrorCode::NotFound,
            format!("the folder of „{name}“ does not exist"),
        ),
        _ => AppError::new(ErrorCode::Io, format!("„{name}“: {e}")),
    }
}

enum Target {
    Text {
        extractor: Box<Extractor>,
        buffer: String,
        out: Box<dyn Write + Send>,
    },
    Xlsx {
        workbook: Box<rust_xlsxwriter::Workbook>,
        kinds: Vec<ColKind>,
    },
}

/// A file that is being written. Dropped before [`FileWriter::finish`], it removes what it began.
pub struct FileWriter {
    path: PathBuf,
    temp: PathBuf,
    target: Option<Target>,
    picked: Vec<usize>,
    rows: u64,
    truncated: bool,
    cut_cells: u64,
    done: bool,
}

fn xlsx(e: rust_xlsxwriter::XlsxError) -> AppError {
    AppError::new(ErrorCode::Io, format!("Excel file: {e}"))
}

impl FileWriter {
    /// Begins the file for rows with `columns`. `path` comes from the save dialog: absolute, its folder
    /// there.
    pub fn create(path: &Path, spec: &Spec, columns: &[Column]) -> AppResult<Self> {
        if !path.is_absolute() {
            return Err(AppError::new(ErrorCode::Io, "the target is no full path"));
        }
        let dir = path
            .parent()
            .ok_or_else(|| AppError::new(ErrorCode::Io, "the target has no folder"))?;
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        let temp = dir.join(format!(".{name}.part-{}", std::process::id()));
        let picked = crate::copy::pick_columns(&spec.columns, columns.len());
        let chosen: Vec<Column> = picked.iter().map(|&c| columns[c].clone()).collect();
        let target = match spec.format.text() {
            Some(format) => {
                let file = std::fs::File::create(&temp).map_err(|e| io(path, &e))?;
                let mut out: Box<dyn Write + Send> = if spec.gzip {
                    Box::new(flate2::write::GzEncoder::new(
                        std::io::BufWriter::new(file),
                        flate2::Compression::default(),
                    ))
                } else {
                    Box::new(std::io::BufWriter::new(file))
                };
                if spec.bom {
                    out.write_all(&[0xEF, 0xBB, 0xBF])
                        .map_err(|e| io(path, &e))?;
                }
                let options = Options {
                    final_newline: true,
                    ..spec.options.clone()
                };
                let mut extractor = Box::new(Extractor::new(format, options, chosen));
                let mut buffer = String::new();
                extractor.begin(&mut buffer);
                Target::Text {
                    extractor,
                    buffer,
                    out,
                }
            }
            None => {
                let mut workbook = Box::new(rust_xlsxwriter::Workbook::new());
                let sheet = workbook
                    .add_worksheet_with_constant_memory()
                    .map_err(xlsx)?;
                for (i, c) in chosen.iter().enumerate() {
                    sheet
                        .write_string(0, i as u16, cut_cell(&c.name).0)
                        .map_err(xlsx)?;
                }
                Target::Xlsx {
                    workbook,
                    kinds: chosen.iter().map(|c| c.kind).collect(),
                }
            }
        };
        Ok(Self {
            path: path.to_path_buf(),
            temp,
            target: Some(target),
            picked,
            rows: 0,
            truncated: false,
            cut_cells: 0,
            done: false,
        })
    }

    pub fn rows(&self) -> u64 {
        self.rows
    }

    /// Appends a row (all cells of the result; the chosen columns are taken from it). `Ok(false)`: the
    /// file takes no more rows.
    pub fn row(&mut self, cells: &[Value]) -> AppResult<bool> {
        let null = Value::Null;
        let projected: Vec<Value> = self
            .picked
            .iter()
            .map(|&c| cells.get(c).unwrap_or(&null).clone())
            .collect();
        match self.target.as_mut() {
            Some(Target::Text {
                extractor,
                buffer,
                out,
            }) => {
                extractor.row(&projected, buffer);
                if buffer.len() >= FLUSH_BYTES {
                    out.write_all(buffer.as_bytes())
                        .map_err(|e| io(&self.path, &e))?;
                    buffer.clear();
                }
            }
            Some(Target::Xlsx { workbook, kinds }) => {
                if self.rows + 1 >= XLSX_MAX_ROWS {
                    self.truncated = true;
                    return Ok(false);
                }
                let row = (self.rows + 1) as u32;
                let sheet = workbook.worksheet_from_index(0).map_err(xlsx)?;
                for (i, value) in projected.iter().enumerate() {
                    let col = i as u16;
                    match value {
                        Value::Null => {}
                        Value::Bool(b) => {
                            sheet.write_boolean(row, col, *b).map_err(xlsx)?;
                        }
                        Value::Number(n) => {
                            sheet
                                .write_number(row, col, n.as_f64().unwrap_or(0.0))
                                .map_err(xlsx)?;
                        }
                        // numbers that came as text have more digits than Excel keeps: they stay text
                        other => {
                            let text = match other {
                                Value::String(s) => s.clone(),
                                v => crate::extract::plain_text(v).unwrap_or_default(),
                            };
                            let _ = kinds;
                            let (text, cut) = cut_cell(&text);
                            if cut {
                                self.cut_cells += 1;
                            }
                            sheet.write_string(row, col, text).map_err(xlsx)?;
                        }
                    }
                }
            }
            None => {}
        }
        self.rows += 1;
        Ok(true)
    }

    /// Ends the file and puts it at its place.
    pub fn finish(mut self) -> AppResult<Exported> {
        match self.target.take() {
            Some(Target::Text {
                mut extractor,
                mut buffer,
                mut out,
            }) => {
                extractor.end(&mut buffer);
                out.write_all(buffer.as_bytes())
                    .and_then(|()| out.flush())
                    .map_err(|e| io(&self.path, &e))?;
                // a gzip stream ends when its writer is dropped
                drop(out);
            }
            Some(Target::Xlsx { mut workbook, .. }) => {
                workbook.save(&self.temp).map_err(xlsx)?;
            }
            None => {}
        }
        std::fs::rename(&self.temp, &self.path).map_err(|e| io(&self.path, &e))?;
        self.done = true;
        let bytes = std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        Ok(Exported {
            rows: self.rows,
            bytes,
            truncated: self.truncated,
            cut_cells: self.cut_cells,
        })
    }
}

impl Drop for FileWriter {
    fn drop(&mut self) {
        if !self.done {
            self.target = None;
            let _ = std::fs::remove_file(&self.temp);
        }
    }
}

/// A text as a cell of Excel takes it, and whether it was cut.
fn cut_cell(text: &str) -> (&str, bool) {
    match text.char_indices().nth(XLSX_MAX_CHARS) {
        Some((at, _)) => (&text[..at], true),
        None => (text, false),
    }
}

/// Rows of the result store into a file. `progress` hears the rows written so far, now and then; `stop`
/// ends the work with `cancelled`.
pub fn from_store(
    store: &crate::results::ResultStore,
    result_id: u64,
    rows: &[(u64, u64)],
    path: &Path,
    spec: &Spec,
    progress: &dyn Fn(u64),
    stop: &dyn Fn() -> bool,
) -> AppResult<Exported> {
    let columns = store.columns(result_id)?;
    let ranges = crate::copy::merge_rows(rows, store.rows(result_id)?);
    let mut writer = FileWriter::create(path, spec, &columns)?;
    let mut failed: Option<AppError> = None;
    let mut full = false;
    for (first, last) in ranges {
        store.each_row(result_id, first, last + 1, &mut |row| {
            if writer.rows().is_multiple_of(1024) {
                if stop() {
                    failed = Some(crate::db::cancelled());
                    return false;
                }
                progress(writer.rows());
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
            match writer.row(&cells) {
                Ok(true) => true,
                Ok(false) => {
                    full = true;
                    false
                }
                Err(e) => {
                    failed = Some(e);
                    false
                }
            }
        })?;
        if failed.is_some() || full {
            break;
        }
    }
    if let Some(e) = failed {
        return Err(e);
    }
    writer.finish()
}

/// Takes the rows of a statement as the driver reads them and writes them to a file: the memory needed
/// does not grow with the result.
pub struct FileSink<'a> {
    path: PathBuf,
    spec: Spec,
    writer: Option<FileWriter>,
    progress: &'a (dyn Fn(u64) + Send + Sync),
    /// Why writing ended early.
    pub error: Option<AppError>,
    /// The file took no more rows.
    pub full: bool,
}

impl<'a> FileSink<'a> {
    pub fn new(path: &Path, spec: Spec, progress: &'a (dyn Fn(u64) + Send + Sync)) -> Self {
        Self {
            path: path.to_path_buf(),
            spec,
            writer: None,
            progress,
            error: None,
            full: false,
        }
    }

    /// Ends the file. A statement without a result leaves no file.
    pub fn finish(mut self) -> AppResult<Exported> {
        if let Some(e) = self.error.take() {
            return Err(e);
        }
        match self.writer.take() {
            Some(writer) => writer.finish(),
            None => Err(AppError::new(
                ErrorCode::InvalidQuery,
                "the statement has no result to export",
            )),
        }
    }
}

impl RowSink for FileSink<'_> {
    fn start(&mut self, columns: &[Column]) {
        match FileWriter::create(&self.path, &self.spec, columns) {
            Ok(writer) => self.writer = Some(writer),
            Err(e) => self.error = Some(e),
        }
    }

    fn row(&mut self, cells: Vec<Cell>) -> bool {
        let Some(writer) = self.writer.as_mut() else {
            return false;
        };
        let values: Vec<Value> = cells
            .iter()
            .map(|c| serde_json::to_value(c).unwrap_or(Value::Null))
            .collect();
        match writer.row(&values) {
            Ok(true) => {
                if writer.rows().is_multiple_of(1024) {
                    (self.progress)(writer.rows());
                }
                true
            }
            Ok(false) => {
                self.full = true;
                false
            }
            Err(e) => {
                self.error = Some(e);
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::results::{Progress, ResultStore, StoreSink};
    use std::io::Read;
    use tempfile::tempdir;

    fn columns() -> Vec<Column> {
        ["id", "name", "note"]
            .iter()
            .zip([ColKind::Int, ColKind::Text, ColKind::Text])
            .map(|(name, kind)| Column {
                name: (*name).into(),
                kind,
                type_name: String::new(),
            })
            .collect()
    }

    fn fill(store: &ResultStore, rows: u64) -> u64 {
        let quiet = |_: Progress| {};
        let mut sink = StoreSink::new(store, &quiet);
        sink.start(&columns());
        for i in 0..rows {
            let note = if i % 2 == 0 {
                Cell::Null
            } else {
                Cell::Text(format!("Zeile {i}\nmit \"Umbruch\", Grüße 🚀"))
            };
            assert!(sink.row(vec![Cell::I64(i as i64), Cell::Text(format!("n{i}")), note]));
        }
        sink.finish();
        sink.result_id().unwrap()
    }

    fn spec(format: FileFormat) -> Spec {
        Spec {
            format,
            options: Options::default(),
            bom: false,
            gzip: false,
            columns: vec![],
        }
    }

    fn only_file(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.path().is_file())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn writes_a_result_as_csv_with_progress_and_leaves_one_file() {
        let dir = tempdir().unwrap();
        let out = tempdir().unwrap();
        let store = ResultStore::new(dir.path());
        let id = fill(&store, 5000);
        let path = out.path().join("export.csv");
        let seen = std::sync::Mutex::new(Vec::new());
        let done = from_store(
            &store,
            id,
            &[],
            &path,
            &spec(FileFormat::Csv),
            &|n| seen.lock().unwrap().push(n),
            &|| false,
        )
        .unwrap();
        assert_eq!(done.rows, 5000);
        assert!(!done.truncated);
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(done.bytes, text.len() as u64);
        assert!(
            text.starts_with(
                "id,name,note\n0,n0,\n1,n1,\"Zeile 1\nmit \"\"Umbruch\"\", Grüße 🚀\"\n"
            )
        );
        assert!(text.ends_with("\n"));
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            &[0, 1024, 2048, 3072, 4096]
        );
        assert_eq!(only_file(out.path()), vec!["export.csv"]);
    }

    #[test]
    fn writes_chosen_rows_and_columns_with_bom_and_gzip() {
        let dir = tempdir().unwrap();
        let out = tempdir().unwrap();
        let store = ResultStore::new(dir.path());
        let id = fill(&store, 10);
        let path = out.path().join("part.tsv.gz");
        let s = Spec {
            bom: true,
            gzip: true,
            columns: vec![1, 0],
            ..spec(FileFormat::Tsv)
        };
        let done = from_store(&store, id, &[(2, 3)], &path, &s, &|_| {}, &|| false).unwrap();
        assert_eq!(done.rows, 2);
        let mut text = Vec::new();
        flate2::read::GzDecoder::new(std::fs::File::open(&path).unwrap())
            .read_to_end(&mut text)
            .unwrap();
        assert_eq!(&text[..3], &[0xEF, 0xBB, 0xBF]);
        assert_eq!(
            String::from_utf8_lossy(&text[3..]),
            "id\tname\n2\tn2\n3\tn3\n"
        );
    }

    #[test]
    fn every_text_format_is_a_whole_file() {
        let dir = tempdir().unwrap();
        let out = tempdir().unwrap();
        let store = ResultStore::new(dir.path());
        let id = fill(&store, 3);
        let write = |format, name: &str| {
            let path = out.path().join(name);
            from_store(&store, id, &[], &path, &spec(format), &|_| {}, &|| false).unwrap();
            std::fs::read_to_string(path).unwrap()
        };
        let json: Value = serde_json::from_str(&write(FileFormat::Json, "a.json")).unwrap();
        assert_eq!(json.as_array().unwrap().len(), 3);
        assert_eq!(json[1]["note"], "Zeile 1\nmit \"Umbruch\", Grüße 🚀");
        let nd = write(FileFormat::Ndjson, "a.ndjson");
        assert_eq!(nd.lines().count(), 3);
        let insert = write(FileFormat::Insert, "a.sql");
        assert_eq!(
            insert
                .matches("INSERT INTO table_name (id, name, note) VALUES (")
                .count(),
            3
        );
        assert!(insert.ends_with(");\n"));
        assert!(write(FileFormat::Markdown, "a.md").starts_with("| id | name | note |\n"));
        assert!(write(FileFormat::Html, "a.html").ends_with("</table>"));
    }

    #[test]
    fn a_stop_or_a_failure_leaves_nothing_behind_and_keeps_the_old_file() {
        let dir = tempdir().unwrap();
        let out = tempdir().unwrap();
        let store = ResultStore::new(dir.path());
        let id = fill(&store, 5000);
        let path = out.path().join("export.csv");
        std::fs::write(&path, "what was here before").unwrap();
        let asked = std::sync::atomic::AtomicU32::new(0);
        let stop = || asked.fetch_add(1, std::sync::atomic::Ordering::Relaxed) >= 2;
        let e = from_store(
            &store,
            id,
            &[],
            &path,
            &spec(FileFormat::Csv),
            &|_| {},
            &stop,
        )
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::Cancelled);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "what was here before"
        );
        assert_eq!(only_file(out.path()), vec!["export.csv"]);

        let gone = out.path().join("no such folder").join("x.csv");
        let e = from_store(
            &store,
            id,
            &[],
            &gone,
            &spec(FileFormat::Csv),
            &|_| {},
            &|| false,
        )
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::NotFound);
        assert!(
            from_store(
                &store,
                id,
                &[],
                Path::new("relative.csv"),
                &spec(FileFormat::Csv),
                &|_| {},
                &|| false
            )
            .is_err()
        );
        assert_eq!(
            from_store(
                &store,
                99,
                &[],
                &path,
                &spec(FileFormat::Csv),
                &|_| {},
                &|| false
            )
            .unwrap_err()
            .code,
            ErrorCode::UnknownResult
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_that_cannot_be_written_says_so() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let out = tempdir().unwrap();
        let store = ResultStore::new(dir.path());
        let id = fill(&store, 3);
        std::fs::set_permissions(out.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
        let e = from_store(
            &store,
            id,
            &[],
            &out.path().join("x.csv"),
            &spec(FileFormat::Csv),
            &|_| {},
            &|| false,
        )
        .unwrap_err();
        std::fs::set_permissions(out.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(e.code, ErrorCode::PermissionDenied);
    }

    #[test]
    fn writes_excel_with_types_and_cuts_what_a_cell_cannot_hold() {
        let out = tempdir().unwrap();
        let path = out.path().join("a.xlsx");
        let mut writer = FileWriter::create(&path, &spec(FileFormat::Xlsx), &columns()).unwrap();
        assert!(
            writer
                .row(&[serde_json::json!(1), serde_json::json!("a"), Value::Null])
                .unwrap()
        );
        assert!(
            writer
                .row(&[
                    serde_json::json!("9223372036854775807"),
                    serde_json::json!(true),
                    serde_json::json!("x".repeat(XLSX_MAX_CHARS + 5)),
                ])
                .unwrap()
        );
        let done = writer.finish().unwrap();
        assert_eq!((done.rows, done.cut_cells, done.truncated), (2, 1, false));
        let bytes = std::fs::read(&path).unwrap();
        // a zip archive
        assert_eq!(&bytes[..2], b"PK");
        assert!(done.bytes > 1000);
        assert_eq!(only_file(out.path()), vec!["a.xlsx"]);
    }

    #[test]
    fn a_sink_writes_what_a_driver_reads_and_a_statement_without_rows_has_no_file() {
        let out = tempdir().unwrap();
        let path = out.path().join("q.csv");
        let quiet = |_: u64| {};
        let mut sink = FileSink::new(&path, spec(FileFormat::Csv), &quiet);
        sink.start(&columns());
        assert!(sink.row(vec![Cell::I64(1), Cell::Text("a,b".into()), Cell::Null]));
        assert!(sink.row(vec![
            Cell::I64(2),
            Cell::Bool(true),
            Cell::Decimal("1.50".into())
        ]));
        let done = sink.finish().unwrap();
        assert_eq!(done.rows, 2);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "id,name,note\n1,\"a,b\",\n2,true,1.50\n"
        );

        let none = FileSink::new(&out.path().join("none.csv"), spec(FileFormat::Csv), &quiet);
        assert_eq!(none.finish().unwrap_err().code, ErrorCode::InvalidQuery);
        assert_eq!(only_file(out.path()), vec!["q.csv"]);
    }
}
