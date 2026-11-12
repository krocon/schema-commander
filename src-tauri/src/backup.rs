//! Backing up and restoring a database with the tools of the database (prompt 044): `pg_dump`,
//! `pg_restore`, `psql`, `mysqldump`, `mysql` (or their MariaDB names).
//!
//! The rules:
//! - **No shell.** A program is started with a list of arguments; a value is always joined to its option
//!   (`--file=…`) or stands behind `--`, so a name that starts with `-` is never an option.
//! - **The password is never an argument** (the process list shows arguments) and never in what is
//!   reported: PostgreSQL gets it in the environment of the one process (`PGPASSWORD`), MySQL in a file
//!   only the user can read (`--defaults-extra-file`), which is removed when the process ended.
//! - **Nothing half stays.** A run that failed or was stopped removes the file or folder it wrote.
//! - Paths come from the dialogs of the window.
//!
//! Pure but for [`version`], [`run`] and what looks at the disk in [`find`] (through `exists`).

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::db::secrets::Secret;
use crate::db::{DbKind, TlsMode};
use crate::error::{AppError, AppResult, ErrorCode};

/// A program of a database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Tool {
    PgDump,
    PgRestore,
    Psql,
    MysqlDump,
    Mysql,
}

impl Tool {
    /// The names the program goes by (MariaDB ships its own).
    pub fn names(self) -> &'static [&'static str] {
        match self {
            Tool::PgDump => &["pg_dump"],
            Tool::PgRestore => &["pg_restore"],
            Tool::Psql => &["psql"],
            Tool::MysqlDump => &["mysqldump", "mariadb-dump"],
            Tool::Mysql => &["mysql", "mariadb"],
        }
    }
}

/// The tools a kind of database is backed up and restored with; none: there are none we start.
pub fn tools_of(kind: DbKind) -> &'static [Tool] {
    match kind {
        DbKind::Postgres => &[Tool::PgDump, Tool::PgRestore, Tool::Psql],
        DbKind::Mysql => &[Tool::MysqlDump, Tool::Mysql],
        DbKind::Sqlserver
        | DbKind::Sqlite
        | DbKind::Libsql
        | DbKind::D1
        | DbKind::Oracle
        | DbKind::Duckdb
        | DbKind::Clickhouse
        | DbKind::Trino
        | DbKind::Firebird
        | DbKind::Bigquery => &[],
    }
}

/// Folders where the tools usually are, beyond the `PATH` (which a desktop app often gets short).
fn usual_folders(home: Option<&Path>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        for f in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/homebrew/opt/libpq/bin",
            "/usr/local/opt/libpq/bin",
            "/opt/homebrew/opt/mysql-client/bin",
            "/usr/local/opt/mysql-client/bin",
            "/opt/homebrew/opt/mariadb/bin",
            "/Applications/Postgres.app/Contents/Versions/latest/bin",
            "/usr/local/mysql/bin",
            "/opt/local/bin",
        ] {
            out.push(f.into());
        }
    } else if cfg!(windows) {
        for base in ["C:\\Program Files", "C:\\Program Files (x86)"] {
            for v in (10..=19).rev() {
                out.push(format!("{base}\\PostgreSQL\\{v}\\bin").into());
            }
            for v in ["9.0", "8.4", "8.0", "5.7"] {
                out.push(format!("{base}\\MySQL\\MySQL Server {v}\\bin").into());
            }
            for v in ["11.4", "11.2", "10.11", "10.6"] {
                out.push(format!("{base}\\MariaDB {v}\\bin").into());
            }
        }
    } else {
        for f in [
            "/usr/bin",
            "/usr/local/bin",
            "/usr/local/pgsql/bin",
            "/snap/bin",
        ] {
            out.push(f.into());
        }
        for v in (10..=19).rev() {
            out.push(format!("/usr/lib/postgresql/{v}/bin").into());
        }
    }
    if let Some(home) = home {
        out.push(home.join(".local/bin"));
    }
    out
}

fn not_found(tool: Tool) -> AppError {
    AppError::new(
        ErrorCode::ProgramNotFound,
        format!("{} was not found", tool.names()[0]),
    )
}

/// Where a tool is: the path that was set (it must be that program), else the folders of `PATH`, else
/// the usual folders. `exists` says whether a path is a file that can be started.
pub fn find(
    tool: Tool,
    configured: Option<&str>,
    path_var: Option<&std::ffi::OsStr>,
    home: Option<&Path>,
    exists: &dyn Fn(&Path) -> bool,
) -> AppResult<PathBuf> {
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    if let Some(set) = configured.map(str::trim).filter(|s| !s.is_empty()) {
        let path = PathBuf::from(set);
        // a full path to that very program – not a way to start anything else
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        // a program: no extension, or `.exe` – never a script a shell would run
        let extension = path
            .extension()
            .and_then(|s| s.to_str())
            .map(str::to_ascii_lowercase);
        let program = matches!(extension.as_deref(), None | Some("exe"));
        if !path.is_absolute()
            || !program
            || !tool.names().contains(&stem.as_str())
            || !exists(&path)
        {
            return Err(not_found(tool));
        }
        return Ok(path);
    }
    let mut folders: Vec<PathBuf> = path_var
        .map(|p| std::env::split_paths(p).collect())
        .unwrap_or_default();
    folders.extend(usual_folders(home));
    for folder in folders {
        // a relative entry of the PATH means „here“ – never searched
        if !folder.is_absolute() {
            continue;
        }
        for name in tool.names() {
            let path = folder.join(format!("{name}{suffix}"));
            if exists(&path) {
                return Ok(path);
            }
        }
    }
    Err(not_found(tool))
}

/// The first number of a text: `pg_dump (PostgreSQL) 18.1` → 18, `mysqldump  Ver 8.0.36` → 8,
/// `mariadb-dump from 11.4.2-MariaDB` → 11, `PostgreSQL 16.3 on …` → 16.
pub fn major_version(text: &str) -> Option<u32> {
    let start = text.find(|c: char| c.is_ascii_digit())?;
    let digits: String = text[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

/// What `--version` of a tool says (its first line); the program runs for a moment, without a shell.
pub fn version(program: &Path) -> AppResult<String> {
    let out = Command::new(program)
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))?;
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .chars()
        .take(200)
        .collect())
}

/// How the file of a backup is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DumpFormat {
    /// Statements as text.
    #[default]
    Sql,
    /// The archive of `pg_dump` (`--format=custom`): compressed, restored with `pg_restore`.
    Custom,
    /// A folder (`--format=directory`).
    Directory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Content {
    #[default]
    All,
    Structure,
    Data,
}

/// A table by its schema and name.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableName {
    #[serde(default)]
    pub schema: String,
    pub table: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpSpec {
    #[serde(default)]
    pub format: DumpFormat,
    /// Compress a text backup (`.sql.gz`).
    #[serde(default)]
    pub gzip: bool,
    #[serde(default)]
    pub content: Content,
    /// Leave out owners and rights.
    #[serde(default)]
    pub no_owner: bool,
    /// `INSERT` statements instead of `COPY` (PostgreSQL), one row each (MySQL).
    #[serde(default)]
    pub inserts: bool,
    /// Only these schemas (PostgreSQL); none = the whole database.
    #[serde(default)]
    pub schemas: Vec<String>,
    /// Only these tables.
    #[serde(default)]
    pub tables: Vec<TableName>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSpec {
    /// Drop what the backup holds before it is created anew (`pg_restore --clean --if-exists`).
    #[serde(default)]
    pub clean: bool,
    /// Everything or nothing.
    #[serde(default)]
    pub single_transaction: bool,
    /// Stop at the first error instead of going on.
    #[serde(default)]
    pub stop_on_error: bool,
    #[serde(default)]
    pub no_owner: bool,
}

/// Where the tool connects to. With an SSH tunnel: its local end.
#[derive(Debug, Clone)]
pub struct Endpoint {
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    pub password: Option<Secret>,
    pub tls: TlsMode,
    /// Files of the profile for TLS (PEM): its own authority, a client certificate and its key; empty =
    /// none.
    pub ca_file: String,
    pub client_cert: String,
    pub client_key: String,
    /// The MySQL tool on this machine is MariaDB's (its options for TLS are others).
    pub maria_client: bool,
}

/// A program to start: its arguments, and what it gets beside them.
#[derive(Debug, Clone)]
pub struct Invocation {
    pub tool: Tool,
    pub args: Vec<String>,
    /// Environment of the process – the password of PostgreSQL goes here.
    pub env: Vec<(&'static str, Secret)>,
    /// MySQL: the text of a file only the user can read, given as `--defaults-extra-file` (the first
    /// argument, added when the process starts).
    pub defaults: Option<Secret>,
    /// The output of the program is written to this file by us (compressed if `gzip`).
    pub stdout_to: Option<PathBuf>,
    /// This file is fed to the program (decompressed if it is gzip).
    pub stdin_from: Option<PathBuf>,
    pub gzip: bool,
    /// What the run creates: removed when it fails or is stopped. Never something that was there before
    /// the run: a backup is written beside its target (see `replaces`).
    pub creates: Option<PathBuf>,
    /// After a run that worked, `creates` takes the place of this path – the target the user chose. So a
    /// backup that was there before is replaced only by one that is whole.
    pub replaces: Option<PathBuf>,
}

/// Where a backup is written while it is not whole: beside its target, under a name of ours.
pub fn part_of(target: &Path) -> PathBuf {
    let mut name = target.file_name().unwrap_or_default().to_os_string();
    name.push(".sc-part");
    target.with_file_name(name)
}

/// Puts a finished backup in the place of its target: a file there is replaced, an empty folder too.
pub fn put_in_place(part: &Path, target: &Path) -> std::io::Result<()> {
    if target.is_dir() {
        // only an empty one (checked before the run; `remove_dir` takes nothing else)
        std::fs::remove_dir(target)?;
    } else if target.exists() && cfg!(windows) {
        std::fs::remove_file(target)?;
    }
    std::fs::rename(part, target)
}

fn invalid(message: &str) -> AppError {
    AppError::new(ErrorCode::Unsupported, message)
}

/// A value of an argument: one line, no NUL (an argument cannot hold one).
fn plain(value: &str, what: &str) -> AppResult<()> {
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(invalid(&format!(
            "{what} is empty or holds a control character"
        )));
    }
    Ok(())
}

/// A name as a pattern of `pg_dump` that matches exactly it: in double quotes, quotes doubled.
fn pg_exact(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn pg_ssl(tls: TlsMode) -> &'static str {
    match tls {
        TlsMode::Off => "disable",
        TlsMode::Prefer => "prefer",
        TlsMode::Require => "require",
        TlsMode::VerifyCa => "verify-ca",
        TlsMode::Verify => "verify-full",
    }
}

/// Variables of the environment of a process.
type Env = Vec<(&'static str, Secret)>;

fn pg_connection(e: &Endpoint) -> AppResult<(Vec<String>, Env)> {
    plain(&e.host, "the host")?;
    plain(&e.user, "the user")?;
    plain(&e.database, "the database")?;
    // `--dbname` also takes a connection string: a name must not be one
    let lower = e.database.to_ascii_lowercase();
    if e.database.contains('=')
        || lower.starts_with("postgresql://")
        || lower.starts_with("postgres://")
    {
        return Err(invalid(
            "the name of the database reads like a connection string",
        ));
    }
    let args = vec![
        format!("--host={}", e.host),
        format!("--port={}", if e.port == 0 { 5432 } else { e.port }),
        format!("--username={}", e.user),
        format!("--dbname={}", e.database),
        // never ask on a terminal that is not there
        "--no-password".to_owned(),
    ];
    let mut env = vec![("PGSSLMODE", Secret::new(pg_ssl(e.tls)))];
    for (name, file) in [
        ("PGSSLROOTCERT", &e.ca_file),
        ("PGSSLCERT", &e.client_cert),
        ("PGSSLKEY", &e.client_key),
    ] {
        if !file.trim().is_empty() {
            plain(file, "a certificate file")?;
            env.push((name, Secret::new(file.trim())));
        }
    }
    if let Some(password) = &e.password {
        env.push(("PGPASSWORD", password.clone()));
    }
    Ok((args, env))
}

/// The option file of MySQL with the password: its value in double quotes, `\` and `"` escaped.
fn mysql_defaults(e: &Endpoint) -> AppResult<Option<Secret>> {
    let Some(password) = e.password.as_ref() else {
        return Ok(None);
    };
    // a line break would start another option of the file
    if password.expose().chars().any(char::is_control) {
        return Err(invalid(
            "the password holds a control character: it cannot be given to the tool safely",
        ));
    }
    let escaped = password.expose().replace('\\', "\\\\").replace('"', "\\\"");
    Ok(Some(Secret::new(format!(
        "[client]\npassword=\"{escaped}\"\n"
    ))))
}

fn mysql_connection(e: &Endpoint) -> AppResult<Vec<String>> {
    plain(&e.host, "the host")?;
    plain(&e.user, "the user")?;
    let mut args = vec![
        format!("--host={}", e.host),
        format!("--port={}", if e.port == 0 { 3306 } else { e.port }),
        format!("--user={}", e.user),
        // a tunnel ends on this machine: TCP, not the socket `localhost` would mean
        "--protocol=TCP".to_owned(),
    ];
    // as safe as the connection of the app: the two families of tools say it differently
    let tls: &[&str] = match (e.maria_client, e.tls) {
        (false, TlsMode::Off) => &["--ssl-mode=DISABLED"],
        (false, TlsMode::Prefer) => &["--ssl-mode=PREFERRED"],
        (false, TlsMode::Require) => &["--ssl-mode=REQUIRED"],
        (false, TlsMode::VerifyCa) => &["--ssl-mode=VERIFY_CA"],
        (false, TlsMode::Verify) => &["--ssl-mode=VERIFY_IDENTITY"],
        (true, TlsMode::Off) => &["--skip-ssl"],
        (true, TlsMode::Prefer) => &[],
        (true, TlsMode::Require) => &["--ssl"],
        (true, TlsMode::VerifyCa | TlsMode::Verify) => &["--ssl", "--ssl-verify-server-cert"],
    };
    args.extend(tls.iter().map(|a| (*a).to_owned()));
    for (option, file) in [
        ("--ssl-ca", &e.ca_file),
        ("--ssl-cert", &e.client_cert),
        ("--ssl-key", &e.client_key),
    ] {
        if !file.trim().is_empty() {
            plain(file, "a certificate file")?;
            args.push(format!("{option}={}", file.trim()));
        }
    }
    Ok(args)
}

/// The program and arguments that write a backup of the database of `e` to `target`.
pub fn dump(e: &Endpoint, spec: &DumpSpec, target: &Path) -> AppResult<Invocation> {
    plain(
        target
            .to_str()
            .ok_or_else(|| invalid("the target is no path this program can be told"))?,
        "the target",
    )?;
    // written beside the target; in its place only when it is whole
    let part = part_of(target);
    let chosen = target;
    let target = part.as_path();
    let target_text = target.to_str().unwrap_or_default();
    match e.kind {
        DbKind::Postgres => {
            let (mut args, env) = pg_connection(e)?;
            let own_file = spec.format != DumpFormat::Sql;
            args.push(format!(
                "--format={}",
                match spec.format {
                    DumpFormat::Sql => "plain",
                    DumpFormat::Custom => "custom",
                    DumpFormat::Directory => "directory",
                }
            ));
            if own_file {
                args.push(format!("--file={target_text}"));
            }
            match spec.content {
                Content::All => {}
                Content::Structure => args.push("--schema-only".to_owned()),
                Content::Data => args.push("--data-only".to_owned()),
            }
            if spec.no_owner {
                args.push("--no-owner".to_owned());
                args.push("--no-privileges".to_owned());
            }
            if spec.inserts {
                args.push("--inserts".to_owned());
            }
            for schema in &spec.schemas {
                plain(schema, "a schema")?;
                args.push(format!("--schema={}", pg_exact(schema)));
            }
            for t in &spec.tables {
                plain(&t.table, "a table")?;
                let name = if t.schema.is_empty() {
                    pg_exact(&t.table)
                } else {
                    plain(&t.schema, "a schema")?;
                    format!("{}.{}", pg_exact(&t.schema), pg_exact(&t.table))
                };
                args.push(format!("--table={name}"));
            }
            Ok(Invocation {
                tool: Tool::PgDump,
                args,
                env,
                defaults: None,
                stdout_to: (!own_file).then(|| target.to_path_buf()),
                stdin_from: None,
                gzip: spec.gzip && !own_file,
                creates: Some(target.to_path_buf()),
                replaces: Some(chosen.to_path_buf()),
            })
        }
        DbKind::Mysql => {
            if spec.format != DumpFormat::Sql {
                return Err(invalid("mysqldump writes statements as text, nothing else"));
            }
            if !spec.schemas.is_empty() {
                return Err(invalid(
                    "a backup of MySQL is of one database, or of tables of it",
                ));
            }
            plain(&e.database, "the database")?;
            let mut args = mysql_connection(e)?;
            args.extend(
                [
                    "--single-transaction",
                    "--routines",
                    "--triggers",
                    "--default-character-set=utf8mb4",
                ]
                .map(str::to_owned),
            );
            match spec.content {
                Content::All => {}
                Content::Structure => args.push("--no-data".to_owned()),
                Content::Data => args.push("--no-create-info".to_owned()),
            }
            if spec.inserts {
                args.push("--skip-extended-insert".to_owned());
            }
            // what follows are names, whatever they start with
            args.push("--".to_owned());
            args.push(e.database.clone());
            for t in &spec.tables {
                plain(&t.table, "a table")?;
                if !t.schema.is_empty() && t.schema != e.database {
                    return Err(invalid(
                        "a table of another database cannot go into this backup",
                    ));
                }
                args.push(t.table.clone());
            }
            Ok(Invocation {
                tool: Tool::MysqlDump,
                args,
                env: Vec::new(),
                defaults: mysql_defaults(e)?,
                stdout_to: Some(target.to_path_buf()),
                stdin_from: None,
                gzip: spec.gzip,
                creates: Some(target.to_path_buf()),
                replaces: Some(chosen.to_path_buf()),
            })
        }
        DbKind::Sqlserver
        | DbKind::Sqlite
        | DbKind::Libsql
        | DbKind::D1
        | DbKind::Oracle
        | DbKind::Duckdb
        | DbKind::Clickhouse
        | DbKind::Trino
        | DbKind::Firebird
        | DbKind::Bigquery => Err(invalid(
            "this database is not backed up with a tool: use the simple export",
        )),
    }
}

/// What a file to restore is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    /// Statements as text.
    Sql,
    /// Statements as text, compressed.
    SqlGzip,
    /// The archive of `pg_dump`.
    PgCustom,
    /// A folder of `pg_dump`.
    PgDirectory,
}

/// What a backup is, read from its first bytes (and, for a folder, its table of contents).
pub fn file_kind(path: &Path) -> AppResult<FileKind> {
    let io = |e: std::io::Error| AppError::new(ErrorCode::Io, e.to_string());
    if path.is_dir() {
        return if path.join("toc.dat").is_file() {
            Ok(FileKind::PgDirectory)
        } else {
            Err(invalid("the folder is no backup of pg_dump (no toc.dat)"))
        };
    }
    let mut head = [0u8; 5];
    let mut file = std::fs::File::open(path).map_err(io)?;
    let n = file.read(&mut head).map_err(io)?;
    Ok(match &head[..n] {
        [b'P', b'G', b'D', b'M', b'P'] => FileKind::PgCustom,
        [0x1f, 0x8b, ..] => FileKind::SqlGzip,
        _ => FileKind::Sql,
    })
}

/// The program and arguments that play a backup into the database of `e`.
pub fn restore(
    e: &Endpoint,
    spec: &RestoreSpec,
    kind: FileKind,
    source: &Path,
) -> AppResult<Invocation> {
    let source_text = source
        .to_str()
        .ok_or_else(|| invalid("the file is no path this program can be told"))?;
    plain(source_text, "the file")?;
    let text = matches!(kind, FileKind::Sql | FileKind::SqlGzip);
    match (e.kind, text) {
        (DbKind::Postgres, true) => {
            let (mut args, env) = pg_connection(e)?;
            args.push("--no-psqlrc".to_owned());
            args.push("--quiet".to_owned());
            if spec.stop_on_error {
                args.push("--set=ON_ERROR_STOP=1".to_owned());
            }
            if spec.single_transaction {
                args.push("--single-transaction".to_owned());
            }
            Ok(Invocation {
                tool: Tool::Psql,
                args,
                env,
                defaults: None,
                stdout_to: None,
                stdin_from: Some(source.to_path_buf()),
                gzip: kind == FileKind::SqlGzip,
                creates: None,
                replaces: None,
            })
        }
        (DbKind::Postgres, false) => {
            let (mut args, env) = pg_connection(e)?;
            if spec.clean {
                args.push("--clean".to_owned());
                args.push("--if-exists".to_owned());
            }
            if spec.single_transaction {
                args.push("--single-transaction".to_owned());
            }
            if spec.stop_on_error {
                args.push("--exit-on-error".to_owned());
            }
            if spec.no_owner {
                args.push("--no-owner".to_owned());
                args.push("--no-privileges".to_owned());
            }
            // the file is the one argument that is no option: behind `--`
            args.push("--".to_owned());
            args.push(source_text.to_owned());
            Ok(Invocation {
                tool: Tool::PgRestore,
                args,
                env,
                defaults: None,
                stdout_to: None,
                stdin_from: None,
                gzip: false,
                creates: None,
                replaces: None,
            })
        }
        (DbKind::Mysql, true) => {
            plain(&e.database, "the database")?;
            let mut args = mysql_connection(e)?;
            args.push("--default-character-set=utf8mb4".to_owned());
            if !spec.stop_on_error {
                args.push("--force".to_owned());
            }
            args.push(format!("--database={}", e.database));
            Ok(Invocation {
                tool: Tool::Mysql,
                args,
                env: Vec::new(),
                defaults: mysql_defaults(e)?,
                stdout_to: None,
                stdin_from: Some(source.to_path_buf()),
                gzip: kind == FileKind::SqlGzip,
                creates: None,
                replaces: None,
            })
        }
        (DbKind::Mysql, false) => Err(invalid("this file is a backup of PostgreSQL")),
        _ => Err(invalid(
            "this database is not restored with a tool: run the statements of the file in a tab",
        )),
    }
}

/// How a run ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Done {
    /// Bytes written to the target (a backup we wrote) or read from the source (a restore we fed).
    pub bytes: u64,
    /// The program ended with a status that is not 0 – but said only warnings (`pg_restore` without
    /// „stop at the first error“ goes on and counts what it ignored).
    pub warnings: bool,
}

/// Removes what a failed run left: a file, or a folder with what is in it.
fn remove(path: &Path) {
    if path.is_dir() {
        let _ = std::fs::remove_dir_all(path);
    } else {
        let _ = std::fs::remove_file(path);
    }
}

/// The file with the password of MySQL: there while the process runs, gone when this is dropped.
struct PrivateFile(PathBuf);

impl PrivateFile {
    fn write(folder: &Path, text: &Secret) -> AppResult<Self> {
        let io = |e: std::io::Error| AppError::new(ErrorCode::Io, e.to_string());
        let unique = format!(
            "sc-{}-{:x}.cnf",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        );
        let path = folder.join(unique);
        let guard = PrivateFile(path.clone());
        // created for the user alone, then written: never readable by others, not for a moment
        let mut file = std::fs::OpenOptions::new();
        file.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            file.mode(0o600);
        }
        let mut file = file.open(&path).map_err(io)?;
        file.write_all(text.expose().as_bytes()).map_err(io)?;
        Ok(guard)
    }
}

impl Drop for PrivateFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// A line of what the program said, without what must not be shown: the password, should a program
/// ever repeat it.
fn scrub(line: &str, secrets: &[String]) -> String {
    let mut out = line.to_owned();
    for secret in secrets.iter().filter(|s| s.len() >= 3) {
        out = out.replace(secret.as_str(), "***");
    }
    out.chars().filter(|c| !c.is_control()).take(2000).collect()
}

/// Calls `f` with every line a program writes: bytes that are no UTF-8 are replaced, not the end of the
/// listening; a line without an end is cut into pieces.
fn each_line(reader: impl Read, f: &dyn Fn(&str)) {
    const MAX_LINE: usize = 64 * 1024;
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        line.clear();
        let mut limited = (&mut reader).take(MAX_LINE as u64);
        match limited.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => f(String::from_utf8_lossy(&line).trim_end_matches(['\n', '\r'])),
        }
    }
}

/// Starts the program and waits for it. `said` hears every line it writes to its error output (and,
/// when its output is not a backup, to its output); `stop` is asked ten times a second – `true` ends the
/// process. A run that fails or is stopped removes what it created. `private`: a folder for the file
/// with the password of MySQL.
pub fn run(
    program: &Path,
    invocation: &Invocation,
    private: &Path,
    said: &(dyn Fn(String) + Sync),
    stop: &(dyn Fn() -> bool + Sync),
) -> AppResult<Done> {
    let io = |e: std::io::Error| AppError::new(ErrorCode::Io, e.to_string());
    let secrets: Vec<String> = invocation
        .env
        .iter()
        .filter(|(name, _)| *name == "PGPASSWORD")
        .map(|(_, v)| v.expose().to_owned())
        .collect();
    let defaults = match &invocation.defaults {
        Some(text) => Some(PrivateFile::write(private, text)?),
        None => None,
    };
    let mut command = Command::new(program);
    if let Some(file) = &defaults {
        // must be the first argument
        let mut arg = std::ffi::OsString::from("--defaults-extra-file=");
        arg.push(&file.0);
        command.arg(arg);
    }
    command.args(&invocation.args);
    for (name, value) in &invocation.env {
        command.env(name, value.expose());
    }
    command
        .stdin(if invocation.stdin_from.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        // its own group: a signal for it reaches the processes it starts, and none of ours
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // no console window
        command.creation_flags(0x0800_0000);
    }
    if let Some(chosen) = &invocation.replaces {
        // a folder that holds something is never replaced by a backup
        if chosen.is_dir()
            && std::fs::read_dir(chosen)
                .map(|mut d| d.next().is_some())
                .unwrap_or(true)
        {
            return Err(invalid(
                "the folder chosen for the backup is not empty: choose a new or an empty one",
            ));
        }
    }
    if let Some(part) = &invocation.creates {
        // a leftover of ours (the app was killed): nobody else names a file like this
        remove(part);
    }
    // the target of a backup we write ourselves is created before the program runs
    let target = match &invocation.stdout_to {
        Some(path) => Some(std::fs::File::create(path).map_err(io)?),
        None => None,
    };
    let source = match &invocation.stdin_from {
        Some(path) => Some(std::fs::File::open(path).map_err(io)?),
        None => None,
    };
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            if let Some(path) = &invocation.creates {
                remove(path);
            }
            return Err(if e.kind() == std::io::ErrorKind::NotFound {
                not_found(invocation.tool)
            } else {
                io(e)
            });
        }
    };
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let gzip = invocation.gzip;
    let bytes = std::sync::atomic::AtomicU64::new(0);
    let failed: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
    let last: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
    let hear = |line: &str| {
        let line = scrub(line, &secrets);
        if line.trim().is_empty() {
            return;
        }
        let mut last = last.lock().unwrap_or_else(|e| e.into_inner());
        if last.len() >= 5 {
            last.remove(0);
        }
        last.push(line.clone());
        drop(last);
        said(line);
    };
    let note = |e: std::io::Error| {
        // a pipe that broke because the program ended is its failure, told by its status
        if e.kind() != std::io::ErrorKind::BrokenPipe {
            failed
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get_or_insert(e.to_string());
        }
    };
    let status = std::thread::scope(|scope| {
        // what the program says
        if let Some(stderr) = stderr {
            scope.spawn(|| {
                each_line(stderr, &hear);
            });
        }
        // what the program writes: the backup (to the file), or remarks
        if let Some(mut stdout) = stdout {
            scope.spawn(|| match target {
                Some(file) => {
                    let mut plain = std::io::BufWriter::new(file);
                    let mut packed = gzip.then(|| {
                        flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default())
                    });
                    let mut buffer = vec![0u8; 256 * 1024];
                    loop {
                        match stdout.read(&mut buffer) {
                            Ok(0) => break,
                            Ok(n) => {
                                let wrote = match &mut packed {
                                    Some(gz) => gz.write_all(&buffer[..n]).and_then(|()| {
                                        // what is compressed so far goes to the file
                                        let ready = std::mem::take(gz.get_mut());
                                        plain.write_all(&ready)
                                    }),
                                    None => plain.write_all(&buffer[..n]),
                                };
                                if let Err(e) = wrote {
                                    note(e);
                                    break;
                                }
                                bytes.fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed);
                            }
                            Err(e) => {
                                note(e);
                                break;
                            }
                        }
                    }
                    let end = match packed {
                        Some(gz) => gz.finish().and_then(|rest| plain.write_all(&rest)),
                        None => Ok(()),
                    }
                    .and_then(|()| plain.flush());
                    if let Err(e) = end {
                        note(e);
                    }
                }
                None => each_line(stdout, &hear),
            });
        }
        // what the program reads: the backup to restore
        if let (Some(mut stdin), Some(file)) = (stdin, source) {
            let (note, bytes) = (&note, &bytes);
            scope.spawn(move || {
                let mut reader: Box<dyn Read> = if gzip {
                    Box::new(flate2::read::MultiGzDecoder::new(file))
                } else {
                    Box::new(file)
                };
                let mut buffer = vec![0u8; 256 * 1024];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(n) => {
                            if let Err(e) = stdin.write_all(&buffer[..n]) {
                                note(e);
                                break;
                            }
                            bytes.fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed);
                        }
                        Err(e) => {
                            note(e);
                            break;
                        }
                    }
                }
                // closing the pipe tells the program that this was all
                drop(stdin);
            });
        }
        loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok((status, false)),
                Ok(None) => {}
                Err(e) => break Err(io(e)),
            }
            if stop() {
                end(&mut child);
                break child.wait().map(|s| (s, true)).map_err(io);
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    });
    drop(defaults);
    let cleanup = || {
        if let Some(path) = &invocation.creates {
            remove(path);
        }
    };
    let (status, stopped) = match status {
        Ok(s) => s,
        Err(e) => {
            cleanup();
            return Err(e);
        }
    };
    if stopped {
        cleanup();
        return Err(crate::db::cancelled());
    }
    if let Some(problem) = failed.into_inner().unwrap_or_else(|e| e.into_inner()) {
        cleanup();
        return Err(AppError::new(ErrorCode::Io, problem));
    }
    let bytes = bytes.into_inner();
    if !status.success() {
        // pg_restore ends with 1 when it ignored errors and went on: the restore is there, with gaps
        if invocation.tool == Tool::PgRestore && status.code() == Some(1) {
            return Ok(Done {
                bytes,
                warnings: true,
            });
        }
        cleanup();
        let last = last.into_inner().unwrap_or_else(|e| e.into_inner());
        return Err(AppError::new(
            ErrorCode::InvalidQuery,
            if last.is_empty() {
                format!("{} ended with {status}", invocation.tool.names()[0])
            } else {
                last.join("\n")
            },
        ));
    }
    if let (Some(part), Some(chosen)) = (&invocation.creates, &invocation.replaces)
        && let Err(e) = put_in_place(part, chosen)
    {
        cleanup();
        return Err(io(e));
    }
    Ok(Done {
        bytes,
        warnings: false,
    })
}

/// Ends a process and what it started.
fn end(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // the whole group (the process leads its own, see `process_group(0)`): SIGTERM lets the tools
        // close their connection; whatever is still there after a moment is killed
        let group = format!("-{}", child.id());
        let _ = Command::new("/bin/kill")
            .args(["-TERM", "--", &group])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        for _ in 0..20 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = Command::new("/bin/kill")
            .args(["-KILL", "--", &group])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

/// The simple export (without the tools of the database): the tables of a schema as `CREATE` statements
/// – written by the migration of the schema comparison against an empty schema, so in an order that
/// holds – and, if `data`, their rows as `INSERT`s, in one file. `rows(sql, sink)` runs a statement that
/// reads. Answers with the size of the file; a run that fails or is stopped leaves no file.
pub fn simple_export(
    kind: DbKind,
    snapshot: &crate::db::compare::Snapshot,
    data: bool,
    target: &Path,
    rows: &mut dyn FnMut(&str, &mut dyn crate::db::value::RowSink) -> AppResult<()>,
    said: &dyn Fn(String),
    stop: &dyn Fn() -> bool,
) -> AppResult<u64> {
    use crate::db::compare;
    let io = |e: std::io::Error| AppError::new(ErrorCode::Io, e.to_string());
    let part = {
        let mut name = target.file_name().unwrap_or_default().to_os_string();
        name.push(".rows.part");
        target.with_file_name(name)
    };
    // written beside the target; in its place only when it is whole
    let whole = part_of(target);
    let mut work = || -> AppResult<u64> {
        let schema = &snapshot.schema;
        let nothing = compare::Snapshot {
            kind,
            schema: schema.clone(),
            tables: Vec::new(),
            views: Vec::new(),
            routines: Vec::new(),
            triggers: Vec::new(),
        };
        let structure = compare::script(snapshot, &nothing, None, &[])?;
        let mut file = std::io::BufWriter::new(std::fs::File::create(&whole).map_err(io)?);
        writeln!(
            file,
            "-- Simple export – structure and rows of the tables of one schema. Not in it: rights, sequences,\n-- identity and auto_increment, comments. For a full backup use the tools of the database.\n"
        )
        .map_err(io)?;
        file.write_all(structure.as_bytes()).map_err(io)?;
        if data {
            for table in &snapshot.tables {
                if stop() {
                    return Err(crate::db::cancelled());
                }
                let quoted = |n: &str| crate::db::meta::quote_always(n, kind);
                let name = if kind.is_sqlite() || schema.is_empty() {
                    quoted(&table.name)
                } else {
                    format!("{}.{}", quoted(schema), quoted(&table.name))
                };
                said(table.name.chars().filter(|c| !c.is_control()).collect());
                let spec = crate::export::Spec {
                    format: crate::export::FileFormat::Insert,
                    options: crate::extract::Options {
                        table: name.clone(),
                        dialect: kind,
                        batch: 200,
                        final_newline: true,
                        ..Default::default()
                    },
                    bom: false,
                    gzip: false,
                    columns: Vec::new(),
                };
                let quiet = |_: u64| {};
                let mut sink = crate::export::FileSink::new(&part, spec, &quiet);
                rows(&format!("SELECT * FROM {name}"), &mut sink)?;
                let wrote = sink.finish()?;
                if wrote.rows > 0 {
                    writeln!(file).map_err(io)?;
                    let mut written = std::fs::File::open(&part).map_err(io)?;
                    std::io::copy(&mut written, &mut file).map_err(io)?;
                }
                let _ = std::fs::remove_file(&part);
            }
        }
        file.flush().map_err(io)?;
        drop(file);
        if target.is_dir() {
            return Err(invalid("the target of the export is a folder"));
        }
        put_in_place(&whole, target).map_err(io)?;
        Ok(std::fs::metadata(target).map(|m| m.len()).unwrap_or(0))
    };
    let done = work();
    if done.is_err() {
        // nothing half stays – and what was there before the run is still there
        let _ = std::fs::remove_file(&whole);
        let _ = std::fs::remove_file(&part);
    }
    done
}

#[cfg(test)]
#[path = "backup_tests.rs"]
mod tests;
