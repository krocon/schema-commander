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
use crate::history::{self, History};
use crate::results::{Progress, ResultStore, StoreSink};
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
pub fn close_connection(manager: State<'_, ConnectionManager>, id: String) {
    manager.close(&id);
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
    let (result, tx) = manager.run_in(
        &id,
        session.as_deref(),
        &sql,
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

/// Stops a job (its statement on the server too).
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

/// The language of the native parts follows the window (prompt 017): on macOS the menu bar is built again
/// with the words of that language; elsewhere there is no native menu yet (prompt 018).
#[tauri::command(async)]
pub fn set_language(app: AppHandle, language: String) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        let menu = crate::menu::macos_menu(&app, &language)
            .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))?;
        app.set_menu(menu)
            .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, crate::menu::known_language(&language));
    }
    Ok(())
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
}
