# Prompt 034: Release und Verteilung

> **Slug:** `release` · **Feature:** G6 · **Braucht:** – (sinnvoll nach Stufe 1) · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild und Quelle: `files-and-folders-tauri` Prompt 017
> (`docs/release.md`, `docs/distribution.md`, `docs/macos-signing.md`, `.github/workflows/release.yml`,
> `scripts/{version,release-notes,notices,licenses}.mjs`, About-Dialog).

## Ziel

Aus einem Tag entstehen installierbare Pakete für macOS, Windows und Linux – mit richtiger Version, Icons,
Lizenzhinweisen und einem Weg zu Updates.

## Aufgaben

1. **Version aus einer Quelle** (`package.json`; `scripts/version.mjs` ist da): `version:set`, Prüfung in CI.
2. **Release-Workflow** (Tag `v*` → Entwurfs-Release): macOS (universal `.dmg`), Windows (`.msi`, NSIS), Linux
   (`.deb`, `.rpm`, AppImage); Artefakte mit Prüfsummen; Release-Notizen aus Conventional Commits.
3. **Signierung**: macOS (Developer ID, Notarisierung, Hardened Runtime – Entitlements für WebAssembly/JIT der
   WebView prüfen), Windows (Zertifikat); vorbereiten und dokumentieren, Geheimnisse nur als CI-Secrets.
4. **Auto-Update** (`tauri-plugin-updater`): Aufnahme begründen; signierte Update-Dateien, Kanal „stable“, Prüfung
   beim Start abschaltbar, Hinweis statt stiller Installation.
5. **Lizenzhinweise**: `THIRD-PARTY-NOTICES.txt` aus npm- und Cargo-Abhängigkeiten erzeugen (Skripte aus fnf),
   Prüfung in `pnpm check`; die Hinweise von `editlicious-editor` einbinden; Datei im Paket und im About-Dialog.
6. **About-Dialog**: Version, Build, Lizenzen, Links; „Diagnose kopieren“ (Version, OS, WebView – keine Nutzerdaten).
7. **Icon** überarbeiten (Platzhalter aus dem Skeleton ersetzen): `public/icon.svg` → `pnpm tauri icon`.
8. Optional: Paketquellen (Homebrew Cask, winget, Flatpak/AUR) als Anleitung in `docs/distribution.md`.

## Akzeptanzkriterien

- Ein Test-Tag erzeugt auf allen drei Systemen Pakete, die sich installieren, starten und deinstallieren lassen.
- Der Editor (Worker + WebAssembly) läuft im installierten, signierten Paket unter der Produktions-CSP.
- `pnpm check` schlägt fehl, wenn die Lizenzhinweise nicht zu den Abhängigkeiten passen.

## Tests

Skript-Tests (Version, Notizen, Hinweise). Von Hand: Installation je System; nicht Prüfbares im Bericht nennen.
