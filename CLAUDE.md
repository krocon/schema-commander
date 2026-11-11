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
  der Editor folgt jedem Schema; **Aktionssystem** mit Keymap je OS, Befehlspalette (`Mod+Shift+P`) und
  Kürzel-Editor (Prompt 002); **Verbindungen** zu PostgreSQL, MySQL/MariaDB, SQL Server und SQLite-Dateien mit
  Profilen, Ordnern, Farbmarken und Passwörtern im Schlüsselbund (Prompt 003); **Abfrage-Tabs** mit eigener
  Verbindung, laufender Sicherung des Textes, Wiederherstellung nach Neustart und `.sql`-Dateien (Prompt 004);
  **Ausführen** von Auswahl, Anweisung oder ganzem Skript je Dialekt, mit Ergebnis-Reitern, Meldungen,
  Abbruch auf dem Server und Zeitlimit (Prompt 005); **große Ergebnisse** bleiben in Rust (Speicher, darüber
  Datei), das Gitter holt nur den sichtbaren Ausschnitt (Prompt 006); **Zellen** je Art dargestellt (NULL, leer,
  Zahl, Bool, Binär), entschärft, mit Typ im Spaltenkopf und Bereichsauswahl (Prompt 007); **Schema-Baum** der aktiven Verbindung mit Filter, Aktionen am
  Knoten und Quoting je Dialekt (Prompt 008); **Kopieren als** TSV, CSV, JSON, Markdown, HTML, INSERT, IN, WHERE
  aus dem Gitter, geschrieben von Rust (Prompt 009); **Verlauf** aller Anweisungen mit Suche, abschaltbar und
  endgültig löschbar (Prompt 010); **Export** in Dateien (CSV, TSV, JSON, NDJSON, INSERT, Markdown, HTML,
  Excel, gzip) als Job mit Fortschritt und Abbruch (Prompt 011); **Schutz für Produktion**: Schutzstufen je
  Verbindung, Einstufung der Anweisungen und Bestätigung im Backend (Prompt 012); **Transaktionen**: Sitzung je
  Tab, Zustand vom Server, Auto-Commit oder manuell, Commit/Rollback, Frage beim Schließen (Prompt 013);
  **SSH-Tunnel** (Agent, Schlüssel, Passwort; Host-Schlüssel gegen `known_hosts`) und **TLS-Modi** mit eigener CA und
  Client-Zertifikat (Prompt 014); **Verbindung aus URL** und **Import** aus DBeaver, DataGrip, `.pgpass`,
  `pg_service.conf`, `.my.cnf`, Umgebung; eigener Export (Prompt 015);
  Einstellungen und Fensterzustand bleiben über einen Neustart.
- **Noch nichts davon**: Bearbeiten, Import. Alle Features aus
  `docs/feature-analysis.md` sind freigegeben; die Prompts 002–049 liegen in `prompts/` (Nummer = Reihenfolge,
  erledigt: 001–015),
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
| Treiber gegen echte Server | `sh scripts/db-test-servers.sh up` (Docker: PostgreSQL, MySQL, MariaDB, SQL Server auf 127.0.0.1), `pnpm rust:test:db`, danach `sh scripts/db-test-servers.sh down` |
| Alles prüfen | `pnpm check` |
| Produktions-Build unter CSP | `pnpm build && pnpm preview:csp` → http://localhost:1461 (ohne Backend; prüft Editor-Worker, WebAssembly, Styles) |
| Debug-Build ohne Paket | `pnpm tauri build --debug --no-bundle` → `src-tauri/target/debug/schema-commander` |

Nicht ausführbare Checks im Abschlussbericht mit Grund nennen.

## 3. Layout

```
src/                           Angular 22 (zoneless, Signals, Standalone)
  styles.css                   Design-Tokens (@theme dark / light), Grundstile – einzige Stelle für Farben
  styles/ge-table-theme.css    Brücke Tokens → --ge-table-* der GuiExpert Table
  app/app.ts, app.css          Fenster: Toolbar, Seitenleiste, Tab-Leiste, Tabs, Statuszeile; registriert Aktionen
  app/app.config.ts            Provider: *Api-Fassaden → Tauri-Implementierungen
  app/core/actions/            Aktionen: action-catalog.ts (Ids, Namen, Bereich), keymaps/*.json (je OS),
                               keymap.ts (Vorgabe + eigene Belegung, Reserviertes), shortcut.ts (Notation),
                               keyboard-dispatcher.ts (der eine keydown-Handler), ActionService (Root)
  app/core/backend/            call.ts (einzige Stelle mit invoke()), WindowApi (set_window_chrome),
                               FileDialogApi (native Öffnen-/Speichern-Dialoge: einzige Quelle für Pfade),
                               ClipboardApi (copy_result, copy_text: die Zwischenablage gehört Rust),
                               ExportApi (export_result, export_query, cancel_job, reveal_export)
  app/core/connections/        Profile (Modell), ConnectionsApi, ConnectionsStore (Root: Profile, Zustände, aktive
                               Verbindung, Passwortabfrage)
  app/core/errors/             AppError + toAppError (spiegelt src-tauri/src/error.rs)
  app/core/history/            HistoryApi (history_*) + DTOs – spiegelt history.rs
  app/core/schema/             SchemaApi (meta_*) + DTOs (SchemaInfo, ObjectInfo, TableInfo) – spiegelt db/meta.rs
  app/core/session/            SessionApi: session.json, Texte der Tabs, .sql lesen/schreiben
  app/core/settings/           Settings (Modell, mergeSettings), SettingsService (tauri-plugin-store)
  app/core/sql/                QueryApi (run mit Ereignissen, window, free, cancel) + DTOs (ResultRef, RunEvent, Cell, ColKind) – spiegelt db/value.rs
  app/core/theme/              Farbschemata: tokens.ts (Katalog), themes/*.json, theme-logic.ts (rein),
                               ThemeService (Root: Auswahl, Vorschau, eigene Schemata), ThemeApi (themes.json),
                               contrast-pairs.json
  app/features/connections/    Verbindungsliste (Seitenleiste), Verbindungsdialog, Passwortabfrage,
                               connection-logic.ts (rein: Gruppen, Prüfung, Vorschläge)
  app/features/editor/         SqlEditor (<editlicious-editor scheme="none">), editlicious.ts (Laden),
                               editor-colors.ts (Farben des Editors aus unseren Tokens),
                               sql-split.ts (rein: Skripte je Dialekt zerlegen, Katalog sql-split.cases.json)
  app/features/export/         ExportDialog, ExportService (Root: ein Job, Statuszeile), export-logic.ts (rein)
  app/features/guard/          GuardDialog (Rückfrage), GuardService, guard-logic.ts (rein)
  app/features/history/        HistoryDialog (Listbox, Vorschau), HistoryService (Root: aufzeichnen, blättern),
                               history-logic.ts (rein)
  app/features/palette/        Befehlspalette (CommandPalette, palette-logic.ts rein: unscharfe Suche)
  app/features/schema/         SchemaTree (virtuelle Liste, APG-Baum), SchemaStore (Root: Zustand je Verbindung),
                               SchemaActions, schema-logic.ts (rein: Zeilen, Filter, Tasten, Vorlagen)
  app/features/shortcuts/      Kürzel-Editor und -Übersicht (ShortcutDialog, shortcut-logic.ts)
  app/features/results/        ResultGrid (GuiExpert Table), result-model.ts (rein: Spalten, Breiten,
                               WindowAreaModel mit Seiten-Cache), cell-format.ts (rein: Zelle → Text + Klasse,
                               entschärfen, kürzen; Katalog cell-format.cases.json), CopyService (Root) +
                               copy-logic.ts (rein: Auswahl → Zeilen/Spalten, Formate)
  app/features/tabs/           TabsStore (Root: Tabs, Sicherung, Dateien), QueryTab (Tab mit Ausführung, kein
                               Injectable), QueryPane (Editor + Ergebnis eines Tabs), TabBar,
                               tab-logic.ts (rein: Titel, Ids, Reihenfolge), run-state.ts (Läufe, Meldungen,
                               Statuszeile), tx-logic.ts (rein: Texte zur Transaktion)
  app/features/themes/         Farbschema-Galerie (ThemePicker, ThemeThumb, theme-picker-logic.ts),
                               Schema-Editor (ThemeEditor, theme-editor-logic.ts rein: Ids, Import, Kontrast)
  app/shared/                  Splitter (+ splitter-logic.ts), ContextMenu (APG-Menü), confirm.ts (Rückfrage)
  testing/fake-apis.ts         Fake-Fassaden für Tests
src-tauri/                     Rust
  src/lib.rs                   Builder: Plugins (store, window-state), State, Commands
  src/commands.rs              dünne Command-Schicht (Verbindungen, run_query, cancel_query, Fenster, Farbschemata)
  src/session.rs               Sitzung der Tabs: session.json + tabs/<id>.sql (rein, getestet)
  src/textfile.rs              .sql lesen/schreiben mit Kodierung (UTF-8/-BOM, UTF-16, Windows-1252)
  src/menu.rs                  macOS-Menü ohne Cmd+W (das volle Menü: Prompt 018)
  src/db/mod.rs                Profile, DbKind, TlsMode, Session-Trait, Laufzeit, Fehler in Worten
  src/db/{pg,mysql,mssql,sqlite}.rs  die Treiber; sqlite.rs auch die Demo-Datenbank
  src/results.rs               Ergebnisspeicher: Zeilen + Offsets, Auslagern, Fenster, Grenzen, StoreSink (rein, getestet)
  src/history.rs               Verlauf: history.sqlite, Suche, Aufbewahrung, endgültiges Löschen (rein, getestet)
  src/export.rs                Dateien schreiben: FileWriter (Text, gzip, xlsx), from_store, FileSink (rein, getestet)
  src/ssh/                     SSH-Tunnel: mod.rs (russh-Client, Anmeldung, Weiterleitung), trust.rs (known_hosts),
                               ssh_config.rs (~/.ssh/config, nie ausgeführt) – trust/ssh_config wie in log-commander
  src/extract.rs               Formate (TSV, CSV, JSON, Markdown, HTML, INSERT, IN, WHERE), Literale je Dialekt (rein)
  src/copy.rs                  Auswahl eines Ergebnisses als Text: Zeilenbereiche, Spalten, Abbruch, Grenze (rein)
  src/db/import.rs             Verbindungs-URLs und fremde Dateien lesen (rein, Katalog), eigener Export
  src/db/guard.rs              Anweisungen einstufen (lesend/schreibend/DDL/gefährlich), Schutzstufen (rein, Katalog)
  src/db/meta.rs               Metadaten aus dem Systemkatalog (gebundene Parameter), quote() je Dialekt
  src/db/value.rs              Cell, ColKind, QueryResult (verlustfrei über die Brücke)
  src/db/manager.rs            ConnectionManager: Sitzungen, Schlüsselbund-Regeln, Abbruch
  src/db/profiles.rs           connections.json (nie ein Geheimnis); db/secrets.rs: Secret, Schlüsselbund
  tests/db_integration.rs      Treiber gegen echte Server (ignoriert; pnpm rust:test:db)
  src/themes.rs                eigene Farbschemata: themes.json, Grenzen, Import/Export (rein, getestet)
  src/error.rs                 AppError { code, message }
  capabilities/default.json    minimale Rechte (core:default, store:default, dialog:allow-open/-save)
  tauri.conf.json              Fenster, CSP, Bundle (Version aus package.json)
scripts/                       check-contrast.mjs + theme-lib.mjs, version.mjs, csp-preview.mjs (+ Tests),
                               db-test-servers.sh (Container für die Treibertests)
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
- **Jede Funktion ist eine Aktion**: Id in `core/actions/action-catalog.ts`, Kürzel nur in `keymaps/*.json`,
  Handler per `ActionService.register`. Keine eigenen `keydown`-Handler für Funktionen (Ausnahmen: Widgets nach
  APG – Dialoge, Listen, Menüs, Splitter). Die Tasten des Editors (`Mod+C/V/X/A/Z`, `Mod+F`, `F3`,
  `Strg+Leertaste`) sind reserviert; einfache Tasten und AltGr-Zeichen erreichen im Editor nie eine Aktion.
- **Sitzungen**: Jeder Tab läuft auf seiner eigenen Sitzung (`session` = Tab-Id am Command); die Sitzung der
  Verbindung gehört der App. Ob eine Transaktion offen ist, sagt der Server (`TxState`), nie eine Annahme.
- **Tabs**: Ein Tab ist ein `QueryTab` (per Id adressiert), sein Editor bleibt in der Seite, auch wenn er nicht
  vorn ist. Der Text eines Tabs wird nie bei jedem Tastendruck über die Brücke geschickt: `TabsStore.textChanged`
  plant die Sicherung, die den Text einmal holt. Nichts fragt „Speichern?“.
- **Bezeichner** quotet nur `meta::quote` in Rust; Knoten und DTOs bringen `quoted` mit. Katalogabfragen nur über
  `Session::ask` mit gebundenen Parametern.
- **Schutz**: Was SQL ausführt, ruft im Backend `ConnectionManager::admit`; das Fenster fragt nur, entscheidet nie.
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
