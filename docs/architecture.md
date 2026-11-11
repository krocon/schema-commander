# Architektur

Schema Commander ist eine Desktop-App: **Rust** hält Verbindungen und Daten, die **WebView** (Angular) zeigt immer nur
einen Ausschnitt davon. Aufbau, Werkzeuge und Regeln folgen `files-and-folders-tauri`, `log-commander` und
`editlicious`.

```
┌──────────────────────── Fenster (WebView) ────────────────────────┐
│ Angular 22, zoneless, Signals                                      │
│  Komponenten ── Stores/Services ── *Api-Fassaden ── call() ──┐     │
│  <editlicious-editor> (WASM im Worker)   GuiExpert Table     │     │
└──────────────────────────────────────────────────────────────┼─────┘
                                                    Tauri IPC  │ invoke / Channel
┌──────────────────────────────────────────────────────────────┼─────┐
│ Rust: commands.rs (dünn) ── reine Module (demo_db, später Treiber) │
│ Plugins: store (Einstellungen), window-state (Fenster)             │
└────────────────────────────────────────────────────────────────────┘
```

## Entscheidungen

| Nr. | Entscheidung | Grund |
|---|---|---|
| A1 | Technischer Aufbau wie files-and-folders-tauri: pnpm, Angular-CLI mit `@angular/build`, Vitest über `ng test`, ESLint + Prettier, `pnpm check`, CI auf drei Betriebssystemen | ein Werkzeugkasten für alle Projekte |
| A2 | Dev-Port **1460** (fnf 1420, editlicious 1440, log-commander 1450) | Projekte laufen nebeneinander |
| A3 | Farbschemata aus **log-commander** (das sie aus fnf abgeleitet hat): gleiche 17 Schemata, Galerie, „System folgen“ | gleiche Bedienung wie in fnf, aber ohne dessen Dateimanager-Tokens; Tokens auf SQL umbenannt (`docs/themes.md`) |
| A4 | Einstellungen mit `tauri-plugin-store`, Fensterzustand mit `tauri-plugin-window-state` (wie log-commander) | wenig eigener Code; fnf hat dafür eigene Rust-Module, die hier (noch) nicht nötig sind |
| A5 | editlicious als npm-Paket `editlicious-editor`, **nicht gebündelt**, bei Bedarf von `/editlicious/` geladen | das Paket findet Worker und WebAssembly neben sich; gebündelt gingen die relativen Pfade verloren, und Angular wäre doppelt im Startbundle |
| A6 | CSP um `'wasm-unsafe-eval'` und `worker-src 'self' blob:` erweitert | Engine des Editors; unter der Produktions-CSP geprüft |
| A7 | Demo-Datenbank (SQLite im Speicher, `rusqlite` gebündelt) als Walking Skeleton | der ganze Weg Editor → Rust → Gitter steht, ohne dass ein Server nötig ist; wird durch die Verbindungsschicht ersetzt |
| A8 | Ergebnis als Zeilen-Arrays (`rows: Cell[][]`), Spalten über den Index als `property` | kompakt über die Brücke; die GuiExpert Table liest `row["0"]` |
| A9 | Fehler als `AppError { code, message }`, eine Stelle für `invoke()` (`call.ts`) | wie in allen Vorgängern |
| A11 | Editor mit `scheme="none"`, alle Farben aus unseren Tokens (`EDITOR_COLORS`) | folgt jedem Schema, auch eigenen; keine zweite Farbwelt (Design 001 E1) |
| A12 | Eigene Farbschemata in `themes.json` über ein eigenes Rust-Modul statt `tauri-plugin-store` | Grenzen und Prüfung im Backend, defekte Datei reißt die Einstellungen nicht mit (Design 001 E3) |
| A13 | Pfade kommen nur aus nativen Dialogen (`FileDialogApi`), Lesen und Schreiben nur über eigene Commands | kein Dateizugriff aus dem Frontend; `tauri-plugin-fs` (von `-dialog` mitgezogen) ist nicht registriert |
| A14 | `inlineCritical: false` im Produktions-Build | Angulars Nachladen des Stylesheets braucht ein Inline-Skript, das eine strikte CSP ohne Nonce blockiert; lokal bringt das Inlining nichts |
| A10 | Oberflächentexte vorerst deutsch in den Komponenten | übernommene Galerie ist deutsch; Kataloge de/en kommen mit dem Prompt „Einstellungen und Sprache“ |

## Offene Architekturfragen (entscheidet der jeweilige Prompt)

- **Treiber**: Vorschlag wie log-commander – `sqlx-postgres`, `sqlx-mysql` (reines Rust, rustls), `tiberius` für SQL
  Server, `rusqlite` für SQLite; Oracle und DuckDB später. Ein Trait `Driver` mit gleicher Signatur je Datenbank.
- **Große Ergebnisse**: Rust streamt in einen Spool (Datei/Speicher), das Frontend holt Fenster von Zeilen über ein
  eigenes `AreaModel` der GuiExpert Table (wie die Log-Ansicht von log-commander).
- **Vervollständigung**: Schema-Metadaten in Rust zwischenspeichern; der Editor braucht dafür eine Schnittstelle für
  Vorschläge von außen (Erweiterung in editlicious).

## Abhängigkeiten

| Paket | Wofür | Warum dieses |
|---|---|---|
| `@angular/*` 22, `rxjs`, `tslib` | Frontend | Vorgabe |
| `@tauri-apps/api`, `@tauri-apps/cli` 2 | Brücke und Werkzeug | Vorgabe |
| `@tauri-apps/plugin-store` / `tauri-plugin-store` | Einstellungen als JSON-Datei | wie log-commander |
| `tauri-plugin-window-state` | Fensterposition und -größe | wie log-commander |
| `@guiexpert/table`, `@guiexpert/angular-table` | Ergebnisgitter (später Baum, Listen) | Vorgabe; virtuelles Scrollen in beide Richtungen |
| `editlicious-editor` | SQL-Editor | Vorgabe; große Texte, SQL-Grammatik, 13 Schemata |
| `tauri-plugin-dialog`, `@tauri-apps/plugin-dialog` | native Öffnen-/Speichern-Dialoge (Schema-Import/-Export, später SQL-Dateien, Export) | wie log-commander; nur `dialog:allow-open`, `dialog:allow-save` |
| `tempfile` (dev) | Dateitests in Rust | Standard |
| `rusqlite` (bundled) | Demo-Datenbank, später SQLite-Dateien | keine Systembibliothek |
| `serde`, `serde_json` | DTOs | Standard |
| Dev: `vitest`, `jsdom`, `eslint`, `angular-eslint`, `typescript-eslint`, `prettier` | Tests, Lint, Format | wie die Vorgänger |
