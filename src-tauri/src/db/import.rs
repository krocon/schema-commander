//! Connections from elsewhere (prompt 015): a connection URL, and the files other tools keep theirs in.
//! Everything read here is foreign: sizes are bounded, nothing is executed, XML is scanned for a handful of
//! tags and never expanded. A password is only ever taken where it stands in clear text (`.pgpass`,
//! `.my.cnf`, a URL) – and then handed to the keychain, never to a profile. Pure of Tauri.

use super::secrets::Secret;
use super::{DbKind, Profile, TlsMode, guard::Protection};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::ssh::{SshAuth, SshTarget};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A file of another tool at most.
pub const MAX_IMPORT_BYTES: u64 = 8 * 1024 * 1024;
/// Connections taken from one source at most.
pub const MAX_CANDIDATES: usize = 500;

/// Where connections can come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    /// DBeaver `data-sources.json`.
    Dbeaver,
    /// DataGrip and the other JetBrains IDEs: `dataSources.xml` (users in `dataSources.local.xml`).
    Datagrip,
    /// `~/.pgpass`.
    Pgpass,
    /// `~/.pg_service.conf`.
    PgService,
    /// `~/.my.cnf`.
    MyCnf,
    /// `PG*` and `MYSQL_*` as the app was started with.
    Environment,
    /// A file of our own (`export`).
    Own,
}

/// A connection found in a source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub profile: Profile,
    /// A password that stood there in clear text.
    pub password: Option<Secret>,
    /// What is missing before it can be stored (`None` = nothing).
    pub problem: Option<String>,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidProfile, message.into())
}

fn blank(kind: DbKind) -> Profile {
    Profile {
        id: String::new(),
        name: String::new(),
        kind,
        host: String::new(),
        port: 0,
        database: String::new(),
        user: String::new(),
        tls: TlsMode::Off,
        folder: String::new(),
        color: 1,
        save_password: true,
        protection: Protection::Free,
        label: String::new(),
        ca_file: String::new(),
        client_cert: String::new(),
        client_key: String::new(),
        ssh: None,
    }
}

/// A name for a profile that has none: `database@host`.
fn suggested_name(p: &Profile) -> String {
    if p.kind.is_file() {
        return Path::new(&p.database)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "SQLite".into());
    }
    match (p.database.trim(), p.host.trim()) {
        ("", "") => "Verbindung".into(),
        ("", host) => host.to_string(),
        (db, "") => db.to_string(),
        (db, host) => format!("{db}@{host}"),
    }
}

/// Makes a candidate of a profile: a name if it has none, and what is missing.
fn candidate(mut profile: Profile, password: Option<Secret>) -> Candidate {
    // foreign text: no control characters, bounded
    for field in [
        &mut profile.name,
        &mut profile.host,
        &mut profile.database,
        &mut profile.user,
        &mut profile.folder,
    ] {
        *field = field
            .chars()
            .filter(|c| !c.is_control())
            .take(200)
            .collect();
    }
    if profile.name.trim().is_empty() {
        profile.name = suggested_name(&profile);
    }
    profile.name = profile.name.chars().take(100).collect();
    let problem = super::profiles::check(&profile).err().map(|e| e.message);
    Candidate {
        profile,
        password: password.filter(|s| !s.is_empty()),
        problem,
    }
}

// --- URLs --------------------------------------------------------------------------------------------

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(h), Some(l)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            )
        {
            out.push((h * 16 + l) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn port_of(text: &str) -> AppResult<u16> {
    text.trim()
        .parse::<u16>()
        .ok()
        .filter(|p| *p > 0)
        .ok_or_else(|| invalid(format!("„{}“ is no port", text.trim())))
}

/// `host`, `host:port`, `[v6]`, `[v6]:port`.
fn host_port(text: &str) -> AppResult<(String, u16)> {
    let text = text.trim();
    if let Some(rest) = text.strip_prefix('[') {
        let Some((host, after)) = rest.split_once(']') else {
            return Err(invalid("an IPv6 address needs its closing bracket"));
        };
        let port = match after.strip_prefix(':') {
            Some(p) => port_of(p)?,
            None if after.is_empty() => 0,
            None => return Err(invalid("unexpected text behind the IPv6 address")),
        };
        return Ok((format!("[{host}]"), port));
    }
    match text.rsplit_once(':') {
        // more than one colon without brackets: an IPv6 address without a port
        Some((host, _)) if host.contains(':') => Ok((format!("[{text}]"), 0)),
        Some((host, port)) => Ok((host.to_string(), port_of(port)?)),
        None => Ok((text.to_string(), 0)),
    }
}

fn pg_tls(mode: &str) -> Option<TlsMode> {
    Some(match mode.to_ascii_lowercase().as_str() {
        "disable" | "disabled" | "false" | "0" => TlsMode::Off,
        "allow" | "prefer" | "preferred" => TlsMode::Prefer,
        "require" | "required" | "true" | "1" => TlsMode::Require,
        "verify-ca" | "verify_ca" => TlsMode::VerifyCa,
        "verify-full" | "verify_identity" | "verify-identity" => TlsMode::Verify,
        _ => return None,
    })
}

/// `scheme://[user[:password]@]host[:port][/database][?options]`.
fn url_form(kind: DbKind, rest: &str) -> AppResult<(Profile, Option<Secret>)> {
    let mut p = blank(kind);
    let (main, query) = rest.split_once('?').unwrap_or((rest, ""));
    let (authority, path) = main.split_once('/').unwrap_or((main, ""));
    // the last @: a password may hold one
    let (credentials, place) = match authority.rsplit_once('@') {
        Some((c, h)) => (Some(c), h),
        None => (None, authority),
    };
    let mut password = None;
    if let Some(credentials) = credentials {
        let (user, pass) = match credentials.split_once(':') {
            Some((u, p)) => (u, Some(p)),
            None => (credentials, None),
        };
        p.user = percent_decode(user);
        password = pass.map(|p| Secret::new(percent_decode(p)));
    }
    let (host, port) = host_port(&percent_decode(place))?;
    p.host = host;
    p.port = port;
    p.database = percent_decode(path.trim_end_matches('/'));
    for pair in query.split('&').filter(|s| !s.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = percent_decode(value);
        match key.to_ascii_lowercase().as_str() {
            "sslmode" | "ssl-mode" | "ssl_mode" | "ssl" | "usessl" | "tls" => {
                if let Some(mode) = pg_tls(&value) {
                    p.tls = mode;
                }
            }
            "user" | "username" if p.user.is_empty() => p.user = value,
            "password" if password.is_none() => password = Some(Secret::new(value)),
            "sslrootcert" | "ssl-ca" | "sslca" => p.ca_file = value,
            "sslcert" | "ssl-cert" => p.client_cert = value,
            "sslkey" | "ssl-key" => p.client_key = value,
            _ => {}
        }
    }
    Ok((p, password))
}

/// `key=value;key=value` of ADO and of `jdbc:sqlserver://host:port;…`.
fn semicolon_form(text: &str) -> AppResult<(Profile, Option<Secret>)> {
    let mut p = blank(DbKind::Sqlserver);
    let mut password = None;
    let mut encrypt: Option<bool> = None;
    let mut trust = false;
    for (i, part) in text.split(';').enumerate() {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let Some((key, value)) = part.split_once('=') else {
            // jdbc:sqlserver://host:port;… – the first part is the place
            if i == 0 {
                let (host, port) = host_port(part.trim_start_matches("//"))?;
                p.host = host;
                p.port = port;
            }
            continue;
        };
        let value = value
            .trim()
            .trim_matches(|c| c == '{' || c == '}')
            .to_string();
        match key.trim().to_ascii_lowercase().replace(' ', "").as_str() {
            "server" | "datasource" | "addr" | "address" | "networkaddress" | "servername" => {
                // `tcp:host,1433`, `host\instance`
                let place = value.trim_start_matches("tcp:");
                let place = place.split('\\').next().unwrap_or(place);
                match place.split_once(',') {
                    Some((host, port)) => {
                        p.host = host.trim().to_string();
                        p.port = port_of(port)?;
                    }
                    None => {
                        let (host, port) = host_port(place)?;
                        p.host = host;
                        p.port = port;
                    }
                }
            }
            "port" | "portnumber" => p.port = port_of(&value)?,
            "database" | "initialcatalog" | "databasename" => p.database = value,
            "userid" | "uid" | "user" | "username" => p.user = value,
            "password" | "pwd" => password = Some(Secret::new(value)),
            "encrypt" => {
                encrypt = Some(matches!(
                    value.to_ascii_lowercase().as_str(),
                    "true" | "yes" | "mandatory" | "strict" | "1"
                ));
            }
            "trustservercertificate" => {
                trust = matches!(value.to_ascii_lowercase().as_str(), "true" | "yes" | "1");
            }
            _ => {}
        }
    }
    p.tls = match (encrypt, trust) {
        (Some(true), true) => TlsMode::Require,
        (Some(true), false) => TlsMode::Verify,
        _ => TlsMode::Off,
    };
    Ok((p, password))
}

/// `decode`: the text is a URL (percent escapes mean characters), not a plain path.
fn sqlite_path(path: &str, decode: bool) -> (Profile, Option<Secret>) {
    let mut p = blank(DbKind::Sqlite);
    // sqlite:///abs/path, sqlite://rel, sqlite:path, file:path?mode=…
    let path = path.split('?').next().unwrap_or(path);
    let path = match path.strip_prefix("//") {
        Some(rest) if rest.starts_with('/') => rest,
        Some(rest) => rest,
        None => path,
    };
    p.database = if decode {
        percent_decode(path)
    } else {
        path.to_string()
    };
    p.save_password = false;
    (p, None)
}

fn looks_like_a_database_file(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [".db", ".sqlite", ".sqlite3", ".db3"]
        .iter()
        .any(|ext| lower.ends_with(ext))
        && !text.contains('\n')
}

/// A connection from what the user pasted: a URL of one of the databases, a JDBC URL, an ADO connection
/// string, or the path of an SQLite file.
pub fn parse_url(text: &str) -> AppResult<Candidate> {
    let text = text.trim();
    if text.is_empty() || text.len() > 4096 || text.contains('\n') {
        return Err(invalid("this is no connection URL"));
    }
    let lower = text.to_ascii_lowercase();
    let lower = lower.strip_prefix("jdbc:").unwrap_or(&lower);
    let rest = &text[text.len() - lower.len()..];
    let after = |prefix: &str| &rest[prefix.len()..];
    let (profile, password) = if lower.starts_with("postgresql://") {
        url_form(DbKind::Postgres, after("postgresql://"))?
    } else if lower.starts_with("postgres://") {
        url_form(DbKind::Postgres, after("postgres://"))?
    } else if lower.starts_with("mysql://") {
        url_form(DbKind::Mysql, after("mysql://"))?
    } else if lower.starts_with("mariadb://") {
        url_form(DbKind::Mysql, after("mariadb://"))?
    } else if lower.starts_with("sqlserver://") || lower.starts_with("mssql://") {
        let body = &rest[rest.find("://").map_or(0, |i| i + 3)..];
        if body.contains(';') || !body.contains('@') && !body.contains('/') && body.contains('=') {
            semicolon_form(body)?
        } else {
            url_form(DbKind::Sqlserver, body)?
        }
    } else if lower.starts_with("oracle:thin:@//") {
        // jdbc:oracle:thin:@//host:1521/service – the user is not part of it
        url_form(DbKind::Oracle, after("oracle:thin:@//"))?
    } else if lower.starts_with("oracle://") {
        url_form(DbKind::Oracle, after("oracle://"))?
    } else if lower.starts_with("sqlite:") {
        sqlite_path(after("sqlite:"), true)
    } else if lower.starts_with("file:")
        && looks_like_a_database_file(rest.split('?').next().unwrap_or(rest))
    {
        sqlite_path(after("file:"), true)
    } else if (lower.contains("server=") || lower.contains("data source=")) && lower.contains('=') {
        semicolon_form(rest)?
    } else if looks_like_a_database_file(rest) {
        sqlite_path(rest, false)
    } else {
        return Err(invalid(
            "not a URL of PostgreSQL, MySQL, MariaDB, SQL Server or SQLite",
        ));
    };
    Ok(candidate(profile, password))
}

// --- files of other tools ------------------------------------------------------------------------------

fn read_bounded(path: &Path) -> AppResult<String> {
    let meta = std::fs::metadata(path).map_err(|e| {
        AppError::new(
            ErrorCode::NotFound,
            format!(
                "{}: {e}",
                path.file_name().unwrap_or_default().to_string_lossy()
            ),
        )
    })?;
    if !meta.is_file() || meta.len() > MAX_IMPORT_BYTES {
        return Err(AppError::new(
            ErrorCode::TooLarge,
            "not a file, or too big to be one of these",
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn dbeaver_kind(provider: &str, driver: &str) -> Option<DbKind> {
    let both = format!("{provider} {driver}").to_ascii_lowercase();
    if both.contains("postgres") {
        Some(DbKind::Postgres)
    } else if both.contains("mysql") || both.contains("mariadb") {
        Some(DbKind::Mysql)
    } else if both.contains("sqlserver") || both.contains("mssql") {
        Some(DbKind::Sqlserver)
    } else if both.contains("oracle") {
        Some(DbKind::Oracle)
    } else if both.contains("duckdb") {
        Some(DbKind::Duckdb)
    } else if both.contains("sqlite") {
        Some(DbKind::Sqlite)
    } else {
        None
    }
}

/// DBeaver: `connections` is a map of id → `{ provider, driver, name, folder, configuration: { host, port,
/// database, url, user?, handlers: { ssh_tunnel: { enabled, configuration: { host, port, user?, authType,
/// keyPath } } } } }`. Passwords are in another, encrypted file and are not looked at.
pub fn dbeaver(text: &str) -> AppResult<Vec<Candidate>> {
    let root: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| invalid(format!("not a DBeaver data-sources.json ({e})")))?;
    let Some(connections) = root.get("connections").and_then(|c| c.as_object()) else {
        return Err(invalid("not a DBeaver data-sources.json: no connections"));
    };
    let text_of = |v: &serde_json::Value, key: &str| -> String {
        match v.get(key) {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Number(n)) => n.to_string(),
            _ => String::new(),
        }
    };
    let mut out = Vec::new();
    for connection in connections.values().take(MAX_CANDIDATES) {
        let Some(kind) = dbeaver_kind(
            &text_of(connection, "provider"),
            &text_of(connection, "driver"),
        ) else {
            continue;
        };
        let empty = serde_json::Value::Null;
        let config = connection.get("configuration").unwrap_or(&empty);
        // the URL knows most; the single fields win where they are set
        let url = text_of(config, "url");
        let mut p = parse_url(&url)
            .map(|c| c.profile)
            .unwrap_or_else(|_| blank(kind));
        p.kind = kind;
        p.name = text_of(connection, "name");
        p.folder = text_of(connection, "folder");
        let host = text_of(config, "host");
        if !host.is_empty() {
            p.host = host;
        }
        if let Ok(port) = text_of(config, "port").parse::<u16>() {
            p.port = port;
        }
        let database = text_of(config, "database");
        if !database.is_empty() {
            p.database = database;
        }
        let user = text_of(config, "user");
        if !user.is_empty() {
            p.user = user;
        }
        if let Some(tunnel) = config.get("handlers").and_then(|h| h.get("ssh_tunnel"))
            && tunnel.get("enabled").and_then(serde_json::Value::as_bool) == Some(true)
        {
            let tc = tunnel.get("configuration").unwrap_or(&empty);
            let auth = match text_of(tc, "authType").to_ascii_uppercase().as_str() {
                "PUBLIC_KEY" => SshAuth::Key,
                "AGENT" => SshAuth::Agent,
                _ => SshAuth::Password,
            };
            p.ssh = Some(SshTarget {
                host: text_of(tc, "host"),
                port: text_of(tc, "port").parse().unwrap_or(0),
                user: {
                    let u = text_of(tc, "user");
                    if u.is_empty() {
                        text_of(tunnel, "user")
                    } else {
                        u
                    }
                },
                auth,
                key_file: text_of(tc, "keyPath"),
            });
        }
        out.push(candidate(p, None));
    }
    Ok(out)
}

/// The text between `<tag>` and `</tag>` from `from` on, with the five entities of XML resolved – and no
/// others: a file cannot define any here.
fn xml_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&format!("</{tag}>"))? + start;
    Some(xml_unescape(xml[start..end].trim()))
}

fn xml_unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn xml_attribute(element: &str, name: &str) -> Option<String> {
    let key = format!("{name}=\"");
    let start = element.find(&key)? + key.len();
    let end = element[start..].find('"')? + start;
    Some(xml_unescape(&element[start..end]))
}

/// The `<data-source …>…</data-source>` elements of a JetBrains file: (attributes, body).
fn data_sources(xml: &str) -> Vec<(&str, &str)> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(at) = rest.find("<data-source ") {
        let after = &rest[at..];
        let Some(head_end) = after.find('>') else {
            break;
        };
        let head = &after[..head_end];
        let body_start = head_end + 1;
        let Some(close) = after[body_start..].find("</data-source>") else {
            // a self-closing element has no body
            rest = &after[body_start..];
            continue;
        };
        out.push((head, &after[body_start..body_start + close]));
        rest = &after[body_start + close..];
        if out.len() >= MAX_CANDIDATES {
            break;
        }
    }
    out
}

/// DataGrip and the other JetBrains IDEs: `dataSources.xml` has `<data-source name uuid>` with
/// `<jdbc-url>`; the user is in `dataSources.local.xml` under the same uuid (`<user-name>`). Passwords are
/// in the keychain of the IDE and are not looked at. A document type declaration is refused outright.
pub fn datagrip(xml: &str, local: Option<&str>) -> AppResult<Vec<Candidate>> {
    for text in [Some(xml), local].into_iter().flatten() {
        let upper = text.to_ascii_uppercase();
        if upper.contains("<!DOCTYPE") || upper.contains("<!ENTITY") {
            return Err(invalid("this XML declares entities: refused"));
        }
    }
    let users: Vec<(String, String)> = local
        .map(|l| {
            data_sources(l)
                .into_iter()
                .filter_map(|(head, body)| {
                    Some((xml_attribute(head, "uuid")?, xml_text(body, "user-name")?))
                })
                .collect()
        })
        .unwrap_or_default();
    let sources = data_sources(xml);
    if sources.is_empty() && !xml.contains("DataSourceManagerImpl") {
        return Err(invalid("not a dataSources.xml of a JetBrains IDE"));
    }
    let mut out = Vec::new();
    for (head, body) in sources {
        let Some(url) = xml_text(body, "jdbc-url") else {
            continue;
        };
        let Ok(found) = parse_url(&url) else {
            continue;
        };
        let mut p = found.profile;
        p.name = xml_attribute(head, "name").unwrap_or_default();
        if let Some(uuid) = xml_attribute(head, "uuid")
            && let Some((_, user)) = users.iter().find(|(u, _)| *u == uuid)
            && p.user.is_empty()
        {
            p.user = user.clone();
        }
        // a password in a JDBC URL of a project file is not taken along
        out.push(candidate(p, None));
    }
    Ok(out)
}

/// The fields of a `.pgpass` line: `:` separates, `\:` and `\\` are the characters.
fn pgpass_fields(line: &str) -> Vec<String> {
    let mut fields = vec![String::new()];
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if let Some(next) = chars.next() {
                    fields.last_mut().expect("never empty").push(next);
                }
            }
            ':' => fields.push(String::new()),
            c => fields.last_mut().expect("never empty").push(c),
        }
    }
    fields
}

/// `~/.pgpass`: `host:port:database:user:password` per line; `*` matches anything and is left empty here.
pub fn pgpass(text: &str) -> Vec<Candidate> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .take(MAX_CANDIDATES)
        .filter_map(|line| {
            let f = pgpass_fields(line);
            if f.len() != 5 {
                return None;
            }
            let star = |s: &str| {
                if s == "*" {
                    String::new()
                } else {
                    s.to_string()
                }
            };
            let mut p = blank(DbKind::Postgres);
            p.host = star(&f[0]);
            p.port = f[1].parse().unwrap_or(0);
            p.database = star(&f[2]);
            p.user = star(&f[3]);
            Some(candidate(p, Some(Secret::new(f[4].clone()))))
        })
        .collect()
}

/// The sections of an INI file: (name, key → value). Keys are lower case; quotes around values go.
fn ini(text: &str) -> Vec<(String, Vec<(String, String)>)> {
    let mut out: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            out.push((name.trim().to_string(), Vec::new()));
        } else if let Some((key, value)) = line.split_once('=')
            && let Some(section) = out.last_mut()
        {
            let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
            section
                .1
                .push((key.trim().to_ascii_lowercase(), value.to_string()));
        }
    }
    out
}

/// `~/.pg_service.conf`: a section per service with `host`, `port`, `dbname`, `user`, `sslmode`,
/// `password`.
pub fn pg_service(text: &str) -> Vec<Candidate> {
    ini(text)
        .into_iter()
        .take(MAX_CANDIDATES)
        .map(|(name, pairs)| {
            let mut p = blank(DbKind::Postgres);
            p.name = name;
            let mut password = None;
            for (key, value) in pairs {
                match key.as_str() {
                    "host" | "hostaddr" => p.host = value,
                    "port" => p.port = value.parse().unwrap_or(0),
                    "dbname" => p.database = value,
                    "user" => p.user = value,
                    "password" => password = Some(Secret::new(value)),
                    "sslmode" => p.tls = pg_tls(&value).unwrap_or(TlsMode::Off),
                    "sslrootcert" => p.ca_file = value,
                    _ => {}
                }
            }
            if p.tls.unchecked_ca_conflict(&p.ca_file) {
                p.ca_file.clear();
            }
            candidate(p, password)
        })
        .collect()
}

/// `~/.my.cnf`: the sections `[client]`, `[mysql]` and `[client…]` with `host`, `port`, `user`,
/// `password`, `database`.
pub fn my_cnf(text: &str) -> Vec<Candidate> {
    ini(text)
        .into_iter()
        .filter(|(name, _)| name.starts_with("client") || name == "mysql")
        .take(MAX_CANDIDATES)
        .filter_map(|(name, pairs)| {
            let mut p = blank(DbKind::Mysql);
            let mut password = None;
            for (key, value) in pairs {
                match key.as_str() {
                    "host" => p.host = value,
                    "port" => p.port = value.parse().unwrap_or(0),
                    "user" => p.user = value,
                    "password" => password = Some(Secret::new(value)),
                    "database" => p.database = value,
                    _ => {}
                }
            }
            if p.host.is_empty() && p.user.is_empty() {
                return None;
            }
            if p.host.is_empty() {
                p.host = "localhost".into();
            }
            p.name = format!("{} ({name})", suggested_name(&p));
            Some(candidate(p, password))
        })
        .collect()
}

/// What `PG*` and `MYSQL_*` said when the app started (see [`capture_environment`]).
#[derive(Debug, Clone, Default)]
pub struct Environment {
    pub vars: Vec<(String, String)>,
}

impl Environment {
    fn get(&self, name: &str) -> String {
        self.vars
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    }
}

/// The variables an import from the environment looks at.
pub const ENVIRONMENT_VARS: &[&str] = &[
    "PGHOST",
    "PGPORT",
    "PGUSER",
    "PGPASSWORD",
    "PGDATABASE",
    "PGSSLMODE",
    "MYSQL_HOST",
    "MYSQL_TCP_PORT",
    "MYSQL_PWD",
    "MYSQL_USER",
    "MYSQL_DATABASE",
];

static CAPTURED: std::sync::OnceLock<Environment> = std::sync::OnceLock::new();

/// Remembers the variables an import can use. Called once at the very start of the program, before the
/// `PG*` variables are removed so that no driver reads them on its own (design 014).
pub fn capture_environment() {
    let vars = ENVIRONMENT_VARS
        .iter()
        .filter_map(|name| std::env::var(name).ok().map(|v| ((*name).to_string(), v)))
        .collect();
    let _ = CAPTURED.set(Environment { vars });
}

pub fn captured_environment() -> Environment {
    CAPTURED.get().cloned().unwrap_or_default()
}

/// The connections the environment describes: at most one for PostgreSQL and one for MySQL.
pub fn environment(env: &Environment) -> Vec<Candidate> {
    let mut out = Vec::new();
    if !env.get("PGHOST").is_empty() || !env.get("PGDATABASE").is_empty() {
        let mut p = blank(DbKind::Postgres);
        p.host = env.get("PGHOST");
        if p.host.is_empty() {
            p.host = "localhost".into();
        }
        p.port = env.get("PGPORT").parse().unwrap_or(0);
        p.user = env.get("PGUSER");
        p.database = env.get("PGDATABASE");
        p.tls = pg_tls(&env.get("PGSSLMODE")).unwrap_or(TlsMode::Off);
        let password = Some(env.get("PGPASSWORD"))
            .filter(|s| !s.is_empty())
            .map(Secret::new);
        out.push(candidate(p, password));
    }
    if !env.get("MYSQL_HOST").is_empty() {
        let mut p = blank(DbKind::Mysql);
        p.host = env.get("MYSQL_HOST");
        p.port = env.get("MYSQL_TCP_PORT").parse().unwrap_or(0);
        p.user = env.get("MYSQL_USER");
        p.database = env.get("MYSQL_DATABASE");
        let password = Some(env.get("MYSQL_PWD"))
            .filter(|s| !s.is_empty())
            .map(Secret::new);
        out.push(candidate(p, password));
    }
    out
}

/// Our own file for moving to another machine: the profiles, never a secret.
#[derive(Debug, Serialize, Deserialize)]
struct OwnFile {
    /// `schema-commander-connections`.
    format: String,
    version: u32,
    profiles: Vec<Profile>,
}

const OWN_FORMAT: &str = "schema-commander-connections";

pub fn export_own(profiles: &[Profile]) -> AppResult<String> {
    let file = OwnFile {
        format: OWN_FORMAT.into(),
        version: 1,
        profiles: profiles
            .iter()
            .cloned()
            .map(|mut p| {
                p.id.clear();
                p
            })
            .collect(),
    };
    serde_json::to_string_pretty(&file).map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))
}

pub fn own(text: &str) -> AppResult<Vec<Candidate>> {
    let file: OwnFile = serde_json::from_str(text)
        .map_err(|e| invalid(format!("not an export of Schema Commander ({e})")))?;
    if file.format != OWN_FORMAT || file.version != 1 {
        return Err(invalid(
            "not an export of Schema Commander, or of a newer version",
        ));
    }
    Ok(file
        .profiles
        .into_iter()
        .take(MAX_CANDIDATES)
        .map(|mut p| {
            p.id.clear();
            candidate(p, None)
        })
        .collect())
}

/// The file a source is usually in, below the home folder; `None` where the user must pick one.
pub fn default_path(source: Source, home: &Path) -> Option<PathBuf> {
    match source {
        Source::Pgpass => Some(home.join(".pgpass")),
        Source::PgService => Some(home.join(".pg_service.conf")),
        Source::MyCnf => Some(home.join(".my.cnf")),
        Source::Dbeaver => {
            let below = if cfg!(target_os = "macos") {
                "Library/DBeaverData"
            } else if cfg!(target_os = "windows") {
                "AppData/Roaming/DBeaverData"
            } else {
                ".local/share/DBeaverData"
            };
            Some(
                home.join(below)
                    .join("workspace6/General/.dbeaver/data-sources.json"),
            )
        }
        Source::Datagrip | Source::Own | Source::Environment => None,
    }
}

/// Reads the connections of a source. `path`: the file (from the open dialog, or the usual place);
/// ignored for the environment.
pub fn read(source: Source, path: Option<&Path>) -> AppResult<Vec<Candidate>> {
    if source == Source::Environment {
        return Ok(environment(&captured_environment()));
    }
    let path = path.ok_or_else(|| invalid("no file given"))?;
    let text = read_bounded(path)?;
    Ok(match source {
        Source::Dbeaver => dbeaver(&text)?,
        Source::Datagrip => {
            // the users are in the file next to it
            let local = path.with_file_name("dataSources.local.xml");
            let local = local.is_file().then(|| read_bounded(&local).ok()).flatten();
            datagrip(&text, local.as_deref())?
        }
        Source::Pgpass => pgpass(&text),
        Source::PgService => pg_service(&text),
        Source::MyCnf => my_cnf(&text),
        Source::Own => own(&text)?,
        Source::Environment => Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> (Profile, Option<String>) {
        let c = parse_url(text).unwrap_or_else(|e| panic!("{text}: {e}"));
        (c.profile, c.password.map(|s| s.expose().to_string()))
    }

    #[test]
    fn reads_the_url_forms_of_every_database() {
        let (p, pw) = url("postgres://app:s3cret@db.example:6543/shop?sslmode=verify-full");
        assert_eq!(
            (
                p.kind,
                p.host.as_str(),
                p.port,
                p.database.as_str(),
                p.user.as_str(),
                p.tls
            ),
            (
                DbKind::Postgres,
                "db.example",
                6543,
                "shop",
                "app",
                TlsMode::Verify
            )
        );
        assert_eq!(pw.as_deref(), Some("s3cret"));
        assert_eq!(p.name, "shop@db.example");

        // no port, no password, the long scheme, a JDBC prefix
        let (p, pw) = url("jdbc:postgresql://localhost/shop");
        assert_eq!(
            (p.host.as_str(), p.port, p.database.as_str()),
            ("localhost", 0, "shop")
        );
        assert_eq!(pw, None);
        assert!(p.user.is_empty());

        // special characters in user and password, and an @ in the password
        let (p, pw) = url("postgresql://us%40er:p%40ss%3Aw%2Ford%20x@host/db");
        assert_eq!(p.user, "us@er");
        assert_eq!(pw.as_deref(), Some("p@ss:w/ord x"));
        let (_, pw) = url("mysql://root:a@b@host/db");
        assert_eq!(pw.as_deref(), Some("a@b"));

        // IPv6, with and without a port
        let (p, _) = url("postgres://u@[2001:db8::1]:5433/d");
        assert_eq!((p.host.as_str(), p.port), ("[2001:db8::1]", 5433));
        let (p, _) = url("postgres://u@[::1]/d");
        assert_eq!((p.host.as_str(), p.port), ("[::1]", 0));

        let (p, pw) = url("mysql://root:pw@127.0.0.1:3307/shop?ssl-mode=REQUIRED");
        assert_eq!(
            (p.kind, p.port, p.tls),
            (DbKind::Mysql, 3307, TlsMode::Require)
        );
        assert_eq!(pw.as_deref(), Some("pw"));
        assert_eq!(url("mariadb://u@h/d").0.kind, DbKind::Mysql);
        let (oracle, _) = url("jdbc:oracle:thin:@//ora.example:1522/ORCLPDB1");
        assert_eq!(
            (
                oracle.kind,
                oracle.host.as_str(),
                oracle.port,
                oracle.database.as_str()
            ),
            (DbKind::Oracle, "ora.example", 1522, "ORCLPDB1")
        );
        assert_eq!(url("oracle://report@ora.example/FREEPDB1").0.user, "report");
        let (p, pw) = url("jdbc:mysql://h:3306/d?user=app&password=x%26y");
        assert_eq!((p.user.as_str(), pw.as_deref()), ("app", Some("x&y")));

        // options without a database, a trailing slash
        let (p, _) = url("postgres://u@h/?sslmode=disable");
        assert_eq!((p.database.as_str(), p.tls), ("", TlsMode::Off));
    }

    #[test]
    fn reads_sql_server_strings() {
        let (p, pw) = url(
            "Server=tcp:sql.example,1433;Database=Shop;User Id=sa;Password=p;w=1;Encrypt=True;TrustServerCertificate=False",
        );
        assert_eq!(
            (
                p.kind,
                p.host.as_str(),
                p.port,
                p.database.as_str(),
                p.user.as_str(),
                p.tls
            ),
            (
                DbKind::Sqlserver,
                "sql.example",
                1433,
                "Shop",
                "sa",
                TlsMode::Verify
            )
        );
        // `;` ends a value: what is behind it is another (unknown) key
        assert_eq!(pw.as_deref(), Some("p"));
        let (p, pw) = url(
            "jdbc:sqlserver://sql.example:1444;databaseName=Shop;user=app;password={s3cret};encrypt=true;trustServerCertificate=true",
        );
        assert_eq!(
            (p.host.as_str(), p.port, p.database.as_str()),
            ("sql.example", 1444, "Shop")
        );
        assert_eq!(
            (p.user.as_str(), pw.as_deref(), p.tls),
            ("app", Some("s3cret"), TlsMode::Require)
        );
        let (p, _) = url("Data Source=host\\SQLEXPRESS;Initial Catalog=x;UID=u;PWD=p");
        assert_eq!(
            (p.host.as_str(), p.database.as_str(), p.user.as_str()),
            ("host", "x", "u")
        );
        let (p, pw) = url("sqlserver://sa:pw@sql.example:1433/Shop");
        assert_eq!(
            (p.host.as_str(), p.port, pw.as_deref()),
            ("sql.example", 1433, Some("pw"))
        );
    }

    #[test]
    fn reads_sqlite_urls_and_paths() {
        for (text, path) in [
            ("sqlite:///Users/me/shop.db", "/Users/me/shop.db"),
            ("sqlite:shop.sqlite", "shop.sqlite"),
            ("jdbc:sqlite:/data/x.db", "/data/x.db"),
            (
                "/Users/me/My%20Data/shop.sqlite3",
                "/Users/me/My%20Data/shop.sqlite3",
            ),
            ("C:\\data\\shop.db", "C:\\data\\shop.db"),
            ("file:/data/x.db?mode=ro", "/data/x.db"),
        ] {
            let (p, pw) = url(text);
            assert_eq!(
                (p.kind, p.database.as_str()),
                (DbKind::Sqlite, path),
                "{text}"
            );
            assert!(pw.is_none());
            assert!(!p.name.is_empty());
        }
    }

    #[test]
    fn refuses_what_is_no_connection() {
        for text in [
            "",
            "hello",
            "https://example.com/x",
            "postgres://u@host:port/db",
            "postgres://u@[::1/db",
            "select * from t",
            "a\nb",
        ] {
            assert!(parse_url(text).is_err(), "{text}");
        }
        assert!(parse_url(&format!("postgres://h/{}", "x".repeat(5000))).is_err());
        // no secret in an error
        let e = parse_url("postgres://u:topsecret@host:port/db").unwrap_err();
        assert!(!e.message.contains("topsecret"));
    }

    #[test]
    fn a_url_without_what_a_profile_needs_says_what_is_missing() {
        let c = parse_url("postgres://db.example/shop").unwrap();
        assert!(c.problem.as_deref().is_some_and(|p| p.contains("user")));
        assert!(
            parse_url("postgres://u@db.example/shop")
                .unwrap()
                .problem
                .is_none()
        );
    }

    const DBEAVER: &str = r#"{
      "folders": { "Prod": {} },
      "connections": {
        "postgres-jdbc-18c1": {
          "provider": "postgresql", "driver": "postgres-jdbc", "name": "Shop Prod", "folder": "Prod",
          "save-password": true,
          "configuration": {
            "host": "db.example", "port": "5432", "database": "shop",
            "url": "jdbc:postgresql://db.example:5432/shop", "user": "app",
            "handlers": { "ssh_tunnel": { "type": "TUNNEL", "enabled": true,
              "configuration": { "host": "jump.example", "port": 2222, "authType": "PUBLIC_KEY",
                                 "keyPath": "/Users/me/.ssh/id_ed25519", "user": "ops" } } }
          }
        },
        "mysql8-18c2": {
          "provider": "mysql", "driver": "mysql8", "name": "Legacy",
          "configuration": { "host": "10.0.0.5", "port": "3307", "database": "old",
                             "url": "jdbc:mysql://10.0.0.5:3307/old" }
        },
        "db2-1": { "provider": "db2", "driver": "db2", "name": "Nope",
                   "configuration": { "host": "big-iron" } },
        "oracle-1": { "provider": "oracle", "driver": "oracle_thin", "name": "Warehouse",
                      "configuration": { "host": "ora.example", "port": "1521", "database": "ORCLPDB1",
                                         "user": "report" } },
        "sqlite-1": { "provider": "sqlite", "driver": "sqlite_jdbc", "name": "Local",
                      "configuration": { "database": "/data/local.db", "url": "jdbc:sqlite:/data/local.db" } }
      }
    }"#;

    #[test]
    fn imports_from_dbeaver() {
        let mut found = dbeaver(DBEAVER).unwrap();
        found.sort_by(|a, b| a.profile.name.cmp(&b.profile.name));
        let names: Vec<&str> = found.iter().map(|c| c.profile.name.as_str()).collect();
        // what we have no driver for is left out
        assert_eq!(names, vec!["Legacy", "Local", "Shop Prod", "Warehouse"]);
        let oracle = &found[3].profile;
        assert_eq!(
            (oracle.kind, oracle.host.as_str(), oracle.database.as_str()),
            (DbKind::Oracle, "ora.example", "ORCLPDB1")
        );
        let shop = &found[2].profile;
        assert_eq!(
            (
                shop.kind,
                shop.host.as_str(),
                shop.port,
                shop.database.as_str(),
                shop.user.as_str()
            ),
            (DbKind::Postgres, "db.example", 5432, "shop", "app")
        );
        assert_eq!(shop.folder, "Prod");
        let ssh = shop.ssh.as_ref().unwrap();
        assert_eq!(
            (ssh.host.as_str(), ssh.port, ssh.user.as_str(), ssh.auth),
            ("jump.example", 2222, "ops", SshAuth::Key)
        );
        assert!(found[2].problem.is_none());
        // DBeaver keeps users with the passwords: the profile says what is missing
        assert!(
            found[0]
                .problem
                .as_deref()
                .is_some_and(|p| p.contains("user"))
        );
        assert_eq!(found[1].profile.database, "/data/local.db");
        assert!(found.iter().all(|c| c.password.is_none()));
        assert!(dbeaver("{}").is_err());
        assert!(dbeaver("not json").is_err());
    }

    const DATAGRIP: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="DataSourceManagerImpl" format="xml" multifile-model="true">
    <data-source source="LOCAL" name="shop@localhost" uuid="aaaa-1">
      <driver-ref>postgresql</driver-ref>
      <synchronize>true</synchronize>
      <jdbc-driver>org.postgresql.Driver</jdbc-driver>
      <jdbc-url>jdbc:postgresql://localhost:5432/shop?sslmode=require&amp;x=1</jdbc-url>
    </data-source>
    <data-source source="LOCAL" name="Kasse &amp; Lager" uuid="bbbb-2">
      <driver-ref>mariadb</driver-ref>
      <jdbc-url>jdbc:mariadb://10.0.0.7:3306/kasse</jdbc-url>
    </data-source>
    <data-source source="LOCAL" name="h2" uuid="cccc-3">
      <jdbc-url>jdbc:h2:mem:test</jdbc-url>
    </data-source>
  </component>
</project>"#;
    const DATAGRIP_LOCAL: &str = r#"<project version="4">
  <component name="dataSourceStorageLocal" created-in="DB-241">
    <data-source name="shop@localhost" uuid="aaaa-1">
      <database-info product="PostgreSQL" version="16.2"/>
      <secret-storage>master_key</secret-storage>
      <user-name>postgres</user-name>
    </data-source>
  </component>
</project>"#;

    #[test]
    fn imports_from_datagrip_with_users_from_the_local_file() {
        let found = datagrip(DATAGRIP, Some(DATAGRIP_LOCAL)).unwrap();
        assert_eq!(found.len(), 2);
        let shop = &found[0].profile;
        assert_eq!(
            (
                shop.name.as_str(),
                shop.kind,
                shop.port,
                shop.user.as_str(),
                shop.tls
            ),
            (
                "shop@localhost",
                DbKind::Postgres,
                5432,
                "postgres",
                TlsMode::Require
            )
        );
        assert!(found[0].problem.is_none());
        assert_eq!(found[1].profile.name, "Kasse & Lager");
        assert_eq!(found[1].profile.kind, DbKind::Mysql);
        // without the local file the user is missing, and the profile says so
        let alone = datagrip(DATAGRIP, None).unwrap();
        assert!(alone[0].problem.is_some());
        assert!(datagrip("<html></html>", None).is_err());
    }

    #[test]
    fn xml_with_entity_declarations_is_refused() {
        let evil = r#"<?xml version="1.0"?>
<!DOCTYPE project [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<project><component name="DataSourceManagerImpl">
<data-source name="&xxe;" uuid="1"><jdbc-url>jdbc:postgresql://h/d</jdbc-url></data-source>
</component></project>"#;
        assert!(datagrip(evil, None).is_err());
        assert!(datagrip(DATAGRIP, Some(evil)).is_err());
        // an entity nobody declared stays text
        let odd = DATAGRIP.replace("shop@localhost", "&unknown;");
        assert_eq!(datagrip(&odd, None).unwrap()[0].profile.name, "&unknown;");
    }

    #[test]
    fn imports_from_pgpass_with_its_escapes_and_wildcards() {
        let text = "# comment\n\
                    db.example:5432:shop:app:s3cret\n\
                    *:*:*:postgres:pa\\:ss\\\\word\n\
                    broken line\n\
                    \n\
                    localhost:5433:x:u:\n";
        let found = pgpass(text);
        assert_eq!(found.len(), 3);
        let first = &found[0];
        assert_eq!(
            (
                first.profile.host.as_str(),
                first.profile.port,
                first.profile.database.as_str()
            ),
            ("db.example", 5432, "shop")
        );
        assert_eq!(first.password.as_ref().map(Secret::expose), Some("s3cret"));
        assert!(first.problem.is_none());
        // wildcards are left empty: the host is missing then
        assert_eq!(
            found[1].password.as_ref().map(Secret::expose),
            Some("pa:ss\\word")
        );
        assert!(found[1].problem.is_some());
        // an empty password is none
        assert!(found[2].password.is_none());
    }

    #[test]
    fn imports_from_pg_service_and_my_cnf() {
        let services = pg_service(
            "# services\n[shop]\nhost=db.example\nport=5433\ndbname=shop\nuser=app\nsslmode=verify-full\n\n[local]\ndbname=test\nuser=me\n",
        );
        assert_eq!(services.len(), 2);
        assert_eq!(
            (
                services[0].profile.name.as_str(),
                services[0].profile.port,
                services[0].profile.tls
            ),
            ("shop", 5433, TlsMode::Verify)
        );
        assert!(services[1].problem.is_some(), "no host");

        let cnf = my_cnf(
            "[client]\nuser = root\npassword = \"pw with space\"\nhost=127.0.0.1\nport=3307\n\n[mysqld]\nport=1\n\n[client-backup]\nuser=backup\n",
        );
        assert_eq!(cnf.len(), 2);
        assert_eq!(
            (
                cnf[0].profile.host.as_str(),
                cnf[0].profile.port,
                cnf[0].profile.user.as_str()
            ),
            ("127.0.0.1", 3307, "root")
        );
        assert_eq!(
            cnf[0].password.as_ref().map(Secret::expose),
            Some("pw with space")
        );
        assert_eq!(cnf[1].profile.host, "localhost");
        assert!(cnf[1].password.is_none());
    }

    #[test]
    fn imports_from_the_environment() {
        let env = Environment {
            vars: vec![
                ("PGHOST".into(), "db.example".into()),
                ("PGUSER".into(), "app".into()),
                ("PGPASSWORD".into(), "pw".into()),
                ("PGSSLMODE".into(), "require".into()),
                ("MYSQL_HOST".into(), "my.example".into()),
                ("MYSQL_TCP_PORT".into(), "3307".into()),
            ],
        };
        let found = environment(&env);
        assert_eq!(found.len(), 2);
        assert_eq!(
            (found[0].profile.kind, found[0].profile.tls),
            (DbKind::Postgres, TlsMode::Require)
        );
        assert_eq!(found[0].password.as_ref().map(Secret::expose), Some("pw"));
        assert_eq!(found[1].profile.port, 3307);
        assert!(environment(&Environment::default()).is_empty());
    }

    #[test]
    fn our_own_export_round_trips_without_ids_and_without_secrets() {
        let mut a = blank(DbKind::Postgres);
        a.id = "shop".into();
        a.name = "Shop".into();
        a.host = "db.example".into();
        a.user = "app".into();
        a.label = "PROD".into();
        a.ssh = Some(SshTarget {
            host: "jump".into(),
            port: 0,
            user: "ops".into(),
            auth: SshAuth::Agent,
            key_file: String::new(),
        });
        let text = export_own(std::slice::from_ref(&a)).unwrap();
        // the only field with "password" in its name says whether to remember one
        assert_eq!(text.matches("assword").count(), 1);
        assert!(text.contains("\"savePassword\""));
        let back = own(&text).unwrap();
        assert_eq!(back.len(), 1);
        let mut expected = a.clone();
        expected.id.clear();
        assert_eq!(back[0].profile, expected);
        assert!(back[0].password.is_none());
        assert!(own("{}").is_err());
        assert!(own(&text.replace("\"version\": 1", "\"version\": 9")).is_err());
    }

    #[test]
    fn foreign_text_is_bounded_and_cleaned() {
        let long = format!("postgres://u@h/{}", "d".repeat(3000));
        let c = parse_url(&long).unwrap();
        assert!(c.profile.database.len() <= 200);
        let c = candidate(
            Profile {
                name: "a\u{0}b\u{1b}[31m".into(),
                host: "h".into(),
                user: "u".into(),
                ..blank(DbKind::Postgres)
            },
            None,
        );
        assert_eq!(c.profile.name, "ab[31m");
    }

    #[test]
    fn reads_files_within_bounds() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(".pgpass");
        std::fs::write(&file, "h:5432:d:u:p\n").unwrap();
        assert_eq!(read(Source::Pgpass, Some(&file)).unwrap().len(), 1);
        assert_eq!(
            read(Source::Pgpass, Some(&dir.path().join("none")))
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        assert!(read(Source::Pgpass, None).is_err());
        assert!(read(Source::Pgpass, Some(dir.path())).is_err());
        // DataGrip: the users come from the file next to it
        std::fs::write(dir.path().join("dataSources.xml"), DATAGRIP).unwrap();
        std::fs::write(dir.path().join("dataSources.local.xml"), DATAGRIP_LOCAL).unwrap();
        let found = read(Source::Datagrip, Some(&dir.path().join("dataSources.xml"))).unwrap();
        assert_eq!(found[0].profile.user, "postgres");
        assert_eq!(
            default_path(Source::Pgpass, Path::new("/home/me")),
            Some(PathBuf::from("/home/me/.pgpass"))
        );
        assert!(default_path(Source::Datagrip, Path::new("/home/me")).is_none());
    }
}
