# Design 034: Release und Verteilung

> **Status:** umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/release` · Auftrag: [034-release.md](034-release.md) · Feature G6
>
> **Kein Tag, kein Release, kein Push, keine Schlüssel:** Alles hier ist vorbereitet; ausgelöst wird es von Marc.

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Version | bleibt, wie sie war: `package.json` ist die Quelle (`scripts/version.mjs`), `pnpm version:check` in `pnpm check` und CI; der Release-Workflow prüft zusätzlich Tag = Version; ein Rust-Test hält `Cargo.toml` und `package.json` zusammen | Aufgabe 1 |
| E2 | Workflow | `.github/workflows/release.yml` aus `files-and-folders-tauri` übernommen: Tag `v*` oder von Hand → macOS (universal), Windows (`.msi`, NSIS), Linux (`.deb`, `.rpm`, AppImage) mit `tauri-action` als **Entwurf**; dazu ein Job, der `SHA256SUMS.txt` anhängt | Aufgabe 2; dort erprobt |
| E3 | Notizen | `pnpm release:notes` (`scripts/release-notes.mjs`): Conventional Commits seit dem letzten Tag, gruppiert; von Hand in den Entwurf | Aufgabe 2 |
| E4 | Signierung | vorbereitet, nichts eingerichtet: Der Workflow signiert, sobald die Secrets da sind (macOS Developer ID + Notarisierung, Windows `.pfx`), sonst baut er unsigniert. Schritte in `docs/release.md` und `docs/macos-signing.md` | Aufgabe 3; Zertifikate sind Marcs |
| E5 | Entitlements | keine. JIT und WebAssembly laufen im WebContent-Prozess der WebView. **Im signierten Paket nicht geprüft** – erster Punkt der Prüfung nach dem Einrichten, die Stelle für ein Entitlement ist benannt | Aufgabe 3 |
| E6 | **Auto-Update** | bewertet, **nicht aufgenommen**: Es braucht ein Schlüsselpaar (dessen privater Teil Marc gehört und nie verloren gehen darf), eine signierte App und ein erstes öffentliches Release. Vorher wäre das Plugin eine Abhängigkeit, die nichts tut und sich nicht prüfen lässt. `docs/release.md` nennt die Schritte und die Regeln (abschaltbar, Hinweis statt stiller Installation, Kanal „stable“) | Aufgabe 4 verlangt „Aufnahme begründen“ – die Begründung fällt gegen jetzt aus |
| E7 | Lizenzhinweise | `scripts/notices.mjs` (aus fnf) erzeugt `THIRD-PARTY-NOTICES.txt` aus `cargo metadata` und `pnpm licenses`; die Datei, die `editlicious-editor` für die Crates in seinem WebAssembly mitbringt, wird als Lizenzdatei erkannt und steht darin. `pnpm notices:check` ist Teil von `pnpm check`, der CI und des Release-Workflows; die Datei liegt in jedem Paket (`bundle.resources`) | Aufgabe 5, Akzeptanzkriterium 3 |
| E8 | About | Aktion `SHOW_ABOUT` (Hilfe; unter macOS im App-Menü statt des nativen Eintrags): Version, Build, Plattform, Tauri, WebView, Autor, Lizenz, Quelltext; „Lizenzen Dritter“ zeigt die Datei aus dem Paket als Text; „Diagnose kopieren“ legt die Zeilen in die Zwischenablage. Vom User-Agent bleibt nur Engine und Version | Aufgabe 6 |
| E9 | Icon | `public/icon.svg` neu: Datenbank (drei Scheiben) und eine Eingabeaufforderung auf eigener Fläche; daraus `pnpm tauri icon` und das Favicon. Android- und iOS-Varianten nicht eingecheckt (keine Ziele) | Aufgabe 7 |
| E10 | Paketquellen | Anleitung in `docs/distribution.md` (Homebrew, winget, Scoop, AUR, Flathub); nichts eingereicht | Aufgabe 8 |

## Verträge

`app_info → AppInfo { name, version, crateVersion, tauriVersion, os, arch, debug }`, `third_party_notices → string`.
Fenster: `AboutApi` (`core/about/`), `AboutDialog`, `about-logic.ts`. Skripte: `pnpm notices`, `pnpm notices:check`,
`pnpm release:notes`.

## Geprüft

- **Skripte** (`pnpm scripts:test`): Hinweise (nur ausgelieferte Crates, Lizenzdateien samt
  `THIRD-PARTY-NOTICES.txt`, gleiche Texte einmal, Standardtexte, CRLF), Notizen (Kopfzeilen, Gruppen), Version.
- `pnpm notices`: 613 Crates, 12 npm-Pakete; `editlicious-editor` steht mit seinen Hinweisen darin. Eine Zeile aus
  der Datei gelöscht → `pnpm notices:check` endet mit 1, wiederhergestellt → 0.
- **Rust** (4 Tests in `about.rs`): Angaben zum Build; eine Version in allen Dateien; die Hinweise stehen in
  `bundle.resources` und sind lesbar.
- **Fenster**: Logik (3 Tests: WebView aus dem User-Agent, Zeilen, Diagnose ohne User-Agent), Dialog (4 Tests).
- **Im Browser** mit nachgebildetem Backend: Dialog über die Aktion geöffnet, Zeilen, Icon, Lizenztext als Text
  (ein `<script>` darin bleibt Text), Diagnose in der Zwischenablage.
- Beide Workflow-Dateien sind gültiges YAML.
- `pnpm check` grün.

## Nicht geprüft, nicht getan

- **Kein Paket gebaut, kein Tag, kein Lauf des Release-Workflows** – das erste Akzeptanzkriterium (Pakete
  installieren, starten, deinstallieren auf drei Systemen) ist **offen**; die Tabelle „Prüfen“ in `docs/release.md`
  sagt, was zu tun ist.
- **Editor im signierten Paket unter der Produktions-CSP** (Akzeptanzkriterium 2): offen, es gibt kein Zertifikat.
  Unter der Produktions-CSP ohne Signatur prüft `pnpm preview:csp` wie bisher.
- Auto-Update (E6), Signierung (E4), Paketquellen (E10): Anleitung statt Einrichtung.
- Das native Fenster (`pnpm tauri dev`) wurde nicht bedient; dort liest der About-Dialog die Hinweise aus dem
  Repository (Entwicklungs-Build).
