//! Data for the "About" dialog (prompt 034): product name, version, Tauri version, OS family and
//! architecture – and where the notices of the third-party components are. Nothing about the user.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// The file with the licence texts of everything that ships in the app (`pnpm notices`).
pub const NOTICES_FILE: &str = "THIRD-PARTY-NOTICES.txt";

/// Mirrored by `AppInfo` in `src/app/core/about/about-api.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    /// Version from `tauri.conf.json`, which reads `package.json` (one source of truth).
    pub version: String,
    /// Version of the Rust crate (`Cargo.toml`); equal to `version` when the release was prepared with
    /// `scripts/version.mjs`.
    pub crate_version: String,
    pub tauri_version: String,
    /// `macos`, `windows`, `linux`, …
    pub os: String,
    /// `x86_64`, `aarch64`, …
    pub arch: String,
    /// Debug build (development), not a release package.
    pub debug: bool,
}

pub fn app_info(name: &str, version: &str) -> AppInfo {
    AppInfo {
        name: name.to_owned(),
        version: version.to_owned(),
        crate_version: env!("CARGO_PKG_VERSION").to_owned(),
        tauri_version: tauri::VERSION.to_owned(),
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        debug: cfg!(debug_assertions),
    }
}

/// Where the notices may be: in the resources of the package, and – in a development build, which has
/// no package – in the repository.
pub fn notices_candidates(resources: Option<&Path>) -> Vec<PathBuf> {
    let mut all: Vec<PathBuf> = resources.iter().map(|dir| dir.join(NOTICES_FILE)).collect();
    if cfg!(debug_assertions) {
        all.push(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join(NOTICES_FILE),
        );
    }
    all
}

/// The first of the candidates that can be read.
pub fn read_notices(candidates: &[PathBuf]) -> Option<String> {
    candidates
        .iter()
        .find_map(|path| std::fs::read_to_string(path).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_build_and_platform_data() {
        let info = app_info("Schema Commander", "1.2.3");
        assert_eq!(info.name, "Schema Commander");
        assert_eq!(info.version, "1.2.3");
        assert_eq!(info.crate_version, env!("CARGO_PKG_VERSION"));
        assert!(!info.tauri_version.is_empty());
        assert_eq!(info.os, std::env::consts::OS);
        assert_eq!(info.arch, std::env::consts::ARCH);
    }

    #[test]
    fn serialises_camel_case() {
        let json = serde_json::to_value(app_info("x", "0.1.0")).unwrap();
        assert!(json.get("tauriVersion").is_some());
        assert!(json.get("crateVersion").is_some());
    }

    /// tauri.conf.json takes its version from package.json; Cargo.toml must match it
    /// (`node scripts/version.mjs set <v>` keeps them equal). The notices go into every package.
    #[test]
    fn the_package_has_one_version_and_carries_the_notices() {
        let pkg: serde_json::Value =
            serde_json::from_str(include_str!("../../package.json")).unwrap();
        assert_eq!(pkg["version"].as_str(), Some(env!("CARGO_PKG_VERSION")));
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["version"].as_str(), Some("../package.json"));
        assert_eq!(
            conf["bundle"]["resources"][format!("../{NOTICES_FILE}")].as_str(),
            Some(NOTICES_FILE)
        );
    }

    #[test]
    fn reads_the_notices_from_the_first_place_that_has_them() {
        let dir = tempfile::tempdir().unwrap();
        let there = dir.path().join(NOTICES_FILE);
        std::fs::write(&there, "the notices").unwrap();
        let missing = dir.path().join("nowhere").join(NOTICES_FILE);
        assert_eq!(
            read_notices(&[missing.clone(), there]).as_deref(),
            Some("the notices")
        );
        assert_eq!(read_notices(&[missing]), None);
        // the package looks in its resources first
        assert_eq!(
            notices_candidates(Some(dir.path()))[0],
            dir.path().join(NOTICES_FILE)
        );
        // … and the repository has the file (a development build reads it there)
        assert!(read_notices(&notices_candidates(None)).is_some());
    }
}
