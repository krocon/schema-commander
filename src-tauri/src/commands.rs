//! The command layer: thin, the logic lives in pure modules (`db`, `themes`).

use crate::copy::{self, Copied, Selection};
use crate::db::manager::{ConnectionInfo, ConnectionManager, Verdict};
use crate::db::meta;
use crate::db::profiles::LoadedProfiles;
use crate::db::secrets::Secret;
use crate::db::value::Column;
use crate::db::{Profile, TxState};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::export;
use crate::extract::{Format, Options};
use crate::format;
use crate::history::{self, History};
use crate::results::{Progress, ResultStore, StoreSink};
use crate::saved::{self, SavedDir};
use crate::session::{LoadedSession, SessionDir, SessionFile};
use crate::ssh::SshCredentials;
use crate::textfile::{self, TextFile};
use crate::themes::{self, LoadedThemes, ThemesFile, UserTheme};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// The stored connections, the demo database first (prompt 003). Never a secret.
#[tauri::command(async)]
pub fn list_connections(manager: State<'_, ConnectionManager>) -> LoadedProfiles {
    manager.list()
}

/// Stores a profile; `password` goes into the keychain when the profile says so, never into a file.
#[tauri::command(async)]
pub fn save_connection(
    manager: State<'_, ConnectionManager>,
    profile: Profile,
    password: Option<Secret>,
) -> AppResult<Profile> {
    manager.save(profile, password)
}

#[tauri::command(async)]
pub fn delete_connection(manager: State<'_, ConnectionManager>, id: String) -> AppResult<()> {
    manager.delete(&id)
}

/// Tries a profile without keeping the connection; answers with the server's version.
#[tauri::command(async)]
pub fn test_connection(
    manager: State<'_, ConnectionManager>,
    profile: Profile,
    password: Option<Secret>,
    ssh_secret: Option<Secret>,
    trust_fingerprint: Option<String>,
) -> AppResult<String> {
    manager.test_with(
        &profile,
        password,
        SshCredentials {
            secret: ssh_secret,
            trust_fingerprint,
        },
    )
}

/// A connection from what the user pasted (prompt 015): a URL, a JDBC URL, an ADO string or the path of an
/// SQLite file. The password of the URL comes back for the password field of the dialog – it reaches the
/// keychain only when the profile is stored with it, never the profile itself.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlDraft {
    profile: Profile,
    password: Option<String>,
    problem: Option<String>,
}

#[tauri::command(async)]
pub fn parse_connection_url(text: String) -> AppResult<UrlDraft> {
    let found = crate::db::import::parse_url(&text)?;
    Ok(UrlDraft {
        profile: found.profile,
        password: found.password.map(|s| s.expose().to_string()),
        problem: found.problem,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    /// The file that was read; `None` for the environment.
    path: Option<String>,
    items: Vec<crate::db::manager::ImportItem>,
}

/// The file of a source: the one given (from the open dialog), else its usual place.
fn import_path(source: crate::db::import::Source, path: Option<String>) -> Option<PathBuf> {
    path.map(PathBuf::from).or_else(|| {
        crate::ssh::ssh_config::home_dir()
            .and_then(|home| crate::db::import::default_path(source, &home))
    })
}

/// The connections another tool keeps, for the preview. Passwords stay in the backend.
#[tauri::command(async)]
pub fn import_preview(
    manager: State<'_, ConnectionManager>,
    source: crate::db::import::Source,
    path: Option<String>,
) -> AppResult<ImportPreview> {
    let path = import_path(source, path);
    let items = manager.import_preview(source, path.as_deref())?;
    Ok(ImportPreview {
        path: path.map(|p| p.display().to_string()),
        items,
    })
}

/// Stores the ticked connections of a source; returns them with their ids.
#[tauri::command(async)]
pub fn import_connections(
    manager: State<'_, ConnectionManager>,
    source: crate::db::import::Source,
    path: Option<String>,
    picks: Vec<crate::db::manager::ImportPick>,
) -> AppResult<Vec<Profile>> {
    let path = import_path(source, path);
    manager.import_selected(source, path.as_deref(), &picks)
}

/// Writes the stored profiles to a file (from the save dialog) for another machine – without secrets.
#[tauri::command(async)]
pub fn export_connections(manager: State<'_, ConnectionManager>, path: String) -> AppResult<()> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(AppError::new(ErrorCode::Io, "the target is no full path"));
    }
    std::fs::write(&path, manager.export_profiles()?)
        .map_err(|e| AppError::new(ErrorCode::Io, format!("the file could not be written: {e}")))
}

/// The hosts of `~/.ssh/config`, to fill in a jump host (prompt 014). Nothing in the file is ever run.
#[tauri::command(async)]
pub fn ssh_config_hosts() -> Vec<crate::ssh::ssh_config::HostConfig> {
    use crate::ssh::ssh_config::{Environment, SshConfig};
    let Some(env) = Environment::current() else {
        return Vec::new();
    };
    let config = SshConfig::load(&env);
    config
        .aliases()
        .into_iter()
        .take(500)
        .map(|alias| config.resolve(&alias, &env))
        .collect()
}

/// Connects. `secret_required` asks the frontend for a password.
#[tauri::command(async)]
pub fn open_connection(
    manager: State<'_, ConnectionManager>,
    id: String,
    password: Option<Secret>,
    ssh_secret: Option<Secret>,
    trust_fingerprint: Option<String>,
) -> AppResult<ConnectionInfo> {
    manager.open_with(
        &id,
        password,
        SshCredentials {
            secret: ssh_secret,
            trust_fingerprint,
        },
    )
}

#[tauri::command(async)]
pub fn close_connection(
    manager: State<'_, ConnectionManager>,
    names: State<'_, NameIndexes>,
    id: String,
) {
    manager.close(&id);
    names.map.lock().remove(&id);
}

/// The name indexes of the open connections (prompt 020): each is read once and searched in memory.
#[derive(Default)]
pub struct NameIndexes {
    map: parking_lot::Mutex<
        std::collections::HashMap<
            String,
            std::sync::Arc<parking_lot::RwLock<crate::db::names::NameIndex>>,
        >,
    >,
}

/// Reads the names of a connection again (after it opened, after DDL). Answers with how many there are.
/// The columns are dropped with the old index and read again when they are asked for.
#[tauri::command(async)]
pub fn names_refresh(
    manager: State<'_, ConnectionManager>,
    names: State<'_, NameIndexes>,
    id: String,
) -> AppResult<usize> {
    let index = manager.ask(&id, |s, kind, stop| {
        crate::db::names::read_objects(s, kind, stop)
    })?;
    let count = index.entries.len();
    names
        .map
        .lock()
        .insert(id, std::sync::Arc::new(parking_lot::RwLock::new(index)));
    Ok(count)
}

/// Searches the names of a connection. The index is read on the first search if it is not there yet, the
/// columns on the first search for columns (`c:`); from then on a search touches no database.
#[tauri::command(async)]
pub fn names_query(
    manager: State<'_, ConnectionManager>,
    names: State<'_, NameIndexes>,
    id: String,
    query: String,
    context: Option<crate::db::names::Context>,
) -> AppResult<crate::db::names::NameHits> {
    use crate::db::names;
    let kind = manager.kind_of(&id)?;
    let known = names.map.lock().get(&id).cloned();
    let index = match known {
        Some(index) => index,
        None => {
            let read = manager.ask(&id, |s, kind, stop| names::read_objects(s, kind, stop))?;
            let index = std::sync::Arc::new(parking_lot::RwLock::new(read));
            names.map.lock().insert(id.clone(), index.clone());
            index
        }
    };
    let wants_columns = names::parse(&query)
        .kinds
        .is_some_and(|k| k.contains(&names::NameKind::Column));
    if wants_columns && !index.read().columns {
        let mut index = index.write();
        if !index.columns {
            manager.ask(&id, |s, kind, stop| {
                names::read_columns(s, kind, &mut index, stop)
            })?;
        }
    }
    Ok(names::search(
        &index.read(),
        &query,
        &context.unwrap_or_default(),
        kind,
    ))
}

/// What `run_query` reports while it runs, over its channel.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunEvent {
    /// The statement has a result; its rows can be asked for from now on (`result_window`).
    #[serde(rename_all = "camelCase")]
    Started {
        result_id: u64,
        columns: Vec<Column>,
    },
    /// So many rows are stored by now.
    Rows { rows: u64 },
}

/// How a statement ended.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutcome {
    /// Where the rows are; `None` for a statement without a result.
    pub result_id: Option<u64>,
    pub columns: Vec<Column>,
    pub rows: u64,
    /// More rows existed than the store takes.
    pub truncated: bool,
    pub rows_affected: Option<u64>,
    pub elapsed_ms: u64,
    /// What the server says about the transaction of the session afterwards (prompt 013).
    tx: TxState,
}

/// Runs one statement on an open connection, for at most `timeout_ms` (none or 0 = as long as it takes).
/// Its rows go into the result store as they arrive; `on_event` says when the first are there and how many
/// there are by now, so the window shows them while the rest is still read. A statement that fails or is
/// stopped leaves no result behind. `async`: off the main thread, the window stays responsive.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn run_query(
    manager: State<'_, ConnectionManager>,
    store: State<'_, ResultStore>,
    id: String,
    sql: String,
    timeout_ms: Option<u64>,
    confirmation: Option<String>,
    allow_dangerous: Option<bool>,
    session: Option<String>,
    manual: Option<bool>,
    params: Option<Vec<crate::db::Bind>>,
    on_event: Channel<RunEvent>,
) -> AppResult<RunOutcome> {
    // the guard of the connection (prompt 012): here, not in the window
    manager.admit(
        &id,
        &sql,
        confirmation.as_deref(),
        allow_dangerous.unwrap_or(false),
    )?;
    let timeout = timeout_ms
        .filter(|ms| *ms > 0)
        .map(std::time::Duration::from_millis);
    let report = |progress: Progress| {
        // a window that is gone does not want to know
        let _ = on_event.send(match progress {
            Progress::Started { id, columns } => RunEvent::Started {
                result_id: id,
                columns: columns.to_vec(),
            },
            Progress::Rows(rows) => RunEvent::Rows { rows },
        });
    };
    let mut sink = StoreSink::new(&store, &report);
    // values of parameters (prompt 025) are bound by the driver; they are neither logged nor kept
    let (result, tx) = manager.run_bound(
        &id,
        session.as_deref(),
        &sql,
        params.as_deref().unwrap_or(&[]),
        timeout,
        &mut sink,
        manual.unwrap_or(false),
    );
    sink.finish();
    let result_id = sink.result_id();
    let failed = sink.error.take().map(Err).unwrap_or(result);
    match failed {
        Ok(outcome) => Ok(RunOutcome {
            result_id,
            columns: outcome.columns,
            rows: sink.rows(),
            truncated: outcome.truncated || sink.full,
            rows_affected: outcome.rows_affected,
            elapsed_ms: outcome.elapsed_ms,
            tx,
        }),
        Err(e) => {
            if let Some(id) = result_id {
                store.free(id);
            }
            Err(e)
        }
    }
}

/// Rows `from..from + count` of a result as a JSON array of rows (long texts cut). The answer is the stored
/// JSON itself, not parsed and built again here.
#[tauri::command(async)]
pub fn result_window(
    store: State<'_, ResultStore>,
    result_id: u64,
    from: u64,
    count: u64,
) -> AppResult<tauri::ipc::Response> {
    store
        .window(result_id, from, count)
        .map(tauri::ipc::Response::new)
}

/// Looks at a result through a text filter and in an order (prompt 027): in the store, not in the window.
/// Answers with the id of a view that is read, copied and exported like a result. A job: `cancel_job`
/// stops it. The query itself is not touched.
#[tauri::command(async)]
pub fn result_view(
    store: State<'_, ResultStore>,
    jobs: State<'_, Jobs>,
    job_id: u64,
    result_id: u64,
    spec: crate::results::ViewSpec,
) -> AppResult<crate::results::Viewed> {
    use std::sync::atomic::Ordering;
    let stop = jobs.start(job_id, None);
    let result = store.derive(result_id, &spec, &|| stop.load(Ordering::Relaxed));
    jobs.end(job_id);
    result
}

/// The figures of a selection of a result (prompt 028): counts, sum, mean, smallest, largest – worked out
/// over the store, exactly. `top` adds the most frequent values. A job: `cancel_job` stops it (the window
/// does so as soon as the selection changes).
#[tauri::command(async)]
pub fn result_stats(
    store: State<'_, ResultStore>,
    jobs: State<'_, Jobs>,
    job_id: u64,
    result_id: u64,
    selection: Selection,
    top: bool,
) -> AppResult<crate::stats::Stats> {
    use std::sync::atomic::Ordering;
    let stop = jobs.start(job_id, None);
    let result = crate::stats::stats(&store, result_id, &selection, top, &|| {
        stop.load(Ordering::Relaxed)
    });
    jobs.end(job_id);
    result
}

/// Looks for a text in a stretch of rows of a result (prompt 029): the window asks stretch by stretch
/// (`next` of one answer is `from` of the next), so the first hits are there at once. A job.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn result_search(
    store: State<'_, ResultStore>,
    jobs: State<'_, Jobs>,
    job_id: u64,
    result_id: u64,
    spec: crate::search::SearchSpec,
    from: u64,
    max_rows: u64,
    max_hits: usize,
) -> AppResult<crate::search::Found> {
    use std::sync::atomic::Ordering;
    let stop = jobs.start(job_id, None);
    let result = crate::search::search(&store, result_id, &spec, from, max_rows, max_hits, &|| {
        stop.load(Ordering::Relaxed)
    });
    jobs.end(job_id);
    result
}

/// The next row of a column with another value, or with NULL (prompt 029). A job.
#[tauri::command(async)]
pub fn result_seek(
    store: State<'_, ResultStore>,
    jobs: State<'_, Jobs>,
    job_id: u64,
    result_id: u64,
    col: usize,
    from: u64,
    seek: crate::search::Seek,
) -> AppResult<Option<u64>> {
    use std::sync::atomic::Ordering;
    let stop = jobs.start(job_id, None);
    let result = crate::search::seek(&store, result_id, col, from, seek, &|| {
        stop.load(Ordering::Relaxed)
    });
    jobs.end(job_id);
    result
}

/// The `UPDATE`s for changed cells (prompt 031), one per row: to show them, and to ask the guard about
/// them. Names quoted here, every value a placeholder. Nothing runs.
#[tauri::command(async)]
pub fn edit_preview(
    manager: State<'_, ConnectionManager>,
    id: String,
    plan: crate::db::edit::UpdatePlan,
) -> AppResult<Vec<crate::db::edit::Step>> {
    crate::db::edit::steps(manager.kind_of(&id)?, &plan)
}

/// Writes changed cells: the statements are built here again from the plan (the window never sends
/// SQL), pass the guard (`confirmations[i]` for statement `i`), and run in one transaction on the
/// session of the tab – all or nothing, each changing exactly one row.
#[tauri::command(async)]
pub fn edit_apply(
    manager: State<'_, ConnectionManager>,
    id: String,
    session: Option<String>,
    plan: crate::db::edit::UpdatePlan,
    confirmations: Option<Vec<Option<String>>>,
    timeout_ms: Option<u64>,
) -> AppResult<crate::db::manager::Applied> {
    let kind = manager.kind_of(&id)?;
    let steps = crate::db::edit::steps(kind, &plan)?;
    let timeout = timeout_ms
        .filter(|ms| *ms > 0)
        .map(std::time::Duration::from_millis);
    manager.apply_steps(
        &id,
        session.as_deref(),
        &steps,
        &|first, rows| crate::db::edit::single_inserts(kind, &plan, first, rows),
        confirmations.as_deref().unwrap_or(&[]),
        timeout,
    )
}

/// The statement of a table view (prompt 027): names quoted here, every value a placeholder. The window
/// runs what comes back with `run_query` – statement and values together, as it got them.
#[tauri::command(async)]
pub fn table_query(
    manager: State<'_, ConnectionManager>,
    id: String,
    query: crate::db::filter::TableQuery,
) -> AppResult<crate::db::filter::Built> {
    crate::db::filter::build(manager.kind_of(&id)?, &query)
}

/// A part of the whole value of a cell (prompt 026): long texts and binary data are not in the rows the
/// grid gets. The window asks piece by piece (`to` of one answer is `from` of the next).
#[tauri::command(async)]
pub fn cell_value(
    store: State<'_, ResultStore>,
    result_id: u64,
    row: u64,
    col: u32,
    from: u64,
    max: u64,
) -> AppResult<crate::results::CellValue> {
    store.value(result_id, row, col, from, max)
}

/// Writes the whole value of a cell into a file: text as UTF-8, binary data as it is. `path` comes from
/// the save dialog. Answers with the bytes written.
#[tauri::command(async)]
pub fn save_cell_value(
    store: State<'_, ResultStore>,
    result_id: u64,
    row: u64,
    col: u32,
    path: String,
) -> AppResult<u64> {
    use std::io::Write;
    let path = export_target(&path)?;
    let fail = |e: std::io::Error| AppError::new(ErrorCode::Io, e.to_string());
    // next to the target, then renamed: the file is never left half written
    let part = path.with_extension("part-schema-commander");
    let mut file = std::fs::File::create(&part).map_err(fail)?;
    let mut written = 0u64;
    let mut failed = None;
    let read = store.each_part(
        result_id,
        row,
        col,
        &mut |bytes| match file.write_all(bytes) {
            Ok(()) => {
                written += bytes.len() as u64;
                true
            }
            Err(e) => {
                failed = Some(e);
                false
            }
        },
    );
    let done = match (read, failed) {
        (Err(e), _) => Err(e),
        (_, Some(e)) => Err(fail(e)),
        _ => file
            .flush()
            .and_then(|()| std::fs::rename(&part, &path))
            .map_err(fail),
    };
    if done.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    done.map(|()| written)
}

/// Puts the whole text of a cell on the clipboard, without it passing the window. Binary data is refused
/// (`unsupported`): the window copies what it shows of it.
#[tauri::command(async)]
pub fn copy_cell_value(
    store: State<'_, ResultStore>,
    clip: State<'_, ClipState>,
    result_id: u64,
    row: u64,
    col: u32,
) -> AppResult<u64> {
    const MAX_CLIPBOARD: usize = 256 * 1024 * 1024;
    let mut all: Vec<u8> = Vec::new();
    let binary = store.each_part(result_id, row, col, &mut |bytes| {
        all.extend_from_slice(bytes);
        all.len() <= MAX_CLIPBOARD
    })?;
    if binary {
        return Err(AppError::new(ErrorCode::Unsupported, "binary data"));
    }
    if all.len() > MAX_CLIPBOARD {
        return Err(AppError::new(ErrorCode::TooLarge, "too much text"));
    }
    let text = String::from_utf8_lossy(&all).into_owned();
    let chars = text.chars().count() as u64;
    clip.put(text, None)?;
    Ok(chars)
}

/// Which columns of two results go together (prompt 041): what the dialog offers as keys.
#[tauri::command(async)]
pub fn compare_columns(
    store: State<'_, ResultStore>,
    left: u64,
    right: u64,
) -> AppResult<crate::result_compare::Pairing> {
    Ok(crate::result_compare::pair(
        &store.columns(left)?,
        &store.columns(right)?,
    ))
}

/// How far a comparison is, in rows read.
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct CompareProgress {
    pub done: u64,
    pub of: u64,
}

/// Compares two results (prompt 041) over the store: the outcome is a result of its own plus a view of
/// the rows that differ. A job: `cancel_job` stops it, and then nothing of it stays in the store.
#[tauri::command(async)]
pub fn result_compare(
    store: State<'_, ResultStore>,
    jobs: State<'_, Jobs>,
    job_id: u64,
    spec: crate::result_compare::CompareSpec,
    on_progress: Channel<CompareProgress>,
) -> AppResult<crate::result_compare::CompareReport> {
    use std::sync::atomic::Ordering;
    let stop = jobs.start(job_id, None);
    let result = crate::result_compare::compare(
        &store,
        &spec,
        &|done, of| {
            let _ = on_progress.send(CompareProgress { done, of });
        },
        &|| stop.load(Ordering::Relaxed),
    );
    jobs.end(job_id);
    result
}

/// The next row of a view behind (or before) a row of its result (prompt 041: the next difference).
/// Answers with `[row of the view, row of the result]`.
#[tauri::command(async)]
pub fn result_neighbour(
    store: State<'_, ResultStore>,
    view_id: u64,
    row: u64,
    forward: bool,
) -> AppResult<Option<(u64, u64)>> {
    store.neighbour(view_id, row, forward)
}

/// What results take in the store (prompt 041); a result that is gone takes nothing.
#[tauri::command(async)]
pub fn result_usage(
    store: State<'_, ResultStore>,
    result_ids: Vec<u64>,
) -> Vec<crate::results::Usage> {
    result_ids
        .into_iter()
        .map(|id| store.usage(id).unwrap_or_default())
        .collect()
}

/// The chart the columns of a result suggest (prompt 042); `None`: nothing in it can be drawn.
#[tauri::command(async)]
pub fn chart_suggest(
    store: State<'_, ResultStore>,
    result_id: u64,
) -> AppResult<Option<crate::chart::ChartSpec>> {
    Ok(crate::chart::suggest(&store.columns(result_id)?))
}

/// A chart and the points to draw of it.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chart {
    /// Names the prepared chart for `chart_zoom` and `chart_free`.
    pub chart_id: u64,
    #[serde(flatten)]
    pub data: crate::chart::ChartData,
}

/// Reads a result into a chart (prompt 042) and answers with the points for `width` pixels. The prepared
/// chart is kept for zooming (the last few are). A job: `cancel_job` stops it.
#[tauri::command(async)]
pub fn chart_prepare(
    store: State<'_, ResultStore>,
    charts: State<'_, crate::chart::ChartCache>,
    jobs: State<'_, Jobs>,
    job_id: u64,
    result_id: u64,
    spec: crate::chart::ChartSpec,
    width: u32,
) -> AppResult<Chart> {
    use std::sync::atomic::Ordering;
    let stop = jobs.start(job_id, None);
    let prepared =
        crate::chart::prepare(&store, result_id, &spec, &|| stop.load(Ordering::Relaxed));
    jobs.end(job_id);
    let (chart_id, prepared) = charts.keep(prepared?);
    Ok(Chart {
        chart_id,
        data: crate::chart::sample(&prepared, None, width),
    })
}

/// The points of a prepared chart for a range of X (`None` = all of it). `unknown_result`: the chart is
/// no longer kept – prepare it again.
#[tauri::command(async)]
pub fn chart_zoom(
    charts: State<'_, crate::chart::ChartCache>,
    chart_id: u64,
    range: Option<(f64, f64)>,
    width: u32,
) -> AppResult<Chart> {
    let prepared = charts.get(chart_id).ok_or_else(|| {
        AppError::new(ErrorCode::UnknownResult, "the chart is no longer prepared")
    })?;
    Ok(Chart {
        chart_id,
        data: crate::chart::sample(&prepared, range, width),
    })
}

/// Forgets a prepared chart.
#[tauri::command(async)]
pub fn chart_free(charts: State<'_, crate::chart::ChartCache>, chart_id: u64) {
    charts.free(chart_id);
}

/// Forgets results the window no longer shows (their files go too).
#[tauri::command(async)]
pub fn free_results(store: State<'_, ResultStore>, result_ids: Vec<u64>) {
    for id in result_ids {
        store.free(id);
    }
}

/// The clipboard of the OS, and the flag that stops a copy that runs. One clipboard for the life of the app:
/// under X11 and Wayland what was copied is only there while its owner lives.
#[derive(Default)]
pub struct ClipState {
    clipboard: parking_lot::Mutex<Option<arboard::Clipboard>>,
    stop: std::sync::atomic::AtomicBool,
}

impl ClipState {
    fn put(&self, text: String, html: Option<String>) -> AppResult<()> {
        let fail = |e: arboard::Error| AppError::new(ErrorCode::Io, format!("clipboard: {e}"));
        let mut guard = self.clipboard.lock();
        if guard.is_none() {
            *guard = Some(arboard::Clipboard::new().map_err(fail)?);
        }
        let Some(clipboard) = guard.as_mut() else {
            return Ok(());
        };
        match html {
            Some(html) => clipboard.set_html(html, Some(text)).map_err(fail),
            None => clipboard.set_text(text).map_err(fail),
        }
    }
}

/// Copies a part of a result to the clipboard in a format (prompt 009). The rows never pass the WebView.
/// An HTML table is also there as plain text (TSV) for targets that take no HTML.
#[tauri::command(async)]
pub fn copy_result(
    store: State<'_, ResultStore>,
    clip: State<'_, ClipState>,
    result_id: u64,
    selection: Selection,
    format: Format,
    options: Options,
) -> AppResult<Copied> {
    use std::sync::atomic::Ordering;
    clip.stop.store(false, Ordering::Relaxed);
    let stop = || clip.stop.load(Ordering::Relaxed);
    let (text, copied) = copy::render(
        &store,
        result_id,
        &selection,
        format,
        options.clone(),
        &stop,
    )?;
    if format == Format::Html {
        let (plain, _) = copy::render(&store, result_id, &selection, Format::Tsv, options, &stop)?;
        clip.put(plain, Some(text))?;
    } else {
        clip.put(text, None)?;
    }
    Ok(copied)
}

/// Stops the copy that runs.
#[tauri::command(async)]
pub fn cancel_copy(clip: State<'_, ClipState>) {
    clip.stop.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// Puts a short text of the app itself on the clipboard (a name from the schema tree).
#[tauri::command(async)]
pub fn copy_text(clip: State<'_, ClipState>, text: String) -> AppResult<()> {
    if text.len() > 1024 * 1024 {
        return Err(AppError::new(ErrorCode::TooLarge, "too much text"));
    }
    clip.put(text, None)
}

/// The text on the clipboard (prompt 032: a block of cells from a spreadsheet to paste into a table).
/// Read by the backend, as the clipboard is written by it. Nothing of it is logged.
#[tauri::command(async)]
pub fn read_clipboard_text(clip: State<'_, ClipState>) -> AppResult<String> {
    let fail = |e: arboard::Error| AppError::new(ErrorCode::Io, format!("clipboard: {e}"));
    let mut guard = clip.clipboard.lock();
    if guard.is_none() {
        *guard = Some(arboard::Clipboard::new().map_err(fail)?);
    }
    let Some(clipboard) = guard.as_mut() else {
        return Ok(String::new());
    };
    let text = match clipboard.get_text() {
        Ok(text) => text,
        // nothing there, or no text: an empty block
        Err(arboard::Error::ContentNotAvailable) => String::new(),
        Err(e) => return Err(fail(e)),
    };
    if text.len() > MAX_PASTE_BYTES {
        return Err(AppError::new(
            ErrorCode::TooLarge,
            "too much text on the clipboard",
        ));
    }
    Ok(text)
}

/// Text taken from the clipboard at most.
pub const MAX_PASTE_BYTES: usize = 32 * 1024 * 1024;

/// Long work that can be stopped (prompt 011): each job has an id the frontend chose, and a flag. Also
/// remembers which files the app wrote, so only those can be shown in the file manager.
#[derive(Default)]
pub struct Jobs {
    running: parking_lot::Mutex<std::collections::HashMap<u64, JobHandle>>,
    written: parking_lot::Mutex<std::collections::HashSet<PathBuf>>,
}

struct JobHandle {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// The connection a statement of the job runs on.
    connection: Option<String>,
}

impl Jobs {
    fn start(
        &self,
        id: u64,
        connection: Option<String>,
    ) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        self.running.lock().insert(
            id,
            JobHandle {
                stop: stop.clone(),
                connection,
            },
        );
        stop
    }

    fn end(&self, id: u64) {
        self.running.lock().remove(&id);
    }
}

fn export_target(path: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(path);
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(AppError::new(ErrorCode::Io, "the target is no full path"));
    }
    Ok(path)
}

/// Writes rows of a result in the store to a file (prompt 011). `path` comes from the save dialog, which
/// has asked before replacing a file. `on_progress` hears the rows written so far.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn export_result(
    store: State<'_, ResultStore>,
    jobs: State<'_, Jobs>,
    job_id: u64,
    result_id: u64,
    rows: Vec<(u64, u64)>,
    path: String,
    spec: export::Spec,
    on_progress: Channel<u64>,
) -> AppResult<export::Exported> {
    use std::sync::atomic::Ordering;
    let path = export_target(&path)?;
    let stop = jobs.start(job_id, None);
    let result = export::from_store(
        &store,
        result_id,
        &rows,
        &path,
        &spec,
        &|n| {
            let _ = on_progress.send(n);
        },
        &|| stop.load(Ordering::Relaxed),
    );
    jobs.end(job_id);
    if result.is_ok() {
        jobs.written.lock().insert(path);
    }
    result
}

/// Runs a statement and writes its rows straight into a file: nothing is kept, nothing is shown.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn export_query(
    manager: State<'_, ConnectionManager>,
    jobs: State<'_, Jobs>,
    job_id: u64,
    id: String,
    sql: String,
    path: String,
    spec: export::Spec,
    on_progress: Channel<u64>,
) -> AppResult<export::Exported> {
    let path = export_target(&path)?;
    // an export reads: nothing else runs through it, whatever the connection allows
    if manager.verdict(&id, &sql, false)?.class != crate::db::guard::Class::Read {
        return Err(AppError::new(
            ErrorCode::PermissionDenied,
            "an export runs statements that read, nothing else",
        ));
    }
    jobs.start(job_id, Some(id.clone()));
    let report = |n: u64| {
        let _ = on_progress.send(n);
    };
    let mut sink = export::FileSink::new(&path, spec, &report);
    let ran = manager.run_into(&id, &sql, None, &mut sink);
    jobs.end(job_id);
    // the statement failed or was stopped: the sink is dropped and takes its file with it
    ran?;
    let done = sink.finish()?;
    jobs.written.lock().insert(path);
    Ok(done)
}

/// What an ER diagram of a schema is drawn from (prompt 037): tables with columns, foreign keys, unique
/// sets of columns. Read from the catalog with bound parameters.
#[tauri::command(async)]
pub fn meta_diagram(
    manager: State<'_, ConnectionManager>,
    id: String,
    schema: String,
) -> AppResult<crate::db::diagram::DiagramData> {
    manager.ask(&id, |session, kind, stop| {
        crate::db::diagram::diagram(session, kind, &schema, stop)
    })
}

/// A table as the structure editor shows it (prompt 043): columns, keys, indexes, checks.
#[tauri::command(async)]
pub fn struct_load(
    manager: State<'_, ConnectionManager>,
    id: String,
    schema: String,
    table: String,
) -> AppResult<crate::db::compare::Table> {
    manager.ask(&id, |session, kind, stop| {
        crate::db::structure::load(session, kind, &schema, &table, stop)
    })
}

/// The statements that make a table what the editor shows, or drop, empty or copy one (prompt 043).
/// Nothing runs: the window shows them, with the steps that may lose data told apart.
#[tauri::command(async)]
pub fn struct_plan(
    manager: State<'_, ConnectionManager>,
    id: String,
    request: crate::db::structure::Request,
) -> AppResult<crate::db::structure::Plan> {
    crate::db::structure::plan(manager.kind_of(&id)?, &request)
}

/// Runs the statements of a request (prompt 043). They are written here again from the request – the
/// window never sends SQL –, each passes the guard (`confirmations[i]` for statement `i`), and they run
/// on a session of their own, in one transaction where the database has DDL in transactions.
#[tauri::command(async)]
pub fn struct_apply(
    manager: State<'_, ConnectionManager>,
    id: String,
    request: crate::db::structure::Request,
    confirmations: Option<Vec<Option<String>>>,
    allow_dangerous: bool,
    timeout_ms: Option<u64>,
) -> AppResult<crate::db::structure::Ran> {
    const SESSION: &str = "sc-ddl";
    let plan = crate::db::structure::plan(manager.kind_of(&id)?, &request)?;
    if plan.incomplete {
        return Err(AppError::new(
            ErrorCode::Unsupported,
            "a part of this change is not written: it cannot run as it is",
        ));
    }
    let statements = plan.statements();
    let tokens = confirmations.unwrap_or_default();
    // all of them are admitted before the first one runs: a refusal leaves nothing half done
    for (i, sql) in statements.iter().enumerate() {
        let token = tokens.get(i).and_then(|t| t.as_deref());
        manager.admit(&id, sql, token, allow_dangerous)?;
    }
    let timeout = timeout_ms
        .filter(|ms| *ms > 0)
        .map(std::time::Duration::from_millis);
    let ran = manager.ask_in(&id, SESSION, |session, kind, stop| {
        crate::db::structure::run(
            session,
            kind,
            &statements,
            plan.transactional,
            timeout,
            stop,
        )
    });
    // whatever was begun on that session goes with it
    manager.close_session(&id, SESSION);
    ran
}

// ── Server monitor (prompt 046) ──────────────────────────────────────────────────────────

/// The session the monitor asks with: its own, so it waits for no tab and no tab for it.
const MONITOR_SESSION: &str = "sc-monitor";

/// What happens on the server of a connection (prompt 046): sessions, who waits for whom, a few
/// figures. Read only, on a session of its own. Nothing of it is logged or noted.
#[tauri::command(async)]
pub fn monitor_activity(
    manager: State<'_, ConnectionManager>,
    id: String,
) -> AppResult<crate::db::monitor::Activity> {
    manager.ask_in(&id, MONITOR_SESSION, |session, kind, stop| {
        crate::db::monitor::activity(session, kind, stop)
    })
}

/// Cancels the statement of a session of the server, or ends the session (prompt 046). A connection
/// that only reads ends nothing; the window asks the user before it calls this.
#[tauri::command(async)]
pub fn monitor_kill(
    manager: State<'_, ConnectionManager>,
    id: String,
    session_id: String,
    terminate: bool,
) -> AppResult<bool> {
    let (_, _, profile) = manager.external(&id)?;
    if profile.protection == crate::db::guard::Protection::Readonly {
        return Err(AppError::new(
            ErrorCode::PermissionDenied,
            "this connection is read only: it ends no session",
        ));
    }
    manager.ask_in(&id, MONITOR_SESSION, |session, kind, stop| {
        crate::db::monitor::kill(session, kind, &session_id, terminate, stop)
    })
}

/// The monitor was closed: its session goes.
#[tauri::command(async)]
pub fn monitor_close(manager: State<'_, ConnectionManager>, id: String) {
    manager.close_session(&id, MONITOR_SESSION);
}

// ── Users, roles and rights (prompt 047) ─────────────────────────────────────────────────

/// The users and roles of a connection.
#[tauri::command(async)]
pub fn access_list(
    manager: State<'_, ConnectionManager>,
    id: String,
) -> AppResult<crate::db::access::Access> {
    manager.ask(&id, crate::db::access::principals)
}

/// What a user or role may do, with where each right comes from.
#[tauri::command(async)]
pub fn access_grants(
    manager: State<'_, ConnectionManager>,
    id: String,
    who: crate::db::access::Who,
) -> AppResult<crate::db::access::GrantList> {
    manager.ask(&id, |session, kind, stop| {
        crate::db::access::grants(session, kind, &who, stop)
    })
}

/// The statements of changes as they are shown: a password in them is masked.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessPlan {
    steps: Vec<crate::db::access::Step>,
    transactional: bool,
    /// The server never sees a password (PostgreSQL: a verifier is sent); otherwise it may log it.
    hides_password: bool,
}

#[tauri::command(async)]
pub fn access_plan(
    manager: State<'_, ConnectionManager>,
    id: String,
    changes: Vec<crate::db::access::Change>,
) -> AppResult<AccessPlan> {
    use crate::db::access;
    manager.ask(&id, |session, kind, stop| {
        let cx = access::context(session, kind, stop)?;
        Ok(AccessPlan {
            steps: access::plan(kind, &changes, &cx)?,
            transactional: access::transactional(kind, cx.flavor),
            hides_password: access::hides_password(kind, cx.flavor),
        })
    })
}

/// The rights a principal holds itself, as a script of `GRANT`s.
#[tauri::command(async)]
pub fn access_script(
    manager: State<'_, ConnectionManager>,
    id: String,
    who: crate::db::access::Who,
) -> AppResult<String> {
    use crate::db::access;
    manager.ask(&id, |session, kind, stop| {
        let cx = access::context(session, kind, stop)?;
        let list = access::grants(session, kind, &who, stop)?;
        access::script(kind, &who, &list.grants, &cx)
    })
}

/// Runs changes to users, roles and rights. The statements are written here from the changes – the
/// window never sends SQL –, each passes the guard in the form that is shown (a password masked), and
/// they run on a session of their own. `passwords[i]` belongs to `changes[i]`: it stands in the statement
/// only while it runs, is wiped afterwards, and no error brings it back.
#[tauri::command(async)]
pub fn access_apply(
    manager: State<'_, ConnectionManager>,
    id: String,
    changes: Vec<crate::db::access::Change>,
    passwords: Vec<Option<crate::db::secrets::Secret>>,
    confirmations: Option<Vec<Option<String>>>,
    allow_dangerous: bool,
) -> AppResult<crate::db::structure::Ran> {
    use crate::db::access;
    const SESSION: &str = "sc-access";
    let shown = manager.ask(&id, |session, kind, stop| {
        let cx = access::context(session, kind, stop)?;
        access::plan(kind, &changes, &cx)
    })?;
    let tokens = confirmations.unwrap_or_default();
    // all of them are admitted before the first one runs: a refusal leaves nothing half done
    for (i, step) in shown.iter().enumerate() {
        let token = tokens.get(i).and_then(|t| t.as_deref());
        manager.admit(&id, &step.sql, token, allow_dangerous)?;
    }
    let ran = manager.ask_in(&id, SESSION, |session, kind, stop| {
        // what the literals depend on (`sql_mode`) is read on the session that runs them; and what
        // runs must be what was shown and admitted (review 047 L6)
        let here = access::context(session, kind, stop)?;
        let again = access::plan(kind, &changes, &here)?;
        if again != shown {
            return Err(AppError::new(
                ErrorCode::Unsupported,
                "the statements changed since they were shown: look at them again",
            ));
        }
        let real = access::statements(kind, &changes, &passwords, &here, &access::random_salt)?;
        let ran = crate::db::structure::run(
            session,
            kind,
            &real,
            access::transactional(kind, here.flavor),
            Some(std::time::Duration::from_secs(60)),
            stop,
        );
        match ran {
            Ok(mut ran) => {
                let carried = ran
                    .failed
                    .and_then(|i| shown.get(i))
                    .is_some_and(|s| s.secret);
                ran.error = ran
                    .error
                    .map(|e| access::scrubbed(e, carried, &real, &passwords));
                Ok(ran)
            }
            // begin or commit failed: which statement it was is not known
            Err(e) => Err(access::scrubbed(
                e,
                passwords.iter().any(Option::is_some),
                &real,
                &passwords,
            )),
        }
    });
    manager.close_session(&id, SESSION);
    ran
}

// ── Copying tables between connections (prompt 045) ──────────────────────────────────────────

fn transfer_plan_of(
    manager: &ConnectionManager,
    source: &str,
    target: &str,
    request: &crate::db::transfer::Request,
) -> AppResult<(crate::db::DbKind, crate::db::transfer::Plan)> {
    use crate::db::compare;
    let from = manager.kind_of(source)?;
    let to = manager.kind_of(target)?;
    // a table copied into itself would read what it writes – and, emptied first, lose its rows
    if source == target && (from.is_sqlite() || request.source_schema == request.target_schema) {
        return Err(AppError::new(
            ErrorCode::Unsupported,
            "source and target are the same schema: a table cannot be copied into itself",
        ));
    }
    let read = |id: &str, schema: &str| {
        manager.ask(id, |session, kind, stop| {
            compare::snapshot(session, kind, schema, stop)
        })
    };
    let source_snapshot = read(source, &request.source_schema)?;
    let target_snapshot = read(target, &request.target_schema)?;
    let plan = crate::db::transfer::plan(from, to, &source_snapshot, &target_snapshot, request)?;
    Ok((to, plan))
}

/// What copying tables from one connection to another would do (prompt 045): per table the columns
/// with their types in the target and what gets lost, and every statement that would run there.
/// Nothing is written.
#[tauri::command(async)]
pub fn transfer_plan(
    manager: State<'_, ConnectionManager>,
    source: String,
    target: String,
    request: crate::db::transfer::Request,
) -> AppResult<crate::db::transfer::Plan> {
    transfer_plan_of(&manager, &source, &target, &request).map(|(_, plan)| plan)
}

/// Copies the tables (prompt 045). The plan is made here again; each of its statements passes the guard
/// of the target (`confirmations[i]` for statement `i` of the plan); the rows stream from a session of
/// the source into one of the target, every value bound. A job: `cancel_job` ends it at the next block.
/// `error_path` (from the save dialog) names the file for rows that were left out – one per table,
/// with the name of the table in its name.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn transfer_run(
    manager: State<'_, ConnectionManager>,
    jobs: State<'_, Jobs>,
    job_id: u64,
    source: String,
    target: String,
    request: crate::db::transfer::Request,
    confirmations: Option<Vec<Option<String>>>,
    allow_dangerous: bool,
    error_path: Option<String>,
    timeout_ms: Option<u64>,
    on_event: Channel<crate::db::transfer::Event>,
) -> AppResult<crate::db::transfer::Report> {
    use std::sync::atomic::Ordering;
    const FROM: &str = "sc-copy-from";
    const TO: &str = "sc-copy-to";
    let error_path = error_path.as_deref().map(export_target).transpose()?;
    let (to, plan) = transfer_plan_of(&manager, &source, &target, &request)?;
    let tokens = confirmations.unwrap_or_default();
    // all of them before the first one runs
    for (i, sql) in plan.statements.iter().enumerate() {
        let token = tokens.get(i).and_then(|t| t.as_deref());
        manager.admit(&target, sql, token, allow_dangerous)?;
    }
    let timeout = timeout_ms
        .filter(|ms| *ms > 0)
        .map(std::time::Duration::from_millis);
    // a file per table: `errors.csv` → `errors.orders.csv`; only letters and digits of the name
    let error_file = |table: &str| -> Option<PathBuf> {
        let base = error_path.as_ref()?;
        let safe: String = table
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .take(80)
            .collect();
        let stem = base.file_stem()?.to_string_lossy().into_owned();
        let name = match base.extension() {
            Some(ext) => format!("{stem}.{safe}.{}", ext.to_string_lossy()),
            None => format!("{stem}.{safe}"),
        };
        Some(base.with_file_name(name))
    };
    let stop = jobs.start(job_id, None);
    let stopped = || stop.load(Ordering::Relaxed);
    let report = manager.ask_in(&source, FROM, |from_session, _, _| {
        manager.ask_in(&target, TO, |to_session, _, _| {
            Ok(crate::db::transfer::run(
                from_session,
                to_session,
                to,
                &plan,
                &error_file,
                timeout,
                &|event| {
                    let _ = on_event.send(event);
                },
                &stopped,
            ))
        })
    });
    jobs.end(job_id);
    // whatever was begun on those sessions goes with them
    manager.close_session(&source, FROM);
    manager.close_session(&target, TO);
    report
}

// ── Backup and restore (prompt 044) ─────────────────────────────────────────────────────

/// A tool of the database as the dialog shows it.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub tool: crate::backup::Tool,
    /// Where it is; `None`: not found.
    pub path: Option<String>,
    /// What `--version` says.
    pub version: Option<String>,
    pub major: Option<u32>,
}

/// What the dialog needs to know before a backup.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub tools: Vec<ToolInfo>,
    /// The major version of the server; a tool older than it may not read everything.
    pub server_major: Option<u32>,
}

type ToolPaths = std::collections::HashMap<crate::backup::Tool, String>;

fn locate(tool: crate::backup::Tool, paths: &ToolPaths) -> AppResult<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    crate::backup::find(
        tool,
        paths.get(&tool).map(String::as_str),
        std::env::var_os("PATH").as_deref(),
        home.as_deref(),
        &|p| p.is_file(),
    )
}

/// The tools for the database of a connection: where they are and how old (prompt 044). `paths`: where
/// the user said they are. Nothing is downloaded, nothing but `--version` runs.
#[tauri::command(async)]
pub fn backup_tools(
    manager: State<'_, ConnectionManager>,
    id: String,
    paths: ToolPaths,
) -> AppResult<BackupInfo> {
    let kind = manager.kind_of(&id)?;
    let tools = crate::backup::tools_of(kind)
        .iter()
        .map(|&tool| match locate(tool, &paths) {
            Ok(path) => {
                let version = crate::backup::version(&path).ok().filter(|v| !v.is_empty());
                ToolInfo {
                    tool,
                    major: version.as_deref().and_then(crate::backup::major_version),
                    version,
                    path: Some(path.to_string_lossy().into_owned()),
                }
            }
            Err(_) => ToolInfo {
                tool,
                path: None,
                version: None,
                major: None,
            },
        })
        .collect();
    let server_major = manager
        .ask(&id, |session, _, stop| session.server_version(stop))
        .ok()
        .as_deref()
        .and_then(crate::backup::major_version);
    Ok(BackupInfo {
        tools,
        server_major,
    })
}

/// Whether the MySQL tool on this machine is MariaDB's: said by its `--version`.
fn maria_client(
    endpoint: &crate::backup::Endpoint,
    paths: &ToolPaths,
    tool: crate::backup::Tool,
) -> bool {
    endpoint.kind == crate::db::DbKind::Mysql
        && locate(tool, paths)
            .ok()
            .and_then(|program| crate::backup::version(&program).ok())
            .is_some_and(|v| v.to_lowercase().contains("mariadb"))
}

/// A folder of this app for the file with the password of MySQL: the user's alone.
fn private_folder(app: &AppHandle) -> AppResult<PathBuf> {
    let io = |e: std::io::Error| AppError::new(ErrorCode::Io, e.to_string());
    let folder = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))?
        .join("private");
    std::fs::create_dir_all(&folder).map_err(io)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)).map_err(io)?;
    }
    // what a run left that was killed with the app (one job at a time: nothing here is in use)
    if let Ok(entries) = std::fs::read_dir(&folder) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(folder)
}

/// Writes a backup of the database of a connection with its own tool (prompt 044). `path` comes from the
/// save dialog. A job: `cancel_job` ends the program and removes what it wrote. `on_line` hears what the
/// program says.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn backup_dump(
    app: AppHandle,
    manager: State<'_, ConnectionManager>,
    jobs: State<'_, Jobs>,
    job_id: u64,
    id: String,
    spec: crate::backup::DumpSpec,
    path: String,
    paths: ToolPaths,
    on_line: Channel<String>,
) -> AppResult<crate::backup::Done> {
    use std::sync::atomic::Ordering;
    let target = export_target(&path)?;
    let (mut endpoint, tunnel, _) = manager.external(&id)?;
    endpoint.maria_client = maria_client(&endpoint, &paths, crate::backup::Tool::MysqlDump);
    let invocation = crate::backup::dump(&endpoint, &spec, &target)?;
    let program = locate(invocation.tool, &paths)?;
    let private = private_folder(&app)?;
    let stop = jobs.start(job_id, None);
    let done = crate::backup::run(
        &program,
        &invocation,
        &private,
        &|line| {
            let _ = on_line.send(line);
        },
        &|| stop.load(Ordering::Relaxed),
    );
    jobs.end(job_id);
    // the tunnel lived as long as the program
    drop(tunnel);
    if done.is_ok() {
        jobs.written.lock().insert(target);
    }
    done
}

/// What a file to restore is (`path` from the open dialog).
#[tauri::command(async)]
pub fn backup_file_kind(path: String) -> AppResult<crate::backup::FileKind> {
    crate::backup::file_kind(&export_target(&path)?)
}

/// Plays a backup into the database of a connection (prompt 044). It writes whatever the file says: a
/// connection that only reads refuses, one that asks wants its name typed (`typed_name`) – decided here.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn backup_restore(
    app: AppHandle,
    manager: State<'_, ConnectionManager>,
    jobs: State<'_, Jobs>,
    job_id: u64,
    id: String,
    spec: crate::backup::RestoreSpec,
    path: String,
    paths: ToolPaths,
    typed_name: Option<String>,
    on_line: Channel<String>,
) -> AppResult<crate::backup::Done> {
    use crate::db::guard::Protection;
    use std::sync::atomic::Ordering;
    let source = export_target(&path)?;
    let (mut endpoint, tunnel, profile) = manager.external(&id)?;
    endpoint.maria_client = maria_client(&endpoint, &paths, crate::backup::Tool::Mysql);
    match profile.protection {
        Protection::Readonly => {
            return Err(AppError::new(
                ErrorCode::PermissionDenied,
                "this connection is read only: nothing is restored into it",
            ));
        }
        // (a connection that is free asks in the window only – as for every statement that is not
        // dangerous there; what the file holds nobody can classify, so `admit` has nothing to judge)
        Protection::Ask if typed_name.as_deref().map(str::trim) != Some(profile.name.trim()) => {
            return Err(AppError::new(
                ErrorCode::ConfirmationRequired,
                "type the name of the connection to restore into it",
            ));
        }
        _ => {}
    }
    let kind = crate::backup::file_kind(&source)?;
    let invocation = crate::backup::restore(&endpoint, &spec, kind, &source)?;
    let program = locate(invocation.tool, &paths)?;
    let private = private_folder(&app)?;
    let stop = jobs.start(job_id, None);
    let done = crate::backup::run(
        &program,
        &invocation,
        &private,
        &|line| {
            let _ = on_line.send(line);
        },
        &|| stop.load(Ordering::Relaxed),
    );
    jobs.end(job_id);
    drop(tunnel);
    done
}

/// A copy of a SQLite database as a file of its own (prompt 044): `VACUUM INTO`, consistent while the
/// database is in use. `path` comes from the save dialog, which asked before replacing a file.
#[tauri::command(async)]
pub fn backup_sqlite(
    manager: State<'_, ConnectionManager>,
    id: String,
    path: String,
) -> AppResult<u64> {
    let target = export_target(&path)?;
    if manager.kind_of(&id)? != crate::db::DbKind::Sqlite {
        return Err(AppError::new(
            ErrorCode::Unsupported,
            "not a SQLite database",
        ));
    }
    let text = target
        .to_str()
        .ok_or_else(|| AppError::new(ErrorCode::Io, "the target is no path SQLite can be told"))?
        .to_owned();
    // never over the database itself
    let same = |a: &Path, b: &Path| match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    let (_, _, profile) = manager.external(&id)?;
    if same(&target, Path::new(&profile.database)) || target.is_dir() {
        return Err(AppError::new(
            ErrorCode::Unsupported,
            "the copy needs a file of its own",
        ));
    }
    // written beside the target (VACUUM INTO wants a file that is not there), in its place when whole
    let part = crate::backup::part_of(&target);
    let _ = std::fs::remove_file(&part);
    let part_text = part
        .to_str()
        .ok_or_else(|| AppError::new(ErrorCode::Io, "the target is no path SQLite can be told"))?
        .to_owned();
    let _ = text;
    let copied = manager.ask(&id, |session, _, stop| {
        session
            .ask("VACUUM INTO ?1", &[part_text.as_str()], None, stop)
            .map(|_| ())
    });
    if let Err(e) = copied {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    crate::backup::put_in_place(&part, &target)
        .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))?;
    Ok(std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0))
}

/// The simple export (prompt 044, without the tools of the database): the tables of a schema as
/// `CREATE` statements – written by the migration of the schema comparison against nothing – and their
/// rows as `INSERT`s, in one file. No rights, no sequences, no routines: said in the file. A job.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn backup_simple(
    manager: State<'_, ConnectionManager>,
    jobs: State<'_, Jobs>,
    job_id: u64,
    id: String,
    schema: String,
    data: bool,
    path: String,
    on_line: Channel<String>,
) -> AppResult<crate::backup::Done> {
    use std::sync::atomic::Ordering;
    let target = export_target(&path)?;
    let kind = manager.kind_of(&id)?;
    let stop = jobs.start(job_id, Some(id.clone()));
    let work = || -> AppResult<u64> {
        let snapshot = manager.ask(&id, |session, kind, stop| {
            crate::db::compare::snapshot(session, kind, &schema, stop)
        })?;
        crate::backup::simple_export(
            kind,
            &snapshot,
            data,
            &target,
            &mut |sql, sink| manager.run_into(&id, sql, None, sink).map(|_| ()),
            &|table| {
                let _ = on_line.send(table);
            },
            &|| stop.load(Ordering::Relaxed),
        )
    };
    let done = work();
    jobs.end(job_id);
    let bytes = done?;
    jobs.written.lock().insert(target);
    Ok(crate::backup::Done {
        bytes,
        warnings: false,
    })
}

/// The plan of one statement (prompt 039). Without `analyze` nothing runs: the database only says how
/// it would. With `analyze` the statement **runs** – it passes the guard like any statement
/// (`confirmation`), inside a transaction that is rolled back, on a session of its own.
#[tauri::command(async)]
pub fn explain_plan(
    manager: State<'_, ConnectionManager>,
    id: String,
    sql: String,
    analyze: bool,
    confirmation: Option<String>,
    allow_dangerous: bool,
    timeout_ms: Option<u64>,
) -> AppResult<crate::db::plan::Plan> {
    const SESSION: &str = "sc-plan";
    if analyze {
        manager.admit(&id, &sql, confirmation.as_deref(), allow_dangerous)?;
    }
    let timeout = timeout_ms
        .filter(|ms| *ms > 0)
        .map(std::time::Duration::from_millis);
    let plan = manager.ask_in(&id, SESSION, |session, kind, stop| {
        crate::db::plan::explain(session, kind, &sql, analyze, timeout, stop)
    });
    // whatever was set or begun on that session goes with it
    manager.close_session(&id, SESSION);
    plan
}

/// What a schema is made of (prompt 038): tables with columns, keys, indexes and checks, views,
/// routines, triggers – read from the catalog. To compare, and to keep as a file.
#[tauri::command(async)]
pub fn schema_snapshot(
    manager: State<'_, ConnectionManager>,
    id: String,
    schema: String,
) -> AppResult<crate::db::compare::Snapshot> {
    manager.ask(&id, |session, kind, stop| {
        crate::db::compare::snapshot(session, kind, &schema, stop)
    })
}

/// The difference of two snapshots (of the same kind of database). Pure: nothing is asked or run.
#[tauri::command(async)]
pub fn schema_compare(
    left: crate::db::compare::Snapshot,
    right: crate::db::compare::Snapshot,
    renames: Vec<crate::db::compare::Rename>,
) -> AppResult<Vec<crate::db::compare::Item>> {
    crate::db::compare::compare(&left, &right, &renames)
}

/// The script that would make `target` like `source`, for the chosen differences. A text for an
/// editor: nothing runs here. Steps that may lose data are comments.
#[tauri::command(async)]
pub fn schema_script(
    source: crate::db::compare::Snapshot,
    target: crate::db::compare::Snapshot,
    picks: Option<Vec<String>>,
    renames: Vec<crate::db::compare::Rename>,
) -> AppResult<String> {
    crate::db::compare::script(&source, &target, picks.as_deref(), &renames)
}

/// Searches a text on the server (prompt 036): in the rows of tables and in definitions. A job that
/// `cancel_job` stops; `on_event` hears every hit as it is found. Only statements that read run, built
/// here; the text is bound.
#[tauri::command(async)]
pub fn find_on_server(
    manager: State<'_, ConnectionManager>,
    jobs: State<'_, Jobs>,
    job_id: u64,
    id: String,
    spec: crate::db::find::FindSpec,
    on_event: Channel<crate::db::find::FindEvent>,
) -> AppResult<crate::db::find::FindReport> {
    use std::sync::atomic::Ordering;
    /// The session the search runs on: its own, so the tree and the completion are not held up.
    const SESSION: &str = "sc-find";
    let stop = jobs.start(job_id, None);
    let mut report: Option<crate::db::find::FindReport> = None;
    // a driver that can stop a table that takes too long only by dropping the connection (SQL Server)
    // loses it there: the search goes on behind that table on a new one
    let result = loop {
        let resume = report.as_ref().and_then(|r| r.resume);
        let part = manager.ask_in(&id, SESSION, |session, kind, stopped| {
            crate::db::find::find(
                session,
                kind,
                &spec,
                resume,
                &|event| {
                    let _ = on_event.send(event);
                },
                &|| stop.load(Ordering::Relaxed) || stopped(),
            )
        });
        match (part, report.take()) {
            (Ok(next), before) => {
                let all = match before {
                    Some(before) => before.and(next),
                    None => next,
                };
                let again = all.lost && all.resume.is_some() && !all.cancelled;
                if !again || stop.load(Ordering::Relaxed) {
                    break Ok(all);
                }
                report = Some(all);
            }
            // no new connection: what was found so far is the report
            (Err(_), Some(before)) => break Ok(before),
            (Err(e), None) => break Err(e),
        }
    };
    jobs.end(job_id);
    manager.close_session(&id, SESSION);
    result
}

/// What the About dialog shows (prompt 034): name, version, build, platform. Nothing about the user.
#[tauri::command(async)]
pub fn app_info(app: AppHandle) -> crate::about::AppInfo {
    let info = app.package_info();
    crate::about::app_info(&info.name, &info.version.to_string())
}

/// The licence texts of the third-party components, from the file in the package.
#[tauri::command(async)]
pub fn third_party_notices(app: AppHandle) -> AppResult<String> {
    use tauri::Manager;
    let resources = app.path().resource_dir().ok();
    crate::about::read_notices(&crate::about::notices_candidates(resources.as_deref()))
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "the notices are not in this package"))
}

/// A file that is to be loaded: it must be a full path (it comes from the open dialog).
fn import_source(path: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(AppError::new(ErrorCode::Io, "the file is no full path"));
    }
    Ok(path)
}

/// What a file holds (prompt 033): format, delimiter, encoding and header as detected (or as `options`
/// say), its columns, the first records and a type guessed for each column. Nothing is written.
#[tauri::command(async)]
pub fn load_preview(
    path: String,
    options: crate::data_import::SourceOptions,
    nulls: Vec<String>,
) -> AppResult<crate::data_import::Preview> {
    crate::data_import::preview(&import_source(&path)?, &options, &nulls)
}

/// A `CREATE TABLE` proposed for the columns of a file. The window shows it; it runs like any statement.
#[tauri::command(async)]
pub fn load_table_ddl(
    manager: State<'_, ConnectionManager>,
    id: String,
    schema: Option<String>,
    table: String,
    columns: Vec<(String, crate::data_import::Guess)>,
) -> AppResult<String> {
    crate::db::load::create_table(manager.kind_of(&id)?, schema.as_deref(), &table, &columns)
}

/// Runs the `CREATE TABLE` of an import, as the user left it: exactly one statement that creates a
/// table – anything else, or anything more, is refused – through the guard of the connection
/// (`confirmation` from `confirm_statements`).
#[tauri::command(async)]
pub fn load_create_table(
    manager: State<'_, ConnectionManager>,
    id: String,
    sql: String,
    confirmation: Option<String>,
    timeout_ms: Option<u64>,
) -> AppResult<()> {
    if !crate::db::guard::is_create_table(&sql, manager.kind_of(&id)?) {
        return Err(AppError::new(
            ErrorCode::PermissionDenied,
            "only one statement that creates a table runs here",
        ));
    }
    manager.admit(&id, &sql, confirmation.as_deref(), false)?;
    let limits = crate::db::Limits {
        max_rows: 1,
        timeout: timeout_ms
            .filter(|ms| *ms > 0)
            .map(std::time::Duration::from_millis),
    };
    manager.ask(&id, |session, _, stop| {
        session.query(&sql, limits, stop).map(|_| ())
    })
}

/// Whether two paths name the same file, whatever way they are written (`.`, links, the case of a
/// file system that ignores it). `target` need not exist yet.
fn same_file(source: &std::path::Path, target: &std::path::Path) -> bool {
    let real = |p: &std::path::Path| {
        p.canonicalize().ok().or_else(|| {
            let parent = p.parent()?.canonicalize().ok()?;
            Some(parent.join(p.file_name()?))
        })
    };
    match (real(source), real(target)) {
        (Some(a), Some(b)) => {
            a == b || a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
        }
        _ => source == target,
    }
}

/// The statements an import stands for, to ask the guard about: the `INSERT` (of one row), and before
/// it the `DELETE` that empties the table, if the plan wants that.
fn import_sqls(
    kind: crate::db::DbKind,
    plan: &crate::db::load::LoadPlan,
) -> AppResult<Vec<String>> {
    let mut sqls = Vec::with_capacity(2);
    if plan.clear_first {
        sqls.push(crate::db::load::clear_statement(kind, plan)?);
    }
    sqls.push(crate::db::load::shape(kind, plan)?.sql);
    Ok(sqls)
}

#[tauri::command(async)]
pub fn load_statements(
    manager: State<'_, ConnectionManager>,
    id: String,
    plan: crate::db::load::LoadPlan,
) -> AppResult<Vec<String>> {
    import_sqls(manager.kind_of(&id)?, &plan)
}

/// Loads a file into a table (prompt 033) as a job with progress that `cancel_job` stops. The
/// statements are built here from the plan (the window never sends SQL) and pass the guard first
/// (`confirmations[i]` for statement `i` of `load_statements`). Every value is bound. `error_path`
/// comes from the save dialog.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn load_run(
    manager: State<'_, ConnectionManager>,
    jobs: State<'_, Jobs>,
    job_id: u64,
    id: String,
    path: String,
    options: crate::data_import::SourceOptions,
    plan: crate::db::load::LoadPlan,
    error_path: Option<String>,
    confirmations: Option<Vec<Option<String>>>,
    allow_dangerous: bool,
    timeout_ms: Option<u64>,
    on_progress: Channel<u64>,
) -> AppResult<crate::db::load::Loaded> {
    use std::sync::atomic::Ordering;
    let path = import_source(&path)?;
    let error_path = error_path.as_deref().map(export_target).transpose()?;
    if error_path.as_ref().is_some_and(|e| same_file(&path, e)) {
        return Err(AppError::new(
            ErrorCode::Io,
            "the error file must not be the file that is loaded",
        ));
    }
    let kind = manager.kind_of(&id)?;
    let tokens = confirmations.unwrap_or_default();
    for (i, sql) in import_sqls(kind, &plan)?.iter().enumerate() {
        let token = tokens.get(i).and_then(|t| t.as_deref());
        manager.admit(&id, sql, token, allow_dangerous)?;
    }
    let mut source = crate::data_import::Source::open(&path, &options)?;
    let timeout = timeout_ms
        .filter(|ms| *ms > 0)
        .map(std::time::Duration::from_millis);
    let stop = jobs.start(job_id, Some(id.clone()));
    let result = manager.ask(&id, |session, kind, stopped| {
        crate::db::load::load(
            session,
            kind,
            &mut source,
            &plan,
            error_path.as_deref(),
            timeout,
            &|n| {
                let _ = on_progress.send(n);
            },
            &|| stop.load(Ordering::Relaxed) || stopped(),
        )
    });
    jobs.end(job_id);
    if let (Ok(done), Some(file)) = (&result, error_path)
        && done.error_file
    {
        jobs.written.lock().insert(file);
    }
    result
}

/// What statements are and what they need on a connection before they may run (prompt 012).
#[tauri::command(async)]
pub fn check_statements(
    manager: State<'_, ConnectionManager>,
    id: String,
    sqls: Vec<String>,
    allow_dangerous: bool,
) -> AppResult<Vec<Verdict>> {
    sqls.iter()
        .map(|sql| manager.verdict(&id, sql, allow_dangerous))
        .collect()
}

/// The user confirmed these statements (for dangerous ones on a protected connection: by typing its
/// name). Returns a token for each statement that needs one; `run_query` takes it.
#[tauri::command(async)]
pub fn confirm_statements(
    manager: State<'_, ConnectionManager>,
    id: String,
    sqls: Vec<String>,
    typed_name: Option<String>,
    allow_dangerous: bool,
) -> AppResult<Vec<Option<String>>> {
    manager.confirm(&id, &sqls, typed_name.as_deref(), allow_dangerous)
}

/// Lays SQL out or changes the case of its keywords (prompt 023). Pure work on the text, but a script can
/// be large: it is a job that `cancel_job` stops. The text is neither kept nor logged.
#[tauri::command(async)]
pub fn format_sql(
    jobs: State<'_, Jobs>,
    job_id: u64,
    sql: String,
    dialect: format::Dialect,
    mode: format::Mode,
    style: format::Style,
    crlf: bool,
) -> AppResult<String> {
    use std::sync::atomic::Ordering;
    let stop = jobs.start(job_id, None);
    let result = format::format(&sql, dialect, &style, mode, crlf, &|| {
        stop.load(Ordering::Relaxed)
    });
    jobs.end(job_id);
    result.map_err(format_error)
}

fn format_error(e: format::FormatError) -> AppError {
    use format::FormatError as E;
    let (code, message) = match e {
        E::Cancelled => (ErrorCode::Cancelled, "formatting was stopped"),
        E::Incomplete => (
            ErrorCode::FormatIncomplete,
            "the text ends inside a string, a quoted name or a comment",
        ),
        E::TooDeep => (ErrorCode::FormatTooDeep, "nested too deep"),
        E::Unsafe => (
            ErrorCode::FormatUnsafe,
            "the result would not have had the tokens of the text",
        ),
        E::TooLarge => (ErrorCode::TooLarge, "too much text"),
    };
    AppError::new(code, message)
}

/// Stops a job (its statement on the server too; the search on the server runs on a session of its
/// own, which is stopped as well).
#[tauri::command(async)]
pub fn cancel_job(manager: State<'_, ConnectionManager>, jobs: State<'_, Jobs>, job_id: u64) {
    let connection = {
        let running = jobs.running.lock();
        let Some(job) = running.get(&job_id) else {
            return;
        };
        job.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        job.connection.clone()
    };
    if let Some(id) = connection {
        manager.cancel(&id);
    }
}

/// The first rows of a result as the export would write them (Excel: as tab-separated text).
#[tauri::command(async)]
pub fn export_preview(
    store: State<'_, ResultStore>,
    result_id: u64,
    spec: export::Spec,
) -> AppResult<String> {
    let format = match spec.format {
        export::FileFormat::Csv => Format::Csv,
        export::FileFormat::Json => Format::Json,
        export::FileFormat::Ndjson => Format::Ndjson,
        export::FileFormat::Insert => Format::Insert,
        export::FileFormat::Markdown => Format::Markdown,
        export::FileFormat::Html => Format::Html,
        export::FileFormat::Tsv | export::FileFormat::Xlsx => Format::Tsv,
    };
    let selection = Selection {
        rows: vec![(0, 4)],
        columns: spec.columns.clone(),
    };
    let (text, _) = copy::render(&store, result_id, &selection, format, spec.options, &|| {
        false
    })?;
    Ok(text.chars().take(4000).collect())
}

/// Shows a file the app wrote in the file manager of the OS. Any other path is refused.
#[tauri::command(async)]
pub fn reveal_export(jobs: State<'_, Jobs>, path: String) -> AppResult<()> {
    let path = PathBuf::from(path);
    if !jobs.written.lock().contains(&path) || !path.exists() {
        return Err(AppError::new(
            ErrorCode::NotFound,
            "this file is not one the app wrote",
        ));
    }
    let mut command = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg("-R").arg(&path);
        c
    } else if cfg!(target_os = "windows") {
        let mut c = std::process::Command::new("explorer");
        c.arg(format!("/select,{}", path.display()));
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(path.parent().unwrap_or(&path));
        c
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| AppError::new(ErrorCode::Io, format!("file manager: {e}")))
}

/// Notes a statement that ran in the history (prompt 010). Whether a connection is noted at all is the
/// frontend's setting: what must not be kept is never sent.
#[tauri::command(async)]
pub fn history_add(
    history: State<'_, History>,
    entry: history::NewEntry,
    keep: history::Keep,
) -> AppResult<i64> {
    history.add(&entry, keep)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    #[serde(flatten)]
    page: history::Page,
    /// Said once: the file was broken and set aside.
    notice: Option<String>,
}

/// The entries of the history that match, the latest first.
#[tauri::command(async)]
pub fn history_list(
    history: State<'_, History>,
    filter: history::Filter,
) -> AppResult<HistoryPage> {
    let page = history.list(&filter)?;
    Ok(HistoryPage {
        page,
        notice: history.take_notice(),
    })
}

/// The whole text of an entry.
#[tauri::command(async)]
pub fn history_text(history: State<'_, History>, id: i64) -> AppResult<String> {
    history.text(id)
}

/// Deletes entries for good; returns how many.
#[tauri::command(async)]
pub fn history_delete(history: State<'_, History>, scope: history::Scope) -> AppResult<usize> {
    history.delete(&scope)
}

/// The schemas of an open connection (prompt 008).
#[tauri::command(async)]
pub fn meta_schemas(
    manager: State<'_, ConnectionManager>,
    id: String,
) -> AppResult<Vec<meta::SchemaInfo>> {
    manager.ask(&id, meta::schemas)
}

/// What is in a schema: tables, views, routines, sequences, types.
#[tauri::command(async)]
pub fn meta_objects(
    manager: State<'_, ConnectionManager>,
    id: String,
    schema: String,
) -> AppResult<Vec<meta::ObjectInfo>> {
    manager.ask(&id, |s, kind, stop| meta::objects(s, kind, &schema, stop))
}

/// Columns, indexes, keys and triggers of a table or view.
#[tauri::command(async)]
pub fn meta_table(
    manager: State<'_, ConnectionManager>,
    id: String,
    schema: String,
    table: String,
) -> AppResult<meta::TableInfo> {
    manager.ask(&id, |s, kind, stop| {
        meta::table(s, kind, &schema, &table, stop)
    })
}

/// The foreign keys of a table and those that point to it (prompt 030).
#[tauri::command(async)]
pub fn meta_relations(
    manager: State<'_, ConnectionManager>,
    id: String,
    schema: String,
    table: String,
) -> AppResult<crate::db::relations::Relations> {
    manager.ask(&id, |s, kind, stop| {
        crate::db::relations::relations(s, kind, &schema, &table, stop)
    })
}

/// Everything about one object: its lists and its DDL (prompt 019). `detail` tells overloaded routines
/// apart.
#[tauri::command(async)]
pub fn meta_details(
    manager: State<'_, ConnectionManager>,
    id: String,
    schema: String,
    name: String,
    kind: meta::ObjectKind,
    detail: Option<String>,
) -> AppResult<crate::db::details::ObjectDetails> {
    manager.ask(&id, |s, db, stop| {
        crate::db::details::details(
            s,
            db,
            &schema,
            &name,
            kind,
            detail.as_deref().unwrap_or(""),
            stop,
        )
    })
}

/// Tables and views by a part of their name, in all schemas.
#[tauri::command(async)]
pub fn meta_search(
    manager: State<'_, ConnectionManager>,
    id: String,
    text: String,
) -> AppResult<Vec<meta::Found>> {
    if text.chars().count() > 200 {
        return Ok(Vec::new());
    }
    manager.ask(&id, |s, kind, stop| meta::search(s, kind, &text, stop))
}

/// Stops the statement that runs on a connection, or on the session of one of its tabs.
#[tauri::command(async)]
pub fn cancel_query(manager: State<'_, ConnectionManager>, id: String, session: Option<String>) {
    manager.cancel_in(&id, session.as_deref());
}

/// Ends the transaction of a tab with `COMMIT` or `ROLLBACK` (prompt 013); returns what the server says
/// about the session afterwards.
#[tauri::command(async)]
pub fn end_transaction(
    manager: State<'_, ConnectionManager>,
    id: String,
    session: Option<String>,
    commit: bool,
) -> AppResult<TxState> {
    manager.end_transaction(&id, session.as_deref(), commit)
}

/// What the server said last about the transaction of a tab (after a statement that failed).
#[tauri::command(async)]
pub fn tx_state(
    manager: State<'_, ConnectionManager>,
    id: String,
    session: Option<String>,
) -> TxState {
    manager.tx_state(&id, session.as_deref())
}

/// Closes the session of a tab; the server rolls back what was open on it.
#[tauri::command(async)]
pub fn close_session(manager: State<'_, ConnectionManager>, id: String, session: String) {
    manager.close_session(&id, &session);
}

/// The open tabs of the last run (prompt 004). Text files no tab owns any more are removed.
#[tauri::command(async)]
pub fn load_session(dir: State<'_, SessionDir>) -> LoadedSession {
    let loaded = dir.load();
    let keep: Vec<&str> = loaded.session.tabs.iter().map(|t| t.id.as_str()).collect();
    dir.sweep(&keep);
    loaded
}

#[tauri::command(async)]
pub fn save_session(dir: State<'_, SessionDir>, session: SessionFile) -> AppResult<()> {
    dir.save(&session)
}

#[tauri::command(async)]
pub fn load_tab_text(dir: State<'_, SessionDir>, id: String) -> AppResult<String> {
    dir.load_text(&id)
}

/// The running backup of a tab's text.
#[tauri::command(async)]
pub fn save_tab_text(dir: State<'_, SessionDir>, id: String, text: String) -> AppResult<()> {
    dir.save_text(&id, &text)
}

#[tauri::command(async)]
pub fn delete_tab_text(dir: State<'_, SessionDir>, id: String) -> AppResult<()> {
    dir.delete_text(&id)
}

/// Saved queries (prompt 024): `.sql` files in one folder. `path` comes from the folder dialog; `None` is
/// the app's own folder. Every other command names a query by its path below that folder.
#[tauri::command(async)]
pub fn saved_use_folder(
    dir: State<'_, SavedDir>,
    path: Option<String>,
) -> AppResult<saved::Listing> {
    dir.set(path.as_deref())?;
    Ok(saved::list(&dir.root()))
}

#[tauri::command(async)]
pub fn saved_list(dir: State<'_, SavedDir>) -> saved::Listing {
    saved::list(&dir.root())
}

/// A fingerprint of the folder: differs when something changed in it, also from outside.
#[tauri::command(async)]
pub fn saved_stamp(dir: State<'_, SavedDir>) -> String {
    saved::stamp(&dir.root())
}

#[tauri::command(async)]
pub fn saved_read(dir: State<'_, SavedDir>, id: String) -> AppResult<saved::Saved> {
    saved::read(&dir.root(), &id)
}

/// Writes a query; `id` = the file to write again, else a new one in `folder`. Answers with the id.
#[tauri::command(async)]
pub fn saved_save(
    dir: State<'_, SavedDir>,
    id: Option<String>,
    folder: String,
    meta: saved::Meta,
    text: String,
) -> AppResult<String> {
    saved::save(&dir.root(), id.as_deref(), &folder, &meta, &text)
}

#[tauri::command(async)]
pub fn saved_rename(
    dir: State<'_, SavedDir>,
    id: String,
    folder: String,
    name: String,
) -> AppResult<String> {
    saved::rename(&dir.root(), &id, &folder, &name)
}

#[tauri::command(async)]
pub fn saved_create_folder(dir: State<'_, SavedDir>, folder: String) -> AppResult<()> {
    saved::create_folder(&dir.root(), &folder)
}

/// Moves the file of a query to the trash of the system: it can be brought back from there.
#[tauri::command(async)]
pub fn saved_delete(dir: State<'_, SavedDir>, id: String) -> AppResult<()> {
    let path = saved::path_for_delete(&dir.root(), &id)?;
    trash::delete(&path).map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))
}

#[tauri::command(async)]
pub fn saved_search(dir: State<'_, SavedDir>, query: String) -> Vec<String> {
    saved::search(&dir.root(), &query)
}

/// Reads a text file the user chose (native dialog, or dropped onto the window).
#[tauri::command(async)]
pub fn read_text_file(path: String) -> AppResult<TextFile> {
    textfile::read(Path::new(&path))
}

/// Writes a text to the path the user chose in the native dialog, in the given encoding.
#[tauri::command(async)]
pub fn write_text_file(path: String, text: String, encoding: String) -> AppResult<()> {
    textfile::write(Path::new(&path), &text, &encoding)
}

/// `#rrggbb` → channels.
pub fn parse_hex_rgb(color: &str) -> Option<(u8, u8, u8)> {
    let hex = color.strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
    Some((channel(0)?, channel(2)?, channel(4)?))
}

/// The window frame follows the colour scheme. `dark` forces the frame's appearance; `None` (follow
/// the system) leaves it to the system, because the frame's appearance also sets the webview's
/// `prefers-color-scheme` and a forced one would no longer follow the system. The window starts
/// hidden (`visible: false`) so a light scheme does not flash dark; the first call shows it.
#[tauri::command]
pub fn set_window_chrome(app: AppHandle, color: String, dark: Option<bool>) -> AppResult<()> {
    let (r, g, b) = parse_hex_rgb(&color)
        .ok_or_else(|| AppError::new(ErrorCode::Unsupported, "not a #rrggbb colour"))?;
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let io = |e: tauri::Error| AppError::new(ErrorCode::Io, e.to_string());
    let theme = dark.map(|d| {
        if d {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }
    });
    window.set_theme(theme).map_err(io)?;
    window
        .set_background_color(Some(tauri::window::Color(r, g, b, 255)))
        .map_err(io)?;
    show_main(&app);
    Ok(())
}

/// The channel of the menu events and the ids of the installed native menu (prompt 018).
#[derive(Default)]
pub struct MenuState {
    channel: parking_lot::Mutex<Option<Channel<crate::app_menu::MenuEvent>>>,
    ids: parking_lot::Mutex<std::collections::HashSet<String>>,
}

fn invalid_menu(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Unsupported, message)
}

/// Installs the native menu bar from the model of the window. `false` = this platform has none: the
/// window draws its own (design 018 E2). A spec that breaks a rule is refused and nothing changes.
///
/// The menu commands are synchronous on purpose: they change the native menu, the main thread is the
/// safe place for that on macOS, and they do no I/O.
#[tauri::command]
pub fn set_app_menu(app: AppHandle, spec: crate::app_menu::MenuSpec) -> AppResult<bool> {
    crate::app_menu::validate_spec(&spec).map_err(invalid_menu)?;
    if !crate::app_menu::native_menu_wanted() {
        return Ok(false);
    }
    let menu = crate::app_menu::build_menu(&app, &spec).map_err(|e| invalid_menu(e.to_string()))?;
    *app.state::<MenuState>().ids.lock() = crate::app_menu::item_ids(&spec);
    app.set_menu(menu)
        .map_err(|e| invalid_menu(e.to_string()))?;
    Ok(true)
}

/// Enables, disables and ticks items of the installed menu without building it again (states change
/// often). Ids the menu does not have are skipped.
#[tauri::command]
pub fn set_menu_state(app: AppHandle, items: Vec<crate::app_menu::MenuItemState>) -> AppResult<()> {
    let wanted = {
        let ids = app.state::<MenuState>().ids.lock().clone();
        crate::app_menu::validate_enabled(&items, &ids).map_err(invalid_menu)?
    };
    if wanted.is_empty() || !crate::app_menu::native_menu_wanted() {
        return Ok(());
    }
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    crate::app_menu::apply_enabled(&menu, &wanted).map_err(|e| invalid_menu(e.to_string()))
}

/// The ids of chosen menu items go to this channel.
#[tauri::command]
pub fn subscribe_menu(app: AppHandle, on_event: Channel<crate::app_menu::MenuEvent>) {
    *app.state::<MenuState>().channel.lock() = Some(on_event);
}

/// Called by Tauri for every chosen menu item: only ids of the installed spec go on.
pub fn forward_menu_event(app: &AppHandle, id: &str) {
    let state = app.state::<MenuState>();
    if !state.ids.lock().contains(id) {
        return;
    }
    if let Some(channel) = state.channel.lock().as_ref() {
        let _ = channel.send(crate::app_menu::MenuEvent { id: id.to_string() });
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main")
        && !window.is_visible().unwrap_or(true)
    {
        let _ = window.show();
    }
}

/// `themes.json` in the app's config folder.
fn themes_path(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(themes::FILE_NAME))
        .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))
}

/// The user's own colour schemes (design 001). Never fails: a broken file gives none and a notice.
#[tauri::command(async)]
pub fn load_themes(app: AppHandle) -> AppResult<LoadedThemes> {
    Ok(themes::load(&themes_path(&app)?))
}

#[tauri::command(async)]
pub fn save_themes(app: AppHandle, file: ThemesFile) -> AppResult<()> {
    themes::save(&themes_path(&app)?, &file)
}

/// Reads a scheme file the user chose in the native dialog; the frontend checks its content.
#[tauri::command(async)]
pub fn import_theme(path: String) -> AppResult<serde_json::Value> {
    themes::import(Path::new(&path))
}

/// Writes one scheme to the path the user chose in the native dialog.
#[tauri::command(async)]
pub fn export_theme(path: String, theme: UserTheme) -> AppResult<()> {
    themes::export(Path::new(&path), &theme)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_six_digit_hex() {
        assert_eq!(parse_hex_rgb("#14171c"), Some((0x14, 0x17, 0x1c)));
        assert_eq!(parse_hex_rgb("#FFF"), None);
        assert_eq!(parse_hex_rgb("14171c"), None);
        assert_eq!(parse_hex_rgb("#14171g"), None);
        assert_eq!(parse_hex_rgb("#ééé"), None);
    }

    /// The contract of prompt 023 with `format-api.ts`: what the window sends, and the codes it reads.
    #[test]
    fn the_format_contract_is_what_the_window_speaks() {
        let style: format::Style = serde_json::from_value(serde_json::json!({
            "keywordCase": "preserve", "indent": 2, "comma": "leading", "width": 80,
            "andOr": "trailing", "blankLines": 0
        }))
        .unwrap();
        assert_eq!(style.keyword_case, format::KeywordCase::Preserve);
        assert_eq!(style.comma, format::Place::Leading);
        assert_eq!(style.and_or, format::Place::Trailing);
        for (mode, dialect) in [
            ("format", "postgres"),
            ("oneline", "mysql"),
            ("upper", "sqlserver"),
            ("lower", "sqlite"),
        ] {
            serde_json::from_value::<format::Mode>(serde_json::json!(mode)).unwrap();
            serde_json::from_value::<format::Dialect>(serde_json::json!(dialect)).unwrap();
        }
        let code = |e| serde_json::to_value(format_error(e)).unwrap()["code"].clone();
        assert_eq!(code(format::FormatError::Cancelled), "cancelled");
        assert_eq!(code(format::FormatError::Incomplete), "format_incomplete");
        assert_eq!(code(format::FormatError::TooDeep), "format_too_deep");
        assert_eq!(code(format::FormatError::Unsafe), "format_unsafe");
        assert_eq!(code(format::FormatError::TooLarge), "too_large");
    }
    /// Review 033: the error file of an import must not be the file that is read, however its path
    /// is written.
    #[test]
    fn knows_the_same_file_under_another_spelling() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("in.csv");
        std::fs::write(&source, "a\n").unwrap();
        assert!(same_file(&source, &dir.path().join(".").join("in.csv")));
        assert!(same_file(&source, &dir.path().join("IN.csv")));
        assert!(!same_file(&source, &dir.path().join("in.errors.tsv")));
        #[cfg(unix)]
        {
            let link = dir.path().join("link.csv");
            std::os::unix::fs::symlink(&source, &link).unwrap();
            assert!(same_file(&source, &link));
        }
    }
}

// ── AI control over MCP (prompt 048) ─────────────────────────────────────────────────────

/// What the window hears of the assistant.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McpEvent {
    /// The number of connected assistants changed.
    Status { connections: usize },
    /// A call ended: a line of the protocol.
    Call { entry: crate::mcp::LogEntry },
    /// The window is asked: a proposal, text for a tab. It answers with `mcp_reply`.
    Request {
        id: u64,
        tool: String,
        args: serde_json::Value,
    },
}

/// The window, as the engine sees it.
pub struct McpWindow {
    channel: parking_lot::Mutex<Option<Channel<McpEvent>>>,
}

impl McpWindow {
    fn send(&self, event: McpEvent) -> bool {
        match self.channel.lock().as_ref() {
            Some(channel) => channel.send(event).is_ok(),
            None => false,
        }
    }
}

impl crate::mcp::Window for McpWindow {
    fn ask(&self, id: u64, tool: &str, args: &serde_json::Value) -> bool {
        self.send(McpEvent::Request {
            id,
            tool: tool.to_owned(),
            args: args.clone(),
        })
    }

    fn log(&self, entry: &crate::mcp::LogEntry) {
        self.send(McpEvent::Call {
            entry: entry.clone(),
        });
    }
}

/// AI control: the engine, and the bridge while it is on. Off, there is no bridge: no port, no file.
pub struct McpState {
    engine: std::sync::Arc<crate::mcp::Engine<McpWindow>>,
    host: parking_lot::Mutex<Option<sc_mcp::host::Host>>,
}

impl Default for McpState {
    fn default() -> Self {
        McpState {
            engine: std::sync::Arc::new(crate::mcp::Engine::new(McpWindow {
                channel: parking_lot::Mutex::new(None),
            })),
            host: parking_lot::Mutex::new(None),
        }
    }
}

/// The bridge hands every call to the engine, with the connections of the app.
struct McpBridge {
    app: AppHandle,
    engine: std::sync::Arc<crate::mcp::Engine<McpWindow>>,
}

impl sc_mcp::host::Handler for McpBridge {
    fn call(
        &self,
        tool: &str,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value, sc_mcp::bridge::BridgeError> {
        let manager = self.app.state::<ConnectionManager>();
        self.engine.call(manager.inner(), tool, args)
    }

    fn status(&self, connections: usize) {
        self.engine.window.send(McpEvent::Status { connections });
    }
}

/// Where the sidecar is: next to the app (bundled, and `target/debug` while developing).
fn mcp_sidecar() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "schema-commander-mcp.exe"
    } else {
        "schema-commander-mcp"
    };
    Some(std::env::current_exe().ok()?.parent()?.join(name))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    /// The bridge listens.
    running: bool,
    /// Assistants connected right now.
    connections: usize,
    /// The path of the sidecar, for the configuration of the assistant.
    sidecar: String,
    sidecar_found: bool,
}

fn mcp_status_of(state: &McpState) -> McpStatus {
    let host = state.host.lock();
    let sidecar = mcp_sidecar();
    McpStatus {
        running: host.is_some(),
        connections: host.as_ref().map_or(0, sc_mcp::host::Host::connections),
        sidecar_found: sidecar.as_ref().is_some_and(|p| p.is_file()),
        sidecar: sidecar
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// The events of AI control go to this channel.
#[tauri::command]
pub fn mcp_subscribe(state: State<'_, McpState>, on_event: Channel<McpEvent>) {
    *state.engine.window.channel.lock() = Some(on_event);
}

#[tauri::command(async)]
pub fn mcp_status(state: State<'_, McpState>) -> McpStatus {
    mcp_status_of(&state)
}

/// What the user allows: enforced by the engine from now on.
#[tauri::command(async)]
pub fn mcp_configure(state: State<'_, McpState>, config: crate::mcp::Config) {
    state.engine.configure(config);
}

/// Turns AI control on: the bridge listens on 127.0.0.1 with a fresh token, written to a file only the
/// user can read.
#[tauri::command(async)]
pub fn mcp_start(
    app: AppHandle,
    state: State<'_, McpState>,
    config: crate::mcp::Config,
) -> AppResult<McpStatus> {
    state.engine.configure(config);
    state.engine.start();
    let mut host = state.host.lock();
    if host.is_none() {
        let file = app
            .path()
            .app_config_dir()
            .map_err(|e| AppError::new(ErrorCode::Unsupported, e.to_string()))?
            .join(sc_mcp::bridge::ENDPOINT_FILE);
        let bridge = std::sync::Arc::new(McpBridge {
            app: app.clone(),
            engine: state.engine.clone(),
        });
        *host = Some(
            sc_mcp::host::Host::start(bridge, &file)
                .map_err(|e| AppError::new(ErrorCode::Unsupported, e.to_string()))?,
        );
    }
    drop(host);
    Ok(mcp_status_of(&state))
}

/// Turns AI control off: the port closes, the file goes, every assistant is cut off, nothing waits.
#[tauri::command(async)]
pub fn mcp_stop(manager: State<'_, ConnectionManager>, state: State<'_, McpState>) -> McpStatus {
    // first the engine: a call that is on its way finds it off
    state.engine.stop(&manager);
    *state.host.lock() = None;
    state
        .engine
        .window
        .send(McpEvent::Status { connections: 0 });
    mcp_status_of(&state)
}

/// Cuts every assistant off; AI control stays on.
#[tauri::command(async)]
pub fn mcp_disconnect(state: State<'_, McpState>) {
    if let Some(host) = state.host.lock().as_ref() {
        host.disconnect();
    }
}

/// The window's answer to a request (`McpEvent::Request`).
#[tauri::command(async)]
pub fn mcp_reply(
    state: State<'_, McpState>,
    id: u64,
    result: Option<serde_json::Value>,
    error: Option<sc_mcp::bridge::BridgeError>,
) -> bool {
    let answer = match error {
        Some(e) => Err(e),
        None => Ok(result.unwrap_or(serde_json::Value::Null)),
    };
    state.engine.calls.complete(id, answer)
}

/// Connection test: starts the sidecar like an assistant does and asks the app through it.
#[tauri::command(async)]
pub fn mcp_test() -> sc_mcp::probe::Probe {
    let program = mcp_sidecar().unwrap_or_default();
    sc_mcp::probe::probe(&program, std::time::Duration::from_secs(5))
}

// ── Test data (prompt 049) ───────────────────────────────────────────────────────────────

/// What a foreign key column of the table points to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestdataReference {
    column: String,
    ref_schema: String,
    ref_table: String,
    ref_column: String,
}

/// A generator for every column of a table, proposed from its types, keys and names.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestdataSuggestion {
    columns: Vec<crate::testdata::ColumnSpec>,
    references: Vec<TestdataReference>,
}

#[tauri::command(async)]
pub fn testdata_suggest(
    manager: State<'_, ConnectionManager>,
    id: String,
    schema: String,
    table: String,
) -> AppResult<TestdataSuggestion> {
    manager.ask(&id, |s, kind, stop| {
        let info = meta::table(s, kind, &schema, &table, stop)?;
        // a database without foreign keys, or one that does not show them, still gets a proposal
        let foreign = crate::db::relations::relations(s, kind, &schema, &table, stop)
            .map(|r| r.outgoing)
            .unwrap_or_default();
        Ok(TestdataSuggestion {
            columns: crate::testdata::suggest(&info, &foreign),
            references: foreign
                .iter()
                .filter(|f| f.columns.len() == 1 && f.ref_columns.len() == 1)
                .map(|f| TestdataReference {
                    column: f.columns[0].clone(),
                    ref_schema: f.ref_schema.clone(),
                    ref_table: f.ref_table.clone(),
                    ref_column: f.ref_columns[0].clone(),
                })
                .collect(),
        })
    })
}

/// The values the foreign key columns of a spec draw from: read from the tables they point to, in a
/// fixed order (the same seed gives the same rows), at most `limit` each. The names come from the
/// catalog, not from the window.
pub fn testdata_keys(
    s: &mut dyn crate::db::Session,
    kind: crate::db::DbKind,
    spec: &crate::testdata::Spec,
    limit: usize,
    stop: crate::db::Stop,
) -> AppResult<std::collections::HashMap<String, Vec<String>>> {
    use crate::testdata::Gen;
    let mut keys = std::collections::HashMap::new();
    let wanted: Vec<&str> = spec
        .columns
        .iter()
        .filter(|c| matches!(c.how, Gen::ForeignKey { .. }))
        .map(|c| c.name.as_str())
        .collect();
    if wanted.is_empty() {
        return Ok(keys);
    }
    let foreign =
        crate::db::relations::relations(s, kind, &spec.schema, &spec.table, stop)?.outgoing;
    let q = |n: &str| meta::quote_always(n, kind);
    for name in wanted {
        let Some(key) = foreign
            .iter()
            .find(|f| f.columns.len() == 1 && f.ref_columns.len() == 1 && f.columns[0] == name)
        else {
            return Err(AppError::new(
                ErrorCode::InvalidQuery,
                "this column has no foreign key of one column to take values from",
            ));
        };
        let column = q(&key.ref_columns[0]);
        let table = if kind.is_sqlite() || key.ref_schema.is_empty() {
            q(&key.ref_table)
        } else {
            format!("{}.{}", q(&key.ref_schema), q(&key.ref_table))
        };
        // every value as text: that is what the loader binds
        let text = match kind {
            crate::db::DbKind::Postgres => format!("{column}::text"),
            crate::db::DbKind::Mysql => format!("CAST({column} AS CHAR)"),
            crate::db::DbKind::Sqlserver => format!("CAST({column} AS nvarchar(4000))"),
            crate::db::DbKind::Sqlite | crate::db::DbKind::Libsql | crate::db::DbKind::D1 => {
                format!("CAST({column} AS TEXT)")
            }
            crate::db::DbKind::Oracle => format!("TO_CHAR({column})"),
            crate::db::DbKind::Duckdb => format!("CAST({column} AS VARCHAR)"),
            crate::db::DbKind::Clickhouse => format!("toString({column})"),
            crate::db::DbKind::Trino => format!("CAST({column} AS varchar)"),
            crate::db::DbKind::Firebird => format!("CAST({column} AS VARCHAR(8191))"),
            crate::db::DbKind::Bigquery => format!("CAST({column} AS STRING)"),
            crate::db::DbKind::Snowflake => format!("TO_VARCHAR({column})"),
            crate::db::DbKind::Db2 => format!("VARCHAR({column})"),
        };
        let sql = if kind == crate::db::DbKind::Sqlserver {
            format!(
                "SELECT TOP {limit} {text} FROM {table} WHERE {column} IS NOT NULL ORDER BY {column}"
            )
        } else if kind == crate::db::DbKind::Oracle {
            format!(
                "SELECT {text} FROM {table} WHERE {column} IS NOT NULL ORDER BY {column} \
                 FETCH FIRST {limit} ROWS ONLY"
            )
        } else {
            format!(
                "SELECT {text} FROM {table} WHERE {column} IS NOT NULL ORDER BY {column} LIMIT {limit}"
            )
        };
        let rows = s.ask(&sql, &[], Some(std::time::Duration::from_secs(60)), stop)?;
        keys.insert(
            name.to_owned(),
            rows.into_iter()
                .filter_map(|r| r.into_iter().next().flatten())
                .collect(),
        );
    }
    Ok(keys)
}

/// The plan of the loader for a spec: one column of the generator per written column, every value as
/// it is.
pub fn testdata_load_plan(
    spec: &crate::testdata::Spec,
    written: &[usize],
    clear_first: bool,
    whole_transaction: bool,
) -> crate::db::load::LoadPlan {
    crate::db::load::LoadPlan {
        schema: (!spec.schema.is_empty()).then(|| spec.schema.clone()),
        table: spec.table.clone(),
        mappings: written
            .iter()
            .enumerate()
            .map(|(source, i)| {
                let c = &spec.columns[*i];
                crate::db::load::Mapping {
                    source: Some(source),
                    fixed: None,
                    target: crate::db::load::TargetColumn {
                        name: c.name.clone(),
                        kind: c.value_kind,
                        type_name: c.type_name.clone(),
                    },
                    trim: false,
                    decimal_comma: false,
                    date_order: None,
                }
            })
            .collect(),
        null_texts: Vec::new(),
        empty_is_null: false,
        clear_first,
        on_error: crate::db::load::OnError::default(),
        whole_transaction,
        exact: true,
    }
}

/// The first rows of a spec, as they would be written.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestdataPreview {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    /// The rows there would be.
    total: u64,
}

#[tauri::command(async)]
pub fn testdata_preview(
    manager: State<'_, ConnectionManager>,
    id: String,
    spec: crate::testdata::Spec,
    rows: u64,
) -> AppResult<TestdataPreview> {
    manager.ask(&id, |s, kind, stop| {
        let keys = testdata_keys(s, kind, &spec, crate::testdata::MAX_KEYS, stop)?;
        let mut generator = crate::testdata::Generator::new(spec, &keys)?;
        let columns = generator
            .written()
            .iter()
            .map(|i| generator.spec().columns[*i].name.clone())
            .collect();
        let mut out = Vec::new();
        while out.len() < rows.min(crate::testdata::MAX_PREVIEW) as usize {
            match generator.next_row() {
                Some(row) => out.push(row),
                None => break,
            }
        }
        Ok(TestdataPreview {
            columns,
            rows: out,
            total: generator.total(),
        })
    })
}

/// Only a connection without protection is filled with made-up rows.
fn testdata_allowed(manager: &ConnectionManager, id: &str) -> AppResult<()> {
    let protected = manager
        .list()
        .profiles
        .iter()
        .find(|p| p.id == id)
        .is_some_and(|p| p.protection != crate::db::guard::Protection::Free);
    if protected {
        return Err(AppError::new(
            ErrorCode::PermissionDenied,
            "test data is written only to a connection without protection",
        ));
    }
    Ok(())
}

/// The statements a run would send, for the guard: the form of the `INSERT` (and the emptying).
#[tauri::command(async)]
pub fn testdata_statements(
    manager: State<'_, ConnectionManager>,
    id: String,
    spec: crate::testdata::Spec,
    clear_first: bool,
) -> AppResult<Vec<String>> {
    let written: Vec<usize> = spec
        .columns
        .iter()
        .enumerate()
        .filter(|(_, c)| c.how != crate::testdata::Gen::Skip)
        .map(|(i, _)| i)
        .collect();
    import_sqls(
        manager.kind_of(&id)?,
        &testdata_load_plan(&spec, &written, clear_first, false),
    )
}

/// Fills a table with generated rows (prompt 049) as a job with progress that `cancel_job` stops:
/// the rows go through the loader of the import, in blocks, every value bound. Refused on a protected
/// connection; the statements pass the guard like those of an import.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn testdata_run(
    manager: State<'_, ConnectionManager>,
    jobs: State<'_, Jobs>,
    job_id: u64,
    id: String,
    spec: crate::testdata::Spec,
    clear_first: bool,
    whole_transaction: bool,
    confirmations: Option<Vec<Option<String>>>,
    allow_dangerous: bool,
    on_progress: Channel<u64>,
) -> AppResult<crate::db::load::Loaded> {
    use std::sync::atomic::Ordering;
    const SESSION: &str = "sc-testdata";
    testdata_allowed(&manager, &id)?;
    let kind = manager.kind_of(&id)?;
    let keys = manager.ask(&id, |s, kind, stop| {
        testdata_keys(s, kind, &spec, crate::testdata::MAX_KEYS, stop)
    })?;
    let mut generator = crate::testdata::Generator::new(spec, &keys)?;
    let plan = testdata_load_plan(
        generator.spec(),
        &generator.written(),
        clear_first,
        whole_transaction,
    );
    let tokens = confirmations.unwrap_or_default();
    for (i, sql) in import_sqls(kind, &plan)?.iter().enumerate() {
        let token = tokens.get(i).and_then(|t| t.as_deref());
        manager.admit(&id, sql, token, allow_dangerous)?;
    }
    let stop = jobs.start(job_id, None);
    let result = manager.ask_in(&id, SESSION, |session, kind, stopped| {
        crate::db::load::load(
            session,
            kind,
            &mut generator,
            &plan,
            None,
            None,
            &|n| {
                let _ = on_progress.send(n);
            },
            &|| stop.load(Ordering::Relaxed) || stopped(),
        )
    });
    jobs.end(job_id);
    manager.close_session(&id, SESSION);
    result
}

/// A value of a generated row as a literal of a script.
fn testdata_literal(
    value: Option<&str>,
    kind: crate::db::filter::ValueKind,
    dialect: crate::db::DbKind,
) -> String {
    use crate::db::filter::ValueKind;
    let Some(text) = value else {
        return "NULL".to_owned();
    };
    // digits, with one point between digits at most and a minus in front at most
    let digits = text.strip_prefix('-').unwrap_or(text);
    let mut parts = digits.splitn(2, '.');
    let all_digits = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
    let number = text.len() <= 40
        && parts.next().is_some_and(all_digits)
        && parts.next().is_none_or(all_digits);
    match kind {
        ValueKind::Number if number => text.to_owned(),
        ValueKind::Bool => match (dialect, text == "true") {
            (
                crate::db::DbKind::Sqlserver
                | crate::db::DbKind::Sqlite
                | crate::db::DbKind::Libsql
                | crate::db::DbKind::D1,
                yes,
            ) => if yes { "1" } else { "0" }.to_owned(),
            (_, true) => "TRUE".to_owned(),
            (_, false) => "FALSE".to_owned(),
        },
        _ => crate::extract::sql_text(text, dialect),
    }
}

fn csv_field(text: &str) -> String {
    if text.contains(['"', ',', '\n', '\r']) || text.starts_with(' ') || text.ends_with(' ') {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text.to_owned()
    }
}

/// Writes the rows of a spec into a file instead of the table: `csv` (with a first line of names; NULL
/// is an empty field) or `insert` (a script). A job like the others; a file of a run that was stopped
/// or failed is removed. Returns the rows written.
#[tauri::command(async)]
pub fn testdata_export(
    manager: State<'_, ConnectionManager>,
    jobs: State<'_, Jobs>,
    job_id: u64,
    id: String,
    spec: crate::testdata::Spec,
    path: String,
    format: String,
) -> AppResult<u64> {
    use std::io::Write;
    use std::sync::atomic::Ordering;
    let target = export_target(&path)?;
    let insert = match format.as_str() {
        "csv" => false,
        "insert" => true,
        _ => {
            return Err(AppError::new(
                ErrorCode::Unsupported,
                "the format is csv or insert",
            ));
        }
    };
    let kind = manager.kind_of(&id)?;
    let keys = manager.ask(&id, |s, kind, stop| {
        testdata_keys(s, kind, &spec, crate::testdata::MAX_KEYS, stop)
    })?;
    let mut generator = crate::testdata::Generator::new(spec, &keys)?;
    let written = generator.written();
    let columns: Vec<crate::testdata::ColumnSpec> = written
        .iter()
        .map(|i| generator.spec().columns[*i].clone())
        .collect();
    let q = |n: &str| meta::quote_always(n, kind);
    let table = {
        let spec = generator.spec();
        if kind.is_sqlite() || spec.schema.is_empty() {
            q(&spec.table)
        } else {
            format!("{}.{}", q(&spec.schema), q(&spec.table))
        }
    };
    let names: Vec<String> = columns.iter().map(|c| q(&c.name)).collect();
    let stop = jobs.start(job_id, None);
    let io = |e: std::io::Error| AppError::new(ErrorCode::Io, e.to_string());
    let created = std::cell::Cell::new(false);
    let mut run = || -> AppResult<u64> {
        let mut out = std::io::BufWriter::new(std::fs::File::create(&target).map_err(io)?);
        created.set(true);
        if !insert {
            let head: Vec<String> = columns.iter().map(|c| csv_field(&c.name)).collect();
            writeln!(out, "{}", head.join(",")).map_err(io)?;
        }
        let mut rows = 0u64;
        while let Some(row) = generator.next_row() {
            if rows.is_multiple_of(1_000) && stop.load(Ordering::Relaxed) {
                return Err(crate::db::cancelled());
            }
            if insert {
                let values: Vec<String> = row
                    .iter()
                    .zip(&columns)
                    .map(|(v, c)| testdata_literal(v.as_deref(), c.value_kind, kind))
                    .collect();
                writeln!(
                    out,
                    "INSERT INTO {table} ({}) VALUES ({});",
                    names.join(", "),
                    values.join(", ")
                )
                .map_err(io)?;
            } else {
                let fields: Vec<String> = row
                    .iter()
                    .map(|v| v.as_deref().map(csv_field).unwrap_or_default())
                    .collect();
                writeln!(out, "{}", fields.join(",")).map_err(io)?;
            }
            rows += 1;
        }
        out.flush().map_err(io)?;
        Ok(rows)
    };
    let result = run();
    jobs.end(job_id);
    match &result {
        Ok(_) => {
            jobs.written.lock().insert(target);
        }
        // half a file is no file – but a file that could not even be opened is not ours to remove
        Err(_) if created.get() => {
            let _ = std::fs::remove_file(&target);
        }
        Err(_) => {}
    }
    result
}

#[cfg(test)]
mod testdata_script_tests {
    use super::*;
    use crate::db::DbKind;
    use crate::db::filter::ValueKind;

    /// Review 049: only what is a number stands in a script as one.
    #[test]
    fn a_value_is_a_number_in_a_script_only_if_it_is_one() {
        let lit = |v: &str| testdata_literal(Some(v), ValueKind::Number, DbKind::Postgres);
        assert_eq!(lit("42"), "42");
        assert_eq!(lit("-1.50"), "-1.50");
        for text in [
            "-",
            ".",
            "1.2.3",
            "1.",
            ".5",
            "--1",
            "1); DROP TABLE x; --",
            "",
        ] {
            assert!(lit(text).starts_with('\''), "{text}: {}", lit(text));
        }
        assert_eq!(
            testdata_literal(None, ValueKind::Text, DbKind::Mysql),
            "NULL"
        );
        assert_eq!(
            testdata_literal(Some("true"), ValueKind::Bool, DbKind::Sqlserver),
            "1"
        );
        assert_eq!(
            testdata_literal(Some("o'k"), ValueKind::Text, DbKind::Postgres),
            "'o''k'"
        );
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("plain"), "plain");
    }
}
