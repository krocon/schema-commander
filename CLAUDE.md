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
  `pg_service.conf`, `.my.cnf`, Umgebung; eigener Export (Prompt 015); **Arbeitsbereich**: zwei Tab-Gruppen
  (neben- oder übereinander), Ergebnis unten/rechts/aus/maximiert, Seitenleiste mit Ansichten Datenbank und
  Verlauf, Zen, Gruppen und Cursor in der Sitzung (Prompt 016); **Sprache** Englisch/Deutsch zur Laufzeit
  (Text-Kataloge) und **Einstellungsdialog** mit Suche, Zurücksetzen, Export/Import (Prompt 017);
  **Menüleiste** (macOS nativ, sonst im Fenster) und **Kontextmenüs** aus einem Menümodell (Prompt 018);
  **Objekt-Details** (Spalten, Indizes, Constraints, Beziehungen, Rechte, Statistik) und **DDL** je Objekt
  (Prompt 019); **Springen zu allem** (`Mod+P`): Tabellen, Views, Routinen, Spalten, Tabs, Verbindungen über
  einen Namensindex im Backend, in der gemeinsamen Palette (Prompt 020); **Vervollständigung**, die das Schema
  kennt: Tabellen, Spalten je Alias, JOIN aus Fremdschlüsseln, je Dialekt (Prompt 021); **Fehler an der
  Stelle**: Details der Datenbank (Code, Detail, Hinweis, Position), Markierung im Editor, laufende Anweisung
  (Prompt 022); **SQL formatieren**: Auswahl, Anweisung oder Skript als ein Undo-Schritt, Stil einstellbar mit
  Vorschau, in Rust mit Selbstprüfung der Tokens; Schlüsselwörter groß/klein, eine Zeile, Zeilenkommentar
  (Prompt 023); **gespeicherte Abfragen** als `.sql`-Dateien mit Kopfkommentar in einem wählbaren Ordner
  (Ansicht der Seitenleiste, Suche, `q:` in der Palette) und **Textbausteine** mit Platzhaltern je Dialekt
  (Prompt 024); **Parameter** (`:name`, `${name}`, `?`, `$1` …): Werte werden abgefragt, je Tab gemerkt und vom
  Treiber gebunden (Prompt 025); **Wert-Ansicht**: der ganze Wert der Zelle unter dem Cursor neben dem Gitter
  (Text, JSON/XML gesetzt, Hex, Bild, Zahl, Datum), stückweise aus dem Ergebnisspeicher (Prompt 026); **Sortieren und
  Filtern**: Tabellen-Ansicht mit Filterzeile und `ORDER BY` auf dem Server (Werte gebunden), jedes andere
  Ergebnis als Sicht im Ergebnisspeicher (Prompt 027); **Auswahl auswerten**: Anzahl, Summe, Mittel, Min, Max
  der markierten Zellen in der Statuszeile, exakt gerechnet in Rust; Spalte zusammenfassen mit den häufigsten
  Werten (Prompt 028); **Spalten** fixieren, ausblenden, verschieben, Breiten merken (je Tabelle bzw. Tab),
  Spaltenliste mit Sprung; **Suche im Ergebnis** (Text, Wort, Regex, je Spalte) in Rust mit Treffer-Sprung,
  Gehe zu Zeile, nächster anderer Wert / nächstes NULL (Prompt 029); **Fremdschlüsseln folgen** in
  Tabellen-Ansichten: zur referenzierten Zeile (im Tab, neuer Tab, Vorschau), „wird referenziert von“ mit
  Anzahl, mehrere Zeilen, Pfad mit Zurück/Vor, eigene Beziehungen (Prompt 030); **Daten bearbeiten**:
  Zellen einer Tabellen-Ansicht ändern, Änderungen sammeln (farbig, Undo/Redo), als SQL ansehen und gemeinsam
  in einer Transaktion schreiben – mit Sperre gegen Änderungen anderer (Prompt 031); **Zeilen**: einfügen,
  duplizieren, zum Löschen vormerken, Zellblock aus der Zwischenablage einfügen, nach unten füllen – ein Plan,
  geschrieben als Löschen → Ändern → Einfügen (Prompt 032); **Import** einer Datei (CSV/TSV, JSON, NDJSON, gzip)
  in eine vorhandene oder neue Tabelle: Vorschau, Zuordnung, gebundene Stapel-`INSERT`s, Fehlerdatei, als Job
  (Prompt 033); **Release** vorbereitet: Workflow für Pakete je System, Lizenzhinweise, About-Dialog (Prompt 034);
  **CockroachDB und TimescaleDB** über den PostgreSQL-Treiber, Fähigkeits-Flags je Verbindung (Prompt 035a),
  ebenso **YugabyteDB** (Prompt 035e);
  **Oracle** über den reinen Rust-Treiber `oracledb` (ohne Instant Client): verbinden, ausführen, Baum, Details,
  Tabellen-Ansicht, Bearbeiten, Suche; Plan, Monitor, Rechte und Struktur noch nicht (Prompt 035b);
  **DuckDB** eingebettet (Datei oder `:memory:`, Parquet/CSV/JSON ohne Nachladen), alle Tabs eines Profils auf
  einer Datenbank (Prompt 035c);
  **ClickHouse** über HTTP zum Lesen und Auswerten: ausführen, Baum, Details, Tabellen-Ansicht, Suche – ohne
  Bearbeiten, Import und Kopieren (Prompt 035d);
  **Trino und Presto** über HTTP zum Lesen und Auswerten, ein Profil je Katalog: ausführen, Baum, Details,
  Tabellen-Ansicht, Suche, nur lesende Sitzung – ohne Bearbeiten, Import und Kopieren (Prompt 035f);
  **Suche auf dem Server**: ein Text in den Zeilen aller Tabellen und in Definitionen, als lesender Job (Prompt 036);
  **ER-Diagramm** eines Schemas oder einer Tabelle mit Nachbarn: eigene Anordnung, verschiebbar, Listenansicht,
  Export als SVG, Mermaid, DBML (Prompt 037);
  **Schema-Vergleich**: zwei Schemata oder Schnappschüsse, Unterschiede, Migrationsskript als Vorschlag mit
  auskommentierten gefährlichen Schritten (Prompt 038);
  **Ausführungsplan** als Baumtabelle für alle Datenbanken, geschätzt oder mit Ausführung (zurückgerollt), mit
  Hinweisen (Prompt 039);
  **Zeile als Formular** neben dem Gitter, mit Filter über Spaltennamen und markierten Zeilen nebeneinander
  (Prompt 040);
  **Ergebnisse** als Unter-Reiter mit Titel und Zeilenzahl, **anpinnen**, ablösen in einen eigenen Tab,
  **zwei Ergebnisse vergleichen** (Schlüssel oder Position, Toleranzen) in Rust über den Ergebnisspeicher
  (Prompt 041);
  **Diagramm** aus dem Ergebnis (Linie, Balken, Punktwolke): aufbereitet und ausgedünnt in Rust, gezeichnet
  als SVG in den Farben des Schemas, mit Zoom, Tooltip und Legende (Prompt 042);
  **Struktur bearbeiten**: Spalten, Indizes, Schlüssel und Checks einer Tabelle als Formular, Vorschau der
  Anweisungen mit markierten Gefahren, Ausführen in einer Transaktion; neue Tabelle, duplizieren, leeren, löschen;
  Definition von Views und Routinen im Editor (Prompt 043);
  **Sichern und Wiederherstellen** mit den Werkzeugen der Datenbank (`pg_dump`, `pg_restore`, `psql`,
  `mysqldump`, `mysql`) als Job ohne Shell, SQLite-Kopie, einfacher SQL-Export ohne Werkzeuge (Prompt 044);
  **Tabellen zwischen Verbindungen kopieren**, auch über Datenbanktypen hinweg: als Strom, mit Typabbildung
  und genannten Verlusten, in der Reihenfolge der Fremdschlüssel (Prompt 045);
  **Server-Monitor**: Sitzungen und laufende Anweisungen, wer wen blockiert, Kennzahlen; auffrischen im Takt,
  Anweisung abbrechen oder Sitzung beenden nach Rückfrage (Prompt 046);
  **Benutzer und Rechte**: Benutzer, Rollen, Mitgliedschaften und Rechte mit Herkunft (selbst, über Rolle),
  Matrix Tabellen × Rechte, Änderungen gesammelt als Anweisungen mit markierten Gefahren; Passwort nie in
  Vorschau, Verlauf oder Log (Prompt 047);
  **KI-Steuerung über MCP** (standardmäßig aus): Sidecar `schema-commander-mcp` + Brücke auf 127.0.0.1 mit
  Token; Freigabe je Verbindung (aus, Struktur, lesen, Schreiben als Vorschlag), Grenzen für Zeilen, Zeichen
  und versteckte Spalten, Protokoll, Vorschlagsdialog (Prompt 048, `docs/mcp.md`);
  **Testdaten erzeugen**: je Spalte ein Generator (vorgeschlagen aus Typ, Schlüssel, Name), wiederholbar über
  einen Startwert, eindeutig ohne zu merken, Fremdschlüssel aus vorhandenen Zeilen; Vorschau, Schreiben als Job
  über den Lader des Imports oder als CSV/INSERT-Datei (Prompt 049);
  Einstellungen und Fensterzustand bleiben über einen Neustart.
- Alle Features aus
  `docs/feature-analysis.md` sind freigegeben; die Prompts 002–049 liegen in `prompts/` (Nummer = Reihenfolge,
  erledigt: 001–034, 035a–035f, 036–049; von 035 offen: libSQL/Turso, D1, Firebird, BigQuery, Snowflake, Db2),
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
| Lizenzhinweise | `pnpm notices` (schreibt `THIRD-PARTY-NOTICES.txt`; nach jeder Änderung an Abhängigkeiten), `pnpm notices:check` |
| Release-Notizen | `pnpm release:notes` (Conventional Commits seit dem letzten Tag); Ablauf in `docs/release.md` |
| MCP-Sidecar | `pnpm mcp:dev` (Debug-Sidecar neben die Debug-App), `node scripts/mcp-sidecar.mjs [Ziel]` (für ein Paket, mit `--config src-tauri/tauri.sidecar.conf.json`) |
| Treiber gegen echte Server | `sh scripts/db-test-servers.sh up` (Docker: PostgreSQL, MySQL, MariaDB, SQL Server, CockroachDB, TimescaleDB, Oracle Free, ClickHouse, Trino auf 127.0.0.1; `SC_DBTEST_ORACLE=0` lässt Oracle weg, `SC_DBTEST_YUGABYTE=1` nimmt YugabyteDB dazu, `SC_DBTEST_PRESTO=1` Presto), `pnpm rust:test:db`, danach `sh scripts/db-test-servers.sh down` |
| Texte | `pnpm texts` (kein Text im Template, kein Deutsch außerhalb von `*.de.ts`) |
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
  app/core/about/              AboutApi (app_info, third_party_notices) – spiegelt about.rs
  app/core/access/             AccessApi (access_list, access_grants, access_plan, access_script, access_apply) –
                               spiegelt db/access.rs
  app/core/actions/            Aktionen: action-catalog.ts (Ids, Namen, Bereich), keymaps/*.json (je OS),
                               keymap.ts (Vorgabe + eigene Belegung, Reserviertes), shortcut.ts (Notation),
                               keyboard-dispatcher.ts (der eine keydown-Handler), ActionService (Root)
  app/core/backend/            call.ts (einzige Stelle mit invoke()), WindowApi (set_window_chrome),
                               FileDialogApi (native Öffnen-/Speichern-Dialoge: einzige Quelle für Pfade),
                               ClipboardApi (copy_result, copy_text: die Zwischenablage gehört Rust),
                               ExportApi (export_result, export_query, cancel_job, reveal_export)
  app/core/backup/             BackupApi (backup_tools, backup_dump, backup_restore, backup_file_kind,
                               backup_sqlite, backup_simple) – spiegelt backup.rs
  app/core/chart/              ChartApi (chart_suggest, chart_prepare, chart_zoom, chart_free) – spiegelt chart.rs
  app/core/compare/            CompareApi (schema_snapshot, schema_compare, schema_script) – spiegelt db/compare.rs
  app/core/connections/        Profile (Modell), ConnectionsApi, ConnectionsStore (Root: Profile, Zustände, aktive
                               Verbindung, Passwortabfrage)
  app/core/errors/             AppError + ErrorDetails + toAppError (spiegelt src-tauri/src/error.rs), error-texts
                               (Text je Code), error-position.ts (rein: Angabe der Datenbank → Stelle im Editor,
                               Katalog error-position.cases.json)
  app/core/find/               FindApi (find_on_server, cancel_job) + DTOs – spiegelt db/find.rs
  app/core/format/             FormatApi (format_sql, cancel_job) + Stil und Modus – spiegelt format.rs
  app/core/i18n/               i18n.ts (translatable, phrasebook, language, locale), common-texts,
                               catalogs.spec.ts (jeder Katalog vollständig in beiden Sprachen)
  app/core/history/            HistoryApi (history_*) + DTOs – spiegelt history.rs
  app/core/import/             DataImportApi (load_*) + DTOs – spiegelt data_import.rs und db/load.rs
  app/core/mcp/                McpApi (mcp_subscribe, mcp_start, mcp_stop, mcp_configure, mcp_status,
                               mcp_disconnect, mcp_reply, mcp_test) – spiegelt mcp.rs und commands.rs
  app/core/menu/               MenuApi (set_app_menu, set_menu_state, subscribe_menu) + DTOs – spiegelt app_menu.rs
  app/core/saved/              SavedApi (saved_*) + DTOs – spiegelt saved.rs
  app/core/monitor/            MonitorApi (monitor_activity, monitor_kill, monitor_close) – spiegelt db/monitor.rs
  app/core/plan/               PlanApi (explain_plan) + DTOs – spiegelt db/plan.rs
  app/core/schema/             SchemaApi (meta_*) + DTOs (SchemaInfo, ObjectInfo, TableInfo) – spiegelt db/meta.rs
  app/core/session/            SessionApi: session.json, Texte der Tabs, .sql lesen/schreiben
  app/core/settings/           Settings (Modell, mergeSettings), SettingsService (tauri-plugin-store)
  app/core/sql/                QueryApi (run mit Ereignissen, window, free, cancel) + DTOs (ResultRef, RunEvent, Cell, ColKind) – spiegelt db/value.rs
  app/core/structure/          StructureApi (struct_load, struct_plan, struct_apply) + DTOs – spiegelt
                               db/structure.rs und die Tabelle aus db/compare.rs
  app/core/transfer/           TransferApi (transfer_plan, transfer_run) + DTOs – spiegelt db/transfer.rs
  app/core/testdata/           TestdataApi (testdata_suggest, _preview, _statements, _run, _export) – spiegelt
                               testdata.rs
  app/core/text/               places.ts (rein: Stelle des Editors ↔ Offset im Text; Spalten in Codepunkten)
  app/core/theme/              Farbschemata: tokens.ts (Katalog), themes/*.json, theme-logic.ts (rein),
                               ThemeService (Root: Auswahl, Vorschau, eigene Schemata), ThemeApi (themes.json),
                               contrast-pairs.json
  app/features/about/          AboutDialog, about-logic.ts (rein: Zeilen, Diagnose, WebView aus dem User-Agent)
  app/features/access/         AccessDialog (Liste, Matrix, alle Rechte, wartende Änderungen), AccessService (Root:
                               eine Verbindung, Änderungen mit Passwort daneben, Lauf durch den Schutz),
                               access-logic.ts (rein), privileges.json (die Rechte-Liste, auch von Rust gelesen)
  app/features/backup/         BackupDialog (Werkzeug, Optionen, Ausgabe des Werkzeugs), BackupService (Root: ein
                               Job), backup-logic.ts (rein: Werkzeug je Datenbank und Datei, Dateiname, Schutz)
  app/features/chart/          ChartPanel (Einstellungen, SVG, Legende, Zoom), chart-logic.ts (rein: Skalen, Ticks,
                               Linien mit Lücken, Balken, Punkt unter dem Zeiger, SVG-Datei)
  app/features/completion/     sql-lex.ts, sql-context.ts (rein: was an der Stelle passt, Katalog
                               sql-context.cases.json), suggest.ts (rein: die Liste, suggest.cases.json),
                               sql-words.ts (Wörter je Dialekt), CompletionService (Root: liest, was fehlt)
  app/features/connections/    Verbindungsliste (Seitenleiste), Verbindungsdialog, Passwortabfrage,
                               connection-logic.ts (rein: Gruppen, Prüfung, Vorschläge)
  app/features/details/        DetailsDialog (Listen als Gitter, Filter, Beziehungen, DDL), ObjectDetailsService
                               (Root: Objekt auf dem Schirm, Weg zurück), details-logic.ts (rein)
  app/features/diagram/        ErDiagramDialog (SVG, Listen daneben), DiagramService, er-model.ts (rein: Knoten,
                               Kanten, Kardinalität), er-layout.ts (rein: Schichten, Linien), er-export.ts (rein:
                               Mermaid, DBML, SVG)
  app/features/editor/         SqlEditor (<editlicious-editor scheme="none">), editlicious.ts (Laden),
                               editor-colors.ts (Farben des Editors aus unseren Tokens),
                               sql-split.ts (rein: Skripte je Dialekt zerlegen, Katalog sql-split.cases.json)
  app/features/edit/           EditService (Root: Zelle bearbeiten, Vorschau, schreiben), EditBar (Zeile über dem
                               Ergebnis), EditPreview, edit-buffer.ts (rein: Änderungspuffer mit neuen und zu
                               löschenden Zeilen, Undo als Schnappschuss, Plan, Prüfung), block-parser.ts (rein)
  app/features/data-import/    DataImportDialog (Datei, Vorschau, Ziel, Zuordnung, Bericht), DataImportService
                               (Root: ein Job, Rückfrage des Schutzes), data-import-logic.ts (rein)
  app/features/export/         ExportDialog, ExportService (Root: ein Job, Statuszeile), export-logic.ts (rein)
  app/features/filter/         FilterBar (Bedingungen der Tabellen-Ansicht, lokaler Filter), TableViews (Root:
                               Tabelle als Tabellen-Ansicht öffnen), filter-logic.ts (rein)
  app/features/find/           ResultFind (je Tab: Suche stückweise, Treffer, Sprung; kein Injectable), FindBar
                               (Suchzeile über dem Ergebnis), ColumnsPopover (Spaltenliste)
  app/features/monitor/        MonitorDialog (Kennzahlen, Sitzungen, Blockaden, Anweisung), MonitorService (Root:
                               eine Verbindung, Takt, Rückfrage vor dem Beenden), monitor-logic.ts (rein)
  app/features/plan/           PlanDialog (Baumtabelle, Einzelheiten, Hinweise, Rohplan), PlanService (Root: fragen,
                               Rückfrage vor der Ausführung), plan-logic.ts (rein)
  app/features/relations/      RelationsService (Root: Schlüssel lesen, folgen, zählen, Vorschau, eigene
                               Beziehungen), RelationsDialog, RelationPath (Pfad über dem Ergebnis),
                               relation-logic.ts (rein: Schlüsselwerte, Sichten, Pfad)
  app/features/stats/          StatsService (Root: Kennzahlen der Auswahl, gedrosselt, Überholtes verworfen),
                               StatsPopover (Spalte zusammenfassen), stats-logic.ts (rein: Kennzahlen → Anzeige)
  app/features/format/         FormatService (Root: ein Job, Statuszeile), format-logic.ts (rein: Stil,
                               Cursor nach dem Formatieren)
  app/features/guard/          GuardDialog (Rückfrage), GuardService, guard-logic.ts (rein)
  app/features/history/        HistoryDialog (Listbox, Vorschau), HistoryPanel (Ansicht der Seitenleiste),
                               HistoryService (Root: aufzeichnen, blättern), history-logic.ts (rein)
  app/features/mcp/            McpDialog (Schalter, Grenzen, Stufen, Einrichten, Protokoll), McpProposalDialog,
                               McpService (Root: ein/aus, Regeln ans Backend, Vorschläge), mcp-logic.ts (rein)
  app/features/menus/          menu-model.ts (rein: Menüs aus Aktions-Ids → Fenster / native Spec), MenuService
                               (Root: Menüleiste, Kontextmenü), MenuBar (APG-Menubar für Windows/Linux)
  app/features/palette/        die eine Palette: Befehle und „Springen zu allem“ (CommandPalette), palette-logic.ts
                               und goto-logic.ts (rein), GotoService (führt einen Treffer aus)
  app/features/saved/          SavedPanel (Ansicht der Seitenleiste, APG-Baum), SavedDialog, SavedStore (Root:
                               Listing, beobachten, öffnen als Datei-Tab), saved-logic.ts (rein)
  app/features/snippets/       SnippetDialog, snippet-logic.ts (rein: mitgelieferte je Dialekt, Variablen)
  app/features/result-compare/ ResultCompareDialog, CompareBar (Zeile über dem Vergleich), ResultCompareService
                               (Root: Dialog, „erneut ausführen und vergleichen“), compare-view-logic.ts (rein)
  app/features/row-form/       RowForm (Seitenfeld: Zeile des Cursors als Felder, Zeilen nebeneinander),
                               row-form-logic.ts (rein)
  app/features/schema/         SchemaTree (virtuelle Liste, APG-Baum), SchemaStore (Root: Zustand je Verbindung),
                               SchemaActions, schema-logic.ts (rein: Zeilen, Filter, Tasten, Vorlagen)
  app/features/schema-compare/ SchemaCompareDialog (zwei Seiten, Liste, Definitionen nebeneinander), compare-logic.ts
                               (rein: Filter, zeilenweiser Vergleich, Bericht, Umbenennungen)
  app/features/server-search/  ServerSearchDialog (Suche, Treffer als Listen), ServerSearchService (Root: ein Job,
                               Treffer öffnen), server-search-logic.ts (rein)
  app/features/settings/       SettingsDialog (Gruppen, Suche, Zurücksetzen, Export/Import), settings-logic.ts
                               (rein: Schema des Dialogs, Suche, Datei)
  app/features/shortcuts/      Kürzel-Editor und -Übersicht (ShortcutDialog, shortcut-logic.ts)
  app/features/params/         param-logic.ts (rein: Parameter finden, Typen, umschreiben je Dialekt, Katalog),
                               ParamService (Root: die Frage), ParamDialog
  app/features/results/        ResultGrid (GuiExpert Table), result-model.ts (rein: Spalten, Breiten,
                               WindowAreaModel mit Seiten-Cache), cell-format.ts (rein: Zelle → Text + Klasse,
                               entschärfen, kürzen; Katalog cell-format.cases.json), CopyService (Root) +
                               copy-logic.ts (rein: Auswahl → Zeilen/Spalten, Formate), column-layout.ts (rein:
                               Reihenfolge, versteckt, fixiert, Breiten; zusammenführen), ColumnLayouts (Root)
  app/features/tabs/           TabsStore (Root: Tabs, Sicherung, Dateien), QueryTab (Tab mit Ausführung, kein
                               Injectable), QueryPane (Editor + Ergebnis eines Tabs), TabBar,
                               tab-logic.ts (rein: Titel, Ids, Reihenfolge), layout-logic.ts (rein: zwei
                               Gruppen – teilen, verschieben, schließen, reparieren), run-state.ts (Läufe, Meldungen,
                               Statuszeile), tx-logic.ts (rein: Texte zur Transaktion), result-tabs-logic.ts
                               (rein: Unter-Reiter, gehaltene Ergebnisse)
  app/features/structure/      StructureDialog (Formular, Vorschau, Ausführen), StructureService (Root: Dialog,
                               Lauf durch den Schutz, danach auffrischen), structure-logic.ts (rein: Formular ⇄
                               Tabelle, Operationen, Prüfung, Skript)
  app/features/transfer/       TransferDialog (Quelle, Ziel, Vorschau, Lauf, Bericht), TransferService (Root: ein
                               Job, Schutz des Ziels), transfer-logic.ts (rein)
  app/features/testdata/       TestdataDialog (Generator je Spalte, Vorschau), TestdataService (Root: ein Job,
                               Schutz, Datei, Vorlagen), testdata-logic.ts (rein: Felder der Generatoren, Vorlagen)
  app/features/themes/         Farbschema-Galerie (ThemePicker, ThemeThumb, theme-picker-logic.ts),
                               Schema-Editor (ThemeEditor, theme-editor-logic.ts rein: Ids, Import, Kontrast)
  app/features/value/          ValuePanel (neben dem Gitter, <editlicious-editor readonly>), ValueService (Root:
                               Zelle des Cursors, kopieren, speichern), value-logic.ts (rein: Ansichten, JSON/XML
                               setzen ohne zu parsen, Hex, Bildgrenzen)
  app/shared/                  Splitter (+ splitter-logic.ts), ContextMenu (APG-Menü), confirm.ts (Rückfrage)
  testing/fake-apis.ts         Fake-Fassaden für Tests
src-tauri/                     Rust
  src/lib.rs                   Builder: Plugins (store, window-state), State, Commands
  src/commands.rs              dünne Command-Schicht (Verbindungen, run_query, cancel_query, Fenster, Farbschemata)
  src/about.rs                 Angaben für den About-Dialog, Ort der Lizenzhinweise (rein, getestet)
  src/session.rs               Sitzung der Tabs: session.json + tabs/<id>.sql (rein, getestet)
  src/textfile.rs              .sql lesen/schreiben mit Kodierung (UTF-8/-BOM, UTF-16, Windows-1252)
  src/mcp.rs                   KI-Steuerung, die Seite der App: Stufen je Verbindung, die Werkzeuge, lesende
                               Sitzung, Grenzen der Antwort (`shape`), Vorschläge ans Fenster (ohne Tauri;
                               mcp_tests.rs gegen die Demo-Datenbank)
  mcp/                         Crate `sc-mcp`: Sidecar `schema-commander-mcp` (MCP über stdio) und die Brücke
                               (bridge, client, server, host, probe, tools) – nur std und serde
  src/menu.rs                  das Menü von macOS, solange das Fenster lädt (ohne Cmd+W)
  src/app_menu.rs              native Menüleiste aus der MenuSpec des Fensters: Prüfung, Beschleuniger (rein, getestet)
  src/db/mod.rs                Profile, DbKind, TlsMode, Session-Trait, Flavor und Capabilities (wer antwortet, was
                               er kann), Laufzeit, Fehler in Worten
  src/db/{pg,mysql,mssql,sqlite}.rs  die Treiber; sqlite.rs auch die Demo-Datenbank
  src/db/clickhouse.rs         ClickHouse über HTTP (`ureq`): eine Anfrage je Anweisung, Zeilen als Text, Abbruch
                               über KILL QUERY, Sitzung = session_id
  src/db/trino.rs              Trino/Presto über HTTP: Antwort seitenweise (`nextUri`, nur der Pfad), Abbruch durch
                               Löschen der nächsten Seite, Sitzung aus den Kopfzeilen, Werte als geprüfte Literale
  src/db/http.rs               was die HTTP-Treiber teilen: Client mit dem TLS des Profils, Adresse, Kodierung
  src/db/duckdb.rs             DuckDB eingebettet: eine geteilte Datenbank je Profil, Typen (Listen, Structs),
                               Abbruch, Transaktionszustand aus den Anweisungen; Tests ohne Server (duckdb_tests.rs)
  src/db/oracle.rs             Oracle über `oracledb`: Verbindung auf eigenem Thread, Auto-Commit, Typen, Fehler
                               mit Stelle; ein Abbruch kostet die Verbindung
  src/results.rs               Ergebnisspeicher: Zeilen + Offsets, Auslagern, Fenster, Grenzen, StoreSink; ganze Werte
                               getrennt (`<id>.values`) und stückweise (`value`) (rein, getestet)
  src/backup.rs                Sichern/Wiederherstellen: Werkzeuge finden, Argumente ohne Shell, Passwort nie als
                               Argument, Lauf als Prozess mit Abbruch und Aufräumen, Dateiart, einfacher Export
                               (rein bis auf Prozess und Platte; backup_tests.rs mit echten Prozessen)
  src/chart.rs                 Diagramm aus einem Ergebnis: Vorschlag aus den Spaltentypen, Aufbereiten
                               (Kategorien aggregiert, Linien nach X sortiert), Ausdünnen auf Pixelbreite ohne
                               Spitzen zu verlieren, Zwischenspeicher der letzten Diagramme (rein; chart_tests.rs)
  src/result_compare.rs        zwei Ergebnisse vergleichen: Spalten paaren, Schlüssel oder Position, Toleranzen,
                               doppelte Schlüssel; schreibt ein Ergebnis und eine Sicht der Unterschiede (rein;
                               Tests result_compare_tests.rs, auch 1 Mio. Zeilen)
  src/image_info.rs            Bildformat und Maße aus den ersten Bytes, nie dekodiert (rein, getestet)
  src/search.rs                Suche im Ergebnisspeicher: Regex mit Grenzen, stückweise; nächster anderer Wert,
                               nächstes NULL (rein, getestet)
  src/stats.rs                 Kennzahlen einer Auswahl über den Ergebnisspeicher: exakte Dezimalsumme (`Dec`),
                               Min/Max, Spanne, häufigste Werte (rein, getestet)
  src/testdata.rs              Testdaten: Generatoren je Spalte, Zufall je Zelle aus (Startwert, Spalte, Zeile),
                               eindeutig über einen Gang durch den Bereich, Muster, Vorschlag aus dem Katalog; eine
                               Quelle für den Lader (rein; testdata_tests.rs, auch 1 Mio. Zeilen)
  src/saved.rs                 gespeicherte Abfragen: .sql-Dateien mit Kopfkommentar, Pfadprüfung, Suche,
                               Fingerabdruck des Ordners (rein, getestet)
  src/history.rs               Verlauf: history.sqlite, Suche, Aufbewahrung, endgültiges Löschen (rein, getestet)
  src/data_import.rs           Dateien als Strom lesen: Kodierungen, CSV, JSON, NDJSON, gzip; Trenner, Kopfzeile
                               und Typen erkennen (rein, getestet)
  src/export.rs                Dateien schreiben: FileWriter (Text, gzip, xlsx), from_store, FileSink (rein, getestet)
  src/ssh/                     SSH-Tunnel: mod.rs (russh-Client, Anmeldung, Weiterleitung), trust.rs (known_hosts),
                               ssh_config.rs (~/.ssh/config, nie ausgeführt) – trust/ssh_config wie in log-commander
  src/format.rs                SQL formatieren: Tokens, Gruppen, Layout, Selbstprüfung (rein; Tests format_tests.rs)
  src/extract.rs               Formate (TSV, CSV, JSON, Markdown, HTML, INSERT, IN, WHERE), Literale je Dialekt (rein)
  src/copy.rs                  Auswahl eines Ergebnisses als Text: Zeilenbereiche, Spalten, Abbruch, Grenze (rein)
  src/db/load.rs               Datei in eine Tabelle laden: Zuordnung, Stapel-INSERTs aus edit.rs, Transaktion
                               oder blockweise, Fehlerdatei, CREATE TABLE je Dialekt (rein, Katalog böser Werte)
  src/db/import.rs             Verbindungs-URLs und fremde Dateien lesen (rein, Katalog), eigener Export
  src/db/edit.rs               die Anweisungen eines Schreib-Plans: DELETE, UPDATE, gebündelte INSERTs (in dieser
                               Reihenfolge), Schlüssel, Sperre über alte Werte – alles gebunden (rein, Katalog)
  src/db/find.rs               Suche auf dem Server: Anweisung je Tabelle mit gebundenem Text, Definitionen aus dem
                               Katalog, Stelle und Vorschau eines Treffers (rein, Katalog böser Texte)
  src/db/filter.rs             das SELECT einer Tabellen-Ansicht: Namen gequotet, Werte gebunden (rein, Katalog
                               auch böser Werte)
  src/db/guard.rs              Anweisungen einstufen (lesend/schreibend/DDL/gefährlich), Schutzstufen (rein, Katalog)
  src/db/diagram.rs            Tabellen, Schlüssel und eindeutige Spaltensätze eines Schemas für das ER-Diagramm
  src/db/compare.rs            Schema-Vergleich: Schnappschuss, Unterschiede, Migrationsskript (rein bis auf das
                               Lesen; Katalog böser Namen, Rundreise)
  src/db/transfer.rs           Tabellen zwischen Verbindungen kopieren: Typabbildung je Dialektpaar mit
                               Verlusten, Plan in Schlüssel-Reihenfolge, Strom über eine Warteschlange in den
                               Lader (rein bis auf Kopie und Lauf; Kopie zwischen SQLite-Datenbanken als Test)
  src/db/structure.rs          Struktur bearbeiten: Anfrage (Tabelle vorher/nachher) → Anweisungen über den
                               Erzeuger aus compare.rs, je Schritt eine; löschen, leeren, duplizieren; Lauf in
                               einer Transaktion (rein bis auf Lesen und Lauf; Rundreise in SQLite)
  src/db/access.rs             Benutzer, Rollen, Rechte lesen (mit Herkunft); Änderungen → Anweisungen (Namen
                               gequotet, Rechte aus Listen), Gefahren, Passwort maskiert bzw. als SCRAM-Prüfwert
                               (rein bis auf das Lesen; access_tests.rs)
  src/db/monitor.rs            Server-Monitor: Sitzungen, Blockaden, Kennzahlen je Datenbank, jeder Teil für sich;
                               Beenden nur mit einer Id, die eine Zahl ist
  src/db/details.rs            Objekt-Details als Listen + DDL je Datenbank (Katalog, gebundene Parameter)
  src/db/relations.rs          Fremdschlüssel einer Tabelle als Daten, je Datenbank (Katalog, gebundene Parameter)
  src/db/plan.rs               Ausführungspläne: fragen je Datenbank, Parser (JSON, XML, Textbäume) in ein Modell,
                               Eigenzeiten, Hinweise (rein; Katalog echter Pläne in plan_cases/)
  src/db/names.rs              Namensindex je Verbindung: Katalog lesen, Suche und Rangfolge (rein, Katalog als Test)
  src/db/meta.rs               Metadaten aus dem Systemkatalog (gebundene Parameter), quote() je Dialekt
  src/db/value.rs              Cell, ColKind, QueryResult (verlustfrei über die Brücke)
  src/db/manager.rs            ConnectionManager: Sitzungen, Schlüsselbund-Regeln, Abbruch
  src/db/profiles.rs           connections.json (nie ein Geheimnis); db/secrets.rs: Secret, Schlüsselbund
  tests/mcp_bridge.rs          MCP von Ende zu Ende ohne Fenster: Client-Zeilen → Server → Brücke → Werkzeuge
  tests/db_integration.rs      Treiber gegen echte Server (ignoriert; pnpm rust:test:db)
  tests/oracle_integration.rs  Oracle gegen Oracle Database Free im Container (ignoriert; pnpm rust:test:db)
  tests/clickhouse_integration.rs  ClickHouse gegen einen Container (ignoriert; pnpm rust:test:db)
  tests/trino_integration.rs   Trino (und mit SC_DBTEST_PRESTO=1 Presto) gegen Container (ignoriert; pnpm rust:test:db)
  src/themes.rs                eigene Farbschemata: themes.json, Grenzen, Import/Export (rein, getestet)
  src/error.rs                 AppError { code, message, details } – details: was die Datenbank zum Fehler sagt
  capabilities/default.json    minimale Rechte (core:default, store:default, dialog:allow-open/-save)
  tauri.conf.json              Fenster, CSP, Bundle (Version aus package.json)
scripts/                       check-contrast.mjs + theme-lib.mjs, version.mjs, csp-preview.mjs, notices.mjs,
                               release-notes.mjs (+ Tests),
                               db-test-servers.sh (Container für die Treibertests)
docs/                          architecture.md, best-practices.md, themes.md, feature-analysis.md, roadmap.md,
                               release.md, macos-signing.md, distribution.md
prompts/                       000-arbeitsweise.md, README.md (Index), offene Prompts; erledigte unter done/
public/                        icon.svg (Quelle der App-Icons: `pnpm tauri icon public/icon.svg`), favicon.png
site/                          Produktseite (statisch, Englisch): fünf Seiten, site.css, site.js; `node site/build.mjs`
                               schreibt Kürzel, Farbschemata und Icon aus dem Repository hinein (`site/README.md`)
```

## 4. Architekturregeln (verbindlich)

Ausführlich in **`docs/best-practices.md`** – vor jeder Änderung lesen. Die wichtigsten:

- **Frontend ruft das Backend nur über typisierte Fassaden** (`*Api` in `app/core/`), nie `invoke()` direkt.
- **DTO- und Fehlervertrag** Rust ↔ TypeScript von Hand synchron, mit Test auf beiden Seiten.
- **Commands nie synchron** (`#[tauri::command(async)]` oder `async fn`); Blockierendes nie auf dem
  Async-Runtime-Thread; lange Arbeit mit Fortschritt und Abbruch.
- **Reine Logik in eigenen Dateien** (Rust-Module ohne Tauri, TS ohne Angular), Tests daneben.
- **Jede Funktion ist eine Aktion**: Id in `core/actions/action-catalog.ts`, Kürzel nur in `keymaps/*.json`,
  Handler per `ActionService.register`, Umschalter dazu per `registerCheck`. Jede Aktion steht in der
  Menüleiste (`features/menus/menu-model.ts`, ein Test verlangt es); Menüs enthalten nur Aktions-Ids. Keine eigenen `keydown`-Handler für Funktionen (Ausnahmen: Widgets nach
  APG – Dialoge, Listen, Menüs, Splitter). Die Tasten des Editors (`Mod+C/V/X/A/Z`, `Mod+F`, `F3`,
  `Strg+Leertaste`) sind reserviert; einfache Tasten und AltGr-Zeichen erreichen im Editor nie eine Aktion.
- **Sitzungen**: Jeder Tab läuft auf seiner eigenen Sitzung (`session` = Tab-Id am Command); die Sitzung der
  Verbindung gehört der App. Ob eine Transaktion offen ist, sagt der Server (`TxState`), nie eine Annahme.
- **Tabs**: Ein Tab ist ein `QueryTab` (per Id adressiert), sein Editor bleibt in der Seite, auch wenn er nicht
  vorn ist. Höchstens zwei Tab-Gruppen; alle `QueryPane` bleiben Kinder des einen Rasters in `app.ts` und
  wechseln nur die Zelle (nie im DOM umhängen: der Editor ginge verloren). Der Text eines Tabs wird nie bei jedem Tastendruck über die Brücke geschickt: `TabsStore.textChanged`
  plant die Sicherung, die den Text einmal holt. Nichts fragt „Speichern?“.
- **Oracle**: Die Verbindung gehört dem Thread in `oracle.rs`, nichts sonst fasst sie an. Platzhalter sind `:1`,
  `:2` …; ein Datum wird als Datum gebunden, nie als Text (NLS). Eine Zeile je `INSERT`. Was es für Oracle noch
  nicht gibt, meldet `db::not_yet` und steht in den `Capabilities` – kein stiller Rückfall auf einen anderen Dialekt.
- **ClickHouse**: Der Treiber schickt **keine Einstellungen** mit einer Anfrage (eine nur lesende Sitzung darf keine
  ändern); Platzhalter sind `{p1:String}` mit `param_p1`. Was Transaktionen oder eindeutige Schlüssel braucht,
  lehnt das Backend ab (`edit::steps`, `transfer::plan`) und blendet das Flag `edit` aus – nicht nachbauen.
- **Trino/Presto**: Das Protokoll bindet keine Werte – ein Wert wird nur durch `trino::literal` zu SQL (geprüft
  oder gequotet), nie anders. Gefragt wird nur der Server des Profils (`page_path`), was auch immer `nextUri`
  nennt. Die Sitzung ist, was die Kopfzeilen des Servers sagen (`follow`); „nur lesen“ hält der Treiber selbst
  (`guarded`). Ob Zeilen bearbeitet werden, sagt `DbKind::edits_rows` – nie ein Vergleich mit ClickHouse.
- **DuckDB**: nie eine zweite Datenbank auf dieselbe Datei öffnen – Sitzungen sind Klone der einen (`SHARED`
  in `duckdb.rs`). Vor jedem Lesen einer Zelle prüft `readable`, ob der Treiber den Typ kann (sonst endet er in
  `unreachable!`). Erweiterungen werden nie von selbst geladen; ein Assistent bekommt dort keine Abfrage ausgeführt.
  Datei-Datenbanken erkennt `DbKind::is_file` (Rust) bzw. `isFileKind` (Fenster), nie ein Vergleich mit SQLite.
- **Verwandte Server** (CockroachDB, TimescaleDB, YugabyteDB): keine eigene `DbKind`. Abweichungen hängen am `Flavor` der
  Sitzung (`Session::flavor`), nie an einem Vergleich von Versionstexten außerhalb des Treibers.
- **Bezeichner** quotet nur `meta::quote` in Rust; Knoten und DTOs bringen `quoted` mit. Katalogabfragen nur über
  `Session::ask` mit gebundenen Parametern.
- **Formatieren** ändert nur Leerraum und die Schreibung von Schlüsselwörtern; `format.rs` prüft jedes Ergebnis
  gegen die Tokens des Textes. Das Fenster ersetzt nur den Bereich (`replaceRange`), nie den ganzen Text.
  Stellen des Editors zählen Spalten in **Codepunkten**, JavaScript in UTF-16: umgerechnet wird nur mit
  `core/text/places.ts` (`placeIn`, `offsetAt`).
- **Tabellen-Ansicht**: Ihr SQL baut nur `db/filter.rs`; das Fenster setzt nie Werte oder Namen in SQL ein.
  Auch das Folgen eines Fremdschlüssels ist eine Tabellen-Ansicht: Das Fenster nennt Tabelle und Schlüsselwerte
  (`KeySet`), das Backend bindet sie.
  Lokales Sortieren/Filtern geschieht im Ergebnisspeicher (`derive`), nie über die Zeilen im Fenster.
- **Spalten des Ergebnisses**: Gitterspalte ≠ Ergebnisspalte (das Layout versteckt und verschiebt). Umgerechnet
  wird nur im Gitter (`WindowAreaModel.resultColumn`, `ResultGrid.chosen/cursor`); nach außen gehen immer
  Spalten des Ergebnisses. Ein neues Layout baut die Tabelle neu (das Layout ist unseres, nicht der Zustand der
  Tabelle). Das Gitter hängt nur an der Zeilenhöhe, nie am ganzen Einstellungs-Signal.
- **Aktionen im Ergebnis** (`scope: 'result'`): wirken nur, solange ein Ergebnisgitter die Tastatur hat – so
  bleibt `Mod+F` im Editor dessen Suche.
- **Bearbeiten**: Nichts geht beim Tippen an die Datenbank. Änderungen liegen im Puffer des Tabs
  (`edit-buffer.ts`), eine Zeile ist ihr Schlüssel, nicht ihre Stelle. Geschrieben wird nur über `edit_apply`:
  Das Backend baut die `UPDATE`s aus dem Plan (das Fenster sendet nie SQL), lässt jede durch `admit`, und
  schreibt alle in einer Transaktion – jede muss genau eine Zeile treffen, sonst Rollback. Was Zeilen neu liest,
  läuft über `QueryTab.runAll` und fragt vorher (`dropEdits`).
- **Ergebnisse eines Tabs**: Die Anweisungen des letzten Laufs (`runs`, über den Index) und die gehaltenen
  Ergebnisse (`kept`, über ihren Schlüssel) sind zweierlei; was auf dem Schirm ist, sagt `tab.shownRun()`.
  Gewechselt wird mit `tab.show(…)`. Solange ein gehaltenes Ergebnis gezeigt wird, ist `tab.tableView()` `null`.
  Verglichen wird nur in `result_compare.rs`; das Fenster färbt nach der ersten Zelle der Zeile.
- **Diagramm**: Das Fenster bekommt nur die Punkte, die es zeichnet (`chart.rs`), nie die Zeilen; Namen von
  Reihen und Kategorien sind Text des Ergebnisses und werden nur als Text gesetzt (in der SVG-Datei maskiert).
  Farben nur `--chart-1…8` und `--chart-grid`; Reihen unterscheiden sich auch durch Strichart, Marker, Schraffur.
- **Kennzahlen**: Summen rechnet nur `stats.rs` (dezimal, exakt) – nie JavaScript und nie über die Zeilen im
  Fenster; das Fenster zeigt den Text, den es bekommt.
- **Werte**: Eine `Cell` trägt den ganzen Wert; gekürzt wird nur beim Schreiben der Zeile. Nichts aus einem
  Wert wird als Markup in die Seite gesetzt; Bilder nur innerhalb der Grenzen von `value-logic.ts` als `blob:`.
- **Ausführungsplan**: „Mit Ausführung“ führt die Anweisung aus – immer durch `admit`, immer in einer
  Transaktion, die `plan::explain` zurückrollt; ein Plan wird nur für **eine** Anweisung gefragt.
- **Struktur bearbeiten**: Das Fenster sendet Tabellen (vorher, nachher, Umbenennungen), nie DDL. Geschrieben
  wird nur über `structure::plan` → `compare::script_steps`; `struct_apply` schreibt neu, lässt jede Anweisung
  durch `admit` und führt sie auf eigener Sitzung aus. Neue Schritte im Erzeuger brauchen die Gefahren-Prüfung.
- **Schema-Vergleich**: Das Migrationsskript führt die App nie aus. Jeder Schritt, der Daten kosten kann, steht
  mit `-- DANGER: ` als Kommentar (`compare::danger`); neue Schritte in `script()` brauchen diese Prüfung.
- **Suche auf dem Server**: nur `db/find.rs` baut ihre Anweisungen; der Suchtext ist immer gebunden. Ein Treffer
  führt über `TableViews.openWith` als Bedingung in eine Tabellen-Ansicht.
- **Übertragen** (`db/transfer.rs`): Die Quelle wird nur gelesen; geschrieben wird nur über den Lader des
  Imports (`load::load` mit `Records`), jeder Wert gebunden – auch Binärdaten (als Hex, `ValueKind::Bytes`).
  Jede Anweisung des Plans geht durch `admit` des Ziels. Ein neuer Typ in `type_for` braucht seinen Verlust.
- **Import**: Die Datei ist feindlich. Ihre Spaltennamen werden nie SQL (Zielspalten nennt die Zuordnung, gequotet
  im Backend), ihre Werte nur gebunden (`db/load.rs` über `edit::steps`); das Fenster zeigt Werte nur als Text.
- **Parameter**: Werte des Nutzers gehen nur als `Bind` über `run_query` und werden vom Treiber gebunden
  (`Session::execute_bound`); nie in den SQL-Text, den Verlauf, die Sitzung oder ein Log schreiben.
- **Externe Programme** (`backup.rs`): nie eine Shell; jeder Wert hängt an seiner Option oder steht hinter
  `--`; das Passwort ist nie ein Argument und steht in keiner Zeile, die das Fenster bekommt; was ein Lauf
  schreibt, entfernt er, wenn er scheitert oder angehalten wird. Wiederherstellen entscheidet im Backend nach der
  Schutzstufe.
- **Testdaten**: Der Generator ist rein und wiederholbar – nichts in ihm hängt an Zeit, Reihenfolge oder einem
  Zustand über Zeilen hinweg (außer dem Gang über die Eltern). Eindeutig wird nie durch Merken. Geschrieben
  wird nur über `load::load`; wohin ein Fremdschlüssel zeigt, sagt der Katalog. Geschützte Verbindungen lehnt
  das Backend ab.
- **KI-Steuerung (MCP)**: aus, bis der Nutzer sie einschaltet – dann erst gibt es Port und Datei. Was ein
  Assistent darf, entscheidet nur `mcp.rs` (Stufe je Verbindung); lesend heißt: von `guard::classify` als lesend
  eingestuft **und** auf einer Sitzung, die auf dem Server nur lesen darf. Schreibendes läuft nie aus einem
  Werkzeug, nur als Vorschlag über `tab.run` nach dem Klick. Ein neues Werkzeug braucht seine Stufe, seine
  Grenzen und den Schnappschuss (`tools.snapshot.json`). Die Einstellung `ai` bleibt in `LOCAL_KEYS`.
- **Benutzer und Rechte**: Das Fenster sendet Änderungen (`Change`), nie SQL; ein Passwort ist kein Teil davon
  (`passwords[i]` daneben, `Secret`). Gezeigt und durch `admit` geprüft wird die maskierte Anweisung, die echte
  entsteht erst beim Lauf. Ein neues Recht gehört in `privileges.json` und in `access::privileges`.
- **Server-Monitor**: Anweisungen anderer sind fremde Daten – nur als Text auf dem Schirm, nie im Verlauf, in
  einem Log oder der Sitzung. Beendet wird nur nach der Rückfrage; `monitor_kill` lehnt „nur lesen“ ab.
- **Schutz**: Was SQL ausführt, ruft im Backend `ConnectionManager::admit`; das Fenster fragt nur, entscheidet nie.
- **Zustand in Signals**, Stores je Instanz ohne `providedIn`, Globales in Root-Services; veraltete Antworten verwerfen.
- **Texte nur in Katalogen**: `*-texts.ts` (Englisch, Quelle) + `*-texts.de.ts` über `translatable()`; nie beim
  Laden eines Moduls in Konstanten kopieren (die Sprache wechselt zur Laufzeit); neue Kataloge in
  `core/i18n/catalogs.spec.ts` eintragen. Die Specs laufen deutsch (`src/testing/setup.ts`).
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
- Kein Push, kein Force-Push, kein `git reset --hard`, keine Releases ohne ausdrückliche Anweisung (auch kein Tag
  `v*`: Er löst den Release-Workflow aus).
- README und `docs/` bei relevanten Änderungen mitpflegen; `prompts/README.md` führt den Status.

## 8. Lizenzen

- Eigene Lizenz: **MIT**. editlicious-editor: MIT. GuiExpert Table: MIT (aktuelle Releases).
- Farbschemata: nur Farbwerte nach bekannten Editor-Themes, Herkunft in `files-and-folders-tauri/docs/themes.md`.
