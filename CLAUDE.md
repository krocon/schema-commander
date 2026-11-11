# CLAUDE.md – Schema Commander

> Leitfaden für Claude (und Menschen) zur Arbeit an **Schema Commander**: einem plattformübergreifenden SQL-Client für
> macOS, Windows und Linux. Autor: Marc Kronberg · Repo: https://github.com/krocon/schema-commander · MIT
>
> Desktop-App mit Tauri 2 + Angular 22 (zoneless, Signals, CSS-Variablen) + Rust, aufgebaut wie
> `files-and-folders-tauri`, `log-commander` und `editlicious` (gleicher Autor, lokal unter `../`).
> Editor = **editlicious** (`<editlicious-editor>`), Tabellen = **GuiExpert Table** (`@guiexpert/table`).

## 1. Stand

- **Walking Skeleton**: Fenster mit Toolbar, Seitenleiste, SQL-Editor, Ergebnisgitter, Statuszeile; eine
  Demo-Datenbank (SQLite im Speicher) in Rust; `Strg/Cmd+Enter` führt die Anweisung unter dem Cursor aus; 17
  Farbschemata umschaltbar (auch „System folgen“), **eigene Schemata** mit Live-Editor, Import und Export (Prompt 001);
  der Editor folgt jedem Schema; Einstellungen und Fensterzustand bleiben über einen Neustart.
- **Noch nichts davon**: echte Verbindungen, Schema-Baum, Tabs, Bearbeiten, Export. Alle Features aus
  `docs/feature-analysis.md` sind freigegeben; die Prompts 002–049 liegen in `prompts/` (Nummer = Reihenfolge,
  erledigt: 001),
  Erweiterungen an editlicious als E1–E5 in `prompts/done/editlicious/` (auszuführen im Repo `../editlicious`).
- Weiterentwicklung über **Feature-Prompts** (`prompts/README.md`, gemeinsame Regeln `prompts/000-arbeitsweise.md`).

## 2. Befehle (Root, pnpm 10 via `packageManager`, Node ≥ 22.22.3, Rust stable ≥ 1.93)

| Zweck | Befehl |
|---|---|
| Install | `pnpm install` |
| App starten (Dev) | `pnpm tauri dev` (Angular-Dev-Server auf Port 1460 + Fenster) |
| Nur Frontend im Browser | `pnpm start` (kein Backend: Abfragen melden „desktop backend is not available“) |
| Frontend-Tests | `pnpm test` (Vitest + jsdom, über `ng test`), `pnpm test:watch` |
| Lint / Format | `pnpm lint`, `pnpm format`, `pnpm format:check` |
| Frontend-Build | `pnpm build` |
| Rust | `pnpm rust:fmt`, `pnpm rust:lint` (clippy `-D warnings`), `pnpm rust:test` |
| Farbschemata | `pnpm contrast` (WCAG AA aller Schemata), `pnpm contrast --write-base` (dark/light.json aus `styles.css`) |
| Version | `pnpm version:check`, `pnpm version:set X.Y.Z` (Quelle `package.json`) |
| Alles prüfen | `pnpm check` |
| Produktions-Build unter CSP | `pnpm build && pnpm preview:csp` → http://localhost:1461 (ohne Backend; prüft Editor-Worker, WebAssembly, Styles) |
| Debug-Build ohne Paket | `pnpm tauri build --debug --no-bundle` → `src-tauri/target/debug/schema-commander` |

Nicht ausführbare Checks im Abschlussbericht mit Grund nennen.

## 3. Layout

```
src/                           Angular 22 (zoneless, Signals, Standalone)
  styles.css                   Design-Tokens (@theme dark / light), Grundstile – einzige Stelle für Farben
  styles/ge-table-theme.css    Brücke Tokens → --ge-table-* der GuiExpert Table
  app/app.ts, app.css          Fenster: Toolbar, Seitenleiste, Editor, Ergebnis, Statuszeile, Splitter
  app/app.config.ts            Provider: *Api-Fassaden → Tauri-Implementierungen
  app/core/backend/            call.ts (einzige Stelle mit invoke()), WindowApi (set_window_chrome),
                               FileDialogApi (native Öffnen-/Speichern-Dialoge: einzige Quelle für Pfade)
  app/core/errors/             AppError + toAppError (spiegelt src-tauri/src/error.rs)
  app/core/settings/           Settings (Modell, mergeSettings), SettingsService (tauri-plugin-store)
  app/core/sql/                QueryApi + DTOs (QueryResult, Cell) – spiegelt src-tauri/src/demo_db.rs
  app/core/theme/              Farbschemata: tokens.ts (Katalog), themes/*.json, theme-logic.ts (rein),
                               ThemeService (Root: Auswahl, Vorschau, eigene Schemata), ThemeApi (themes.json),
                               contrast-pairs.json
  app/features/editor/         SqlEditor (<editlicious-editor scheme="none">), editlicious.ts (Laden),
                               editor-colors.ts (Farben des Editors aus unseren Tokens),
                               sql-split.ts (rein: Anweisung unter dem Cursor)
  app/features/results/        ResultGrid (GuiExpert Table), result-model.ts (rein: Spalten, Breiten, Modell)
  app/features/shell/          QuerySession (Root: letzte Anweisung und ihr Ausgang), statusText
  app/features/themes/         Farbschema-Galerie (ThemePicker, ThemeThumb, theme-picker-logic.ts),
                               Schema-Editor (ThemeEditor, theme-editor-logic.ts rein: Ids, Import, Kontrast)
  app/shared/                  Splitter (+ splitter-logic.ts)
  testing/fake-apis.ts         Fake-Fassaden für Tests
src-tauri/                     Rust
  src/lib.rs                   Builder: Plugins (store, window-state), State, Commands
  src/commands.rs              dünne Command-Schicht (run_demo_query, set_window_chrome, *_themes, *_theme)
  src/themes.rs                eigene Farbschemata: themes.json, Grenzen, Import/Export (rein, getestet)
  src/demo_db.rs               Demo-Datenbank (rein, getestet) – wird durch echte Verbindungen ersetzt
  src/error.rs                 AppError { code, message }
  capabilities/default.json    minimale Rechte (core:default, store:default, dialog:allow-open/-save)
  tauri.conf.json              Fenster, CSP, Bundle (Version aus package.json)
scripts/                       check-contrast.mjs + theme-lib.mjs, version.mjs, csp-preview.mjs (+ Tests)
docs/                          architecture.md, best-practices.md, themes.md, feature-analysis.md, roadmap.md
prompts/                       000-arbeitsweise.md, README.md (Index), offene Prompts; erledigte unter done/
public/                        icon.svg (Quelle der App-Icons: `pnpm tauri icon public/icon.svg`), favicon.png
```

## 4. Architekturregeln (verbindlich)

Ausführlich in **`docs/best-practices.md`** – vor jeder Änderung lesen. Die wichtigsten:

- **Frontend ruft das Backend nur über typisierte Fassaden** (`*Api` in `app/core/`), nie `invoke()` direkt.
- **DTO- und Fehlervertrag** Rust ↔ TypeScript von Hand synchron, mit Test auf beiden Seiten.
- **Commands nie synchron** (`#[tauri::command(async)]` oder `async fn`); Blockierendes nie auf dem
  Async-Runtime-Thread; lange Arbeit mit Fortschritt und Abbruch.
- **Reine Logik in eigenen Dateien** (Rust-Module ohne Tauri, TS ohne Angular), Tests daneben.
- **Zustand in Signals**, Stores je Instanz ohne `providedIn`, Globales in Root-Services; veraltete Antworten verwerfen.
- **Farben nur als Tokens**; jeder Token in dark und light, im Katalog und in den Kontrastpaaren.
- **Sicherheit**: schmale Commands statt breiter Plugins, strikte CSP, Geheimnisse nur im Schlüsselbund, SQL und
  Ergebnisse nie loggen, eigene Werte immer als gebundene Parameter.
- **Neue Abhängigkeiten** nur mit Begründung in `docs/architecture.md`. Keine UI-Frameworks, kein SCSS.

## 5. editlicious und GuiExpert Table

- **editlicious** kommt als npm-Paket `editlicious-editor` (Web Component, Engine als WebAssembly im Worker). Es wird
  **nicht gebündelt**: `angular.json` kopiert `*.js`/`*.wasm` nach `/editlicious/`, `features/editor/editlicious.ts`
  lädt das Modul bei Bedarf. Das Element legt sich selbst aus (`:host { display: flex }`) – **`display` von außen
  nicht überschreiben**, nur die Größe setzen. Quellcode: `../editlicious` (`packages/editlicious-editor/README.md`).
  Fehlt dem Editor etwas (z. B. Auswahl als Text, Vervollständigung von außen, Markierungen), wird es dort ergänzt
  und veröffentlicht, nicht hier umgangen.
- **GuiExpert Table – zwei Fallen**: `defaultRowHeights` wirkt nur, wenn die Optionen auch an
  `TableFactory.createTableModel({ tableOptions })` gehen; Zellen sind von Haus aus zentriert mit Zeilenhöhe 2.5
  (`ge-table-text-align-left` setzen, `line-height` in `ge-table-theme.css`).
- **GuiExpert Table**: `@guiexpert/table` + `@guiexpert/angular-table` (`<guiexpert-table-signal>`). Anleitung für
  KI-Assistenten: `../video/2026/guiexpert-table/mono/llms.txt` und `instructions.md` – **zuerst dort nachlesen**,
  nichts erfinden (auch die falsch geschriebenen Namen stimmen). Ein neues Modell baut die Tabelle neu auf; Daten
  ändert man über die `TableApi`. Lücken der Tabelle als Vorschlag fürs Mono-Repo notieren.

## 6. Tests & Verifikation

- `pnpm check` ist grün, bevor etwas fertig heißt. Rust-Tests neben dem Code, Vitest-Specs neben dem Code.
- GuiExpert Table und Editor rendern in jsdom nur eingeschränkt: Logik in reinen Dateien testen, Verhalten im echten
  Fenster prüfen (`pnpm tauri dev`).
- Den Editor unter der Produktions-CSP prüfen (Worker, WebAssembly), wenn sich CSP oder Einbindung ändern:
  `pnpm build && pnpm preview:csp`.
- Jeder Bugfix bekommt zuerst einen roten Test.

## 7. Git & Zusammenarbeit

- Pro Prompt ein Branch `feat/<slug>` von `main`, Commits nach jeder grünen Phase (Conventional Commits).
- Kein Push, kein Force-Push, kein `git reset --hard`, keine Releases ohne ausdrückliche Anweisung.
- README und `docs/` bei relevanten Änderungen mitpflegen; `prompts/README.md` führt den Status.

## 8. Lizenzen

- Eigene Lizenz: **MIT**. editlicious-editor: MIT. GuiExpert Table: MIT (aktuelle Releases).
- Farbschemata: nur Farbwerte nach bekannten Editor-Themes, Herkunft in `files-and-folders-tauri/docs/themes.md`.
