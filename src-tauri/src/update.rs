//! Is there a newer version? One request to the releases of the repository on GitHub, compared with the
//! version of this build. Nothing is downloaded and nothing installed: the user is told, and the page of
//! the release is opened in the browser on request.
//!
//! The request carries nothing of the user's (no id, no version, no platform) – GitHub sees an address
//! and the name of the client. What comes back is foreign text: the tag is only used when it is a
//! version, the notes are plain text with a bound, and the page that is opened is built here, never taken
//! from the answer.

use crate::db::http::transport;
use crate::db::{clean, install_crypto};
use crate::error::{AppError, AppResult, ErrorCode};
use serde::Serialize;
use std::cmp::Ordering;
use std::time::Duration;

/// The latest published release: GitHub leaves out drafts and pre-releases here.
pub const LATEST_URL: &str = "https://api.github.com/repos/krocon/schema-commander/releases/latest";
/// Where the releases are for a reader.
pub const RELEASES_PAGE: &str = "https://github.com/krocon/schema-commander/releases";

const TIMEOUT: Duration = Duration::from_secs(10);
/// The description of a release is a few kilobytes; anything larger is not read.
const MAX_ANSWER: u64 = 512 * 1024;
/// Characters of the release notes that reach the window.
pub const MAX_NOTES: usize = 20_000;
const ON: &str = "github.com";

/// `1.2.3`, with what follows a `-` (`rc.1`) when it is a pre-release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// `""` for a release.
    pub pre: String,
}

impl Version {
    /// `1.2.3`, `v1.2.3`, `1.2.3-rc.1`, `1.2.3+build` – and nothing else: only digits, dots and the
    /// characters of a pre-release, so a parsed version is safe as part of an address.
    pub fn parse(text: &str) -> Option<Version> {
        let text = text.trim();
        let text = text.strip_prefix('v').unwrap_or(text);
        let text = text.split_once('+').map_or(text, |(v, _)| v);
        let (numbers, pre) = text.split_once('-').unwrap_or((text, ""));
        if text.contains('-') && pre.is_empty() {
            return None;
        }
        if pre.len() > 40
            || !pre
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        {
            return None;
        }
        let mut parts = numbers.split('.');
        let mut number = || -> Option<u64> {
            let part = parts.next()?;
            if part.is_empty() || part.len() > 9 || !part.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            part.parse().ok()
        };
        let (major, minor, patch) = (number()?, number()?, number()?);
        if parts.next().is_some() {
            return None;
        }
        Some(Version {
            major,
            minor,
            patch,
            pre: pre.to_owned(),
        })
    }

    pub fn is_release(&self) -> bool {
        self.pre.is_empty()
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if !self.pre.is_empty() {
            write!(f, "-{}", self.pre)?;
        }
        Ok(())
    }
}

impl Ord for Version {
    /// As semantic versioning orders them: numbers first; a pre-release is older than its release;
    /// two pre-releases part by part (numbers as numbers, a number before a word).
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => pre_order(&self.pre, &other.pre),
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn pre_order(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.split('.'), b.split('.'));
    loop {
        return match (a.next(), b.next()) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Less,
            (Some(_), None) => Ordering::Greater,
            (Some(x), Some(y)) => {
                let order = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(x), Ok(y)) => x.cmp(&y),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => x.cmp(y),
                };
                if order == Ordering::Equal {
                    continue;
                }
                order
            }
        };
    }
}

/// Mirrored by `UpdateInfo` in `src/app/core/update/update-api.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// The version of this build.
    pub current: String,
    /// The latest published version, without a `v`.
    pub latest: String,
    /// `latest` is newer than `current`.
    pub newer: bool,
    /// The day the release was published, `YYYY-MM-DD`; `""` when the answer does not say.
    pub published: String,
    /// The notes of the release as plain text (Markdown as written), at most `MAX_NOTES` characters.
    pub notes: String,
    /// The notes were longer than what is shown.
    pub notes_cut: bool,
}

/// The page of a release for a reader. Built from a parsed version, never from the answer of a server.
pub fn release_page(version: &Version) -> String {
    format!("{RELEASES_PAGE}/tag/v{version}")
}

/// Plain text of a bounded length: no control characters but line breaks and tabs.
fn notes_of(body: &str) -> (String, bool) {
    let plain = body.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::new();
    let mut count = 0usize;
    for c in plain.trim().chars() {
        if c.is_control() && c != '\n' && c != '\t' {
            continue;
        }
        if count == MAX_NOTES {
            return (out, true);
        }
        out.push(c);
        count += 1;
    }
    (out, false)
}

/// `2026-11-14T10:00:00Z` → `2026-11-14`; anything else → `""`.
fn day_of(published: &str) -> String {
    let day = published.get(..10).unwrap_or_default();
    let bytes = day.as_bytes();
    let shaped = bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        });
    if shaped {
        day.to_owned()
    } else {
        String::new()
    }
}

/// Reads GitHub's answer for the latest release and compares it with the version of this build.
pub fn read_release(answer: &str, current: &str) -> AppResult<UpdateInfo> {
    let unreadable = |what: &str| {
        AppError::new(
            ErrorCode::ConnectionFailed,
            format!("{ON}: the answer is not a release ({what})"),
        )
    };
    let current = Version::parse(current).ok_or_else(|| {
        AppError::new(
            ErrorCode::Unsupported,
            "the version of this build is not a version",
        )
    })?;
    let json: serde_json::Value =
        serde_json::from_str(answer).map_err(|_| unreadable("not JSON"))?;
    let tag = json["tag_name"]
        .as_str()
        .ok_or_else(|| unreadable("no tag"))?;
    let latest = Version::parse(tag).ok_or_else(|| unreadable("its tag is not a version"))?;
    // a draft or a pre-release is never offered, whatever the address returned
    let stable = latest.is_release()
        && json["draft"].as_bool() != Some(true)
        && json["prerelease"].as_bool() != Some(true);
    let (notes, notes_cut) = notes_of(json["body"].as_str().unwrap_or_default());
    Ok(UpdateInfo {
        newer: stable && latest > current,
        current: current.to_string(),
        latest: latest.to_string(),
        published: day_of(json["published_at"].as_str().unwrap_or_default()),
        notes,
        notes_cut,
    })
}

/// One `GET`: no redirect is followed, the answer is bounded. `https_only` is off only for the tests'
/// own server.
fn get(url: &str, https_only: bool) -> AppResult<(u16, String)> {
    install_crypto();
    let agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .https_only(https_only)
        .timeout_global(Some(TIMEOUT))
        .user_agent("schema-commander")
        .max_redirects(0)
        .build()
        .new_agent();
    let mut response = agent
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| transport(ON, &e))?;
    let status = response.status().as_u16();
    let text = response
        .body_mut()
        .with_config()
        .limit(MAX_ANSWER)
        .lossy_utf8(true)
        .read_to_string()
        .map_err(|e| transport(ON, &e))?;
    Ok((status, text))
}

/// What a status that is not 200 means.
fn refused(status: u16, answer: &str) -> AppError {
    match status {
        404 => AppError::new(ErrorCode::NotFound, "no release has been published yet"),
        403 | 429 => AppError::new(
            ErrorCode::ConnectionFailed,
            format!("{ON}: too many requests from this address, try again later"),
        ),
        _ => {
            let said = serde_json::from_str::<serde_json::Value>(answer)
                .ok()
                .and_then(|j| j["message"].as_str().map(clean))
                .unwrap_or_default();
            let said: String = said.chars().take(200).collect();
            AppError::new(
                ErrorCode::ConnectionFailed,
                format!("{ON}: status {status} {said}")
                    .trim_end()
                    .to_owned(),
            )
        }
    }
}

fn check_at(url: &str, https_only: bool, current: &str) -> AppResult<UpdateInfo> {
    let (status, answer) = get(url, https_only)?;
    if status != 200 {
        return Err(refused(status, &answer));
    }
    read_release(&answer, current)
}

/// Asks GitHub for the latest release. Blocks for at most `TIMEOUT`.
pub fn check(current: &str) -> AppResult<UpdateInfo> {
    check_at(LATEST_URL, true, current)
}

/// The page to open for a version the window names: that of the release, or the list of releases when
/// no version is named. Anything that is not a version is refused.
pub fn page_for(version: &str) -> AppResult<String> {
    if version.is_empty() {
        return Ok(RELEASES_PAGE.to_owned());
    }
    Version::parse(version)
        .map(|v| release_page(&v))
        .ok_or_else(|| AppError::new(ErrorCode::Unsupported, "this is not a version"))
}

/// Opens a page of the releases in the browser of the OS – without a shell, and only an address that
/// `page_for` built.
pub fn open_page(version: &str) -> AppResult<()> {
    let url = page_for(version)?;
    let mut command = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    } else if cfg!(target_os = "windows") {
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler").arg(&url);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| AppError::new(ErrorCode::Io, format!("browser: {e}")))
}

#[cfg(test)]
#[path = "update_tests.rs"]
mod tests;
