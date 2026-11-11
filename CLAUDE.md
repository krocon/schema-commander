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
  Gehe zu Zeile, nächster anderer Wert / nächstes NULL (Prompt 029);
  Einstellungen und Fensterzustand bleiben über einen Neustart.
- **Noch nichts davon**: Bearbeiten, Import. Alle Features aus
  `docs/feature-analysis.md` sind freigegeben; die Prompts 002–049 liegen in `prompts/` (Nummer = Reihenfolge,
  erledigt: 001–029),
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
  app/core/actions/            Aktionen: action-catalog.ts (Ids, Namen, Bereich), keymaps/*.json (je OS),
                               keymap.ts (Vorgabe + eigene Belegung, Reserviertes), shortcut.ts (Notation),
                               keyboard-dispatcher.ts (der eine keydown-Handler), ActionService (Root)
  app/core/backend/            call.ts (einzige Stelle mit invoke()), WindowApi (set_window_chrome),
                               FileDialogApi (native Öffnen-/Speichern-Dialoge: einzige Quelle für Pfade),
                               ClipboardApi (copy_result, copy_text: die Zwischenablage gehört Rust),
                               ExportApi (export_result, export_query, cancel_job, reveal_export)
  app/core/connections/        Profile (Modell), ConnectionsApi, ConnectionsStore (Root: Profile, Zustände, aktive
                               Verbindung, Passwortabfrage)
  app/core/errors/             AppError + ErrorDetails + toAppError (spiegelt src-tauri/src/error.rs), error-texts
                               (Text je Code), error-position.ts (rein: Angabe der Datenbank → Stelle im Editor,
                               Katalog error-position.cases.json)
  app/core/format/             FormatApi (format_sql, cancel_job) + Stil und Modus – spiegelt format.rs
  app/core/i18n/               i18n.ts (translatable, phrasebook, language, locale), common-texts,
                               catalogs.spec.ts (jeder Katalog vollständig in beiden Sprachen)
  app/core/history/            HistoryApi (history_*) + DTOs – spiegelt history.rs
  app/core/menu/               MenuApi (set_app_menu, set_menu_state, subscribe_menu) + DTOs – spiegelt app_menu.rs
  app/core/saved/              SavedApi (saved_*) + DTOs – spiegelt saved.rs
  app/core/schema/             SchemaApi (meta_*) + DTOs (SchemaInfo, ObjectInfo, TableInfo) – spiegelt db/meta.rs
  app/core/session/            SessionApi: session.json, Texte der Tabs, .sql lesen/schreiben
  app/core/settings/           Settings (Modell, mergeSettings), SettingsService (tauri-plugin-store)
  app/core/sql/                QueryApi (run mit Ereignissen, window, free, cancel) + DTOs (ResultRef, RunEvent, Cell, ColKind) – spiegelt db/value.rs
  app/core/text/               places.ts (rein: Stelle des Editors ↔ Offset im Text; Spalten in Codepunkten)
  app/core/theme/              Farbschemata: tokens.ts (Katalog), themes/*.json, theme-logic.ts (rein),
                               ThemeService (Root: Auswahl, Vorschau, eigene Schemata), ThemeApi (themes.json),
                               contrast-pairs.json
  app/features/completion/     sql-lex.ts, sql-context.ts (rein: was an der Stelle passt, Katalog
                               sql-context.cases.json), suggest.ts (rein: die Liste, suggest.cases.json),
                               sql-words.ts (Wörter je Dialekt), CompletionService (Root: liest, was fehlt)
  app/features/connections/    Verbindungsliste (Seitenleiste), Verbindungsdialog, Passwortabfrage,
                               connection-logic.ts (rein: Gruppen, Prüfung, Vorschläge)
  app/features/details/        DetailsDialog (Listen als Gitter, Filter, Beziehungen, DDL), ObjectDetailsService
                               (Root: Objekt auf dem Schirm, Weg zurück), details-logic.ts (rein)
  app/features/editor/         SqlEditor (<editlicious-editor scheme="none">), editlicious.ts (Laden),
                               editor-colors.ts (Farben des Editors aus unseren Tokens),
                               sql-split.ts (rein: Skripte je Dialekt zerlegen, Katalog sql-split.cases.json)
  app/features/export/         ExportDialog, ExportService (Root: ein Job, Statuszeile), export-logic.ts (rein)
  app/features/filter/         FilterBar (Bedingungen der Tabellen-Ansicht, lokaler Filter), TableViews (Root:
                               Tabelle als Tabellen-Ansicht öffnen), filter-logic.ts (rein)
  app/features/find/           ResultFind (je Tab: Suche stückweise, Treffer, Sprung; kein Injectable), FindBar
                               (Suchzeile über dem Ergebnis), ColumnsPopover (Spaltenliste)
  app/features/stats/          StatsService (Root: Kennzahlen der Auswahl, gedrosselt, Überholtes verworfen),
                               StatsPopover (Spalte zusammenfassen), stats-logic.ts (rein: Kennzahlen → Anzeige)
  app/features/format/         FormatService (Root: ein Job, Statuszeile), format-logic.ts (rein: Stil,
                               Cursor nach dem Formatieren)
  app/features/guard/          GuardDialog (Rückfrage), GuardService, guard-logic.ts (rein)
  app/features/history/        HistoryDialog (Listbox, Vorschau), HistoryPanel (Ansicht der Seitenleiste),
                               HistoryService (Root: aufzeichnen, blättern), history-logic.ts (rein)
  app/features/menus/          menu-model.ts (rein: Menüs aus Aktions-Ids → Fenster / native Spec), MenuService
                               (Root: Menüleiste, Kontextmenü), MenuBar (APG-Menubar für Windows/Linux)
  app/features/palette/        die eine Palette: Befehle und „Springen zu allem“ (CommandPalette), palette-logic.ts
                               und goto-logic.ts (rein), GotoService (führt einen Treffer aus)
  app/features/saved/          SavedPanel (Ansicht der Seitenleiste, APG-Baum), SavedDialog, SavedStore (Root:
                               Listing, beobachten, öffnen als Datei-Tab), saved-logic.ts (rein)
  app/features/snippets/       SnippetDialog, snippet-logic.ts (rein: mitgelieferte je Dialekt, Variablen)
  app/features/schema/         SchemaTree (virtuelle Liste, APG-Baum), SchemaStore (Root: Zustand je Verbindung),
                               SchemaActions, schema-logic.ts (rein: Zeilen, Filter, Tasten, Vorlagen)
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
                               Statuszeile), tx-logic.ts (rein: Texte zur Transaktion)
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
  src/session.rs               Sitzung der Tabs: session.json + tabs/<id>.sql (rein, getestet)
  src/textfile.rs              .sql lesen/schreiben mit Kodierung (UTF-8/-BOM, UTF-16, Windows-1252)
  src/menu.rs                  das Menü von macOS, solange das Fenster lädt (ohne Cmd+W)
  src/app_menu.rs              native Menüleiste aus der MenuSpec des Fensters: Prüfung, Beschleuniger (rein, getestet)
  src/db/mod.rs                Profile, DbKind, TlsMode, Session-Trait, Laufzeit, Fehler in Worten
  src/db/{pg,mysql,mssql,sqlite}.rs  die Treiber; sqlite.rs auch die Demo-Datenbank
  src/results.rs               Ergebnisspeicher: Zeilen + Offsets, Auslagern, Fenster, Grenzen, StoreSink; ganze Werte
                               getrennt (`<id>.values`) und stückweise (`value`) (rein, getestet)
  src/image_info.rs            Bildformat und Maße aus den ersten Bytes, nie dekodiert (rein, getestet)
  src/search.rs                Suche im Ergebnisspeicher: Regex mit Grenzen, stückweise; nächster anderer Wert,
                               nächstes NULL (rein, getestet)
  src/stats.rs                 Kennzahlen einer Auswahl über den Ergebnisspeicher: exakte Dezimalsumme (`Dec`),
                               Min/Max, Spanne, häufigste Werte (rein, getestet)
  src/saved.rs                 gespeicherte Abfragen: .sql-Dateien mit Kopfkommentar, Pfadprüfung, Suche,
                               Fingerabdruck des Ordners (rein, getestet)
  src/history.rs               Verlauf: history.sqlite, Suche, Aufbewahrung, endgültiges Löschen (rein, getestet)
  src/export.rs                Dateien schreiben: FileWriter (Text, gzip, xlsx), from_store, FileSink (rein, getestet)
  src/ssh/                     SSH-Tunnel: mod.rs (russh-Client, Anmeldung, Weiterleitung), trust.rs (known_hosts),
                               ssh_config.rs (~/.ssh/config, nie ausgeführt) – trust/ssh_config wie in log-commander
  src/format.rs                SQL formatieren: Tokens, Gruppen, Layout, Selbstprüfung (rein; Tests format_tests.rs)
  src/extract.rs               Formate (TSV, CSV, JSON, Markdown, HTML, INSERT, IN, WHERE), Literale je Dialekt (rein)
  src/copy.rs                  Auswahl eines Ergebnisses als Text: Zeilenbereiche, Spalten, Abbruch, Grenze (rein)
  src/db/import.rs             Verbindungs-URLs und fremde Dateien lesen (rein, Katalog), eigener Export
  src/db/filter.rs             das SELECT einer Tabellen-Ansicht: Namen gequotet, Werte gebunden (rein, Katalog
                               auch böser Werte)
  src/db/guard.rs              Anweisungen einstufen (lesend/schreibend/DDL/gefährlich), Schutzstufen (rein, Katalog)
  src/db/details.rs            Objekt-Details als Listen + DDL je Datenbank (Katalog, gebundene Parameter)
  src/db/names.rs              Namensindex je Verbindung: Katalog lesen, Suche und Rangfolge (rein, Katalog als Test)
  src/db/meta.rs               Metadaten aus dem Systemkatalog (gebundene Parameter), quote() je Dialekt
  src/db/value.rs              Cell, ColKind, QueryResult (verlustfrei über die Brücke)
  src/db/manager.rs            ConnectionManager: Sitzungen, Schlüsselbund-Regeln, Abbruch
  src/db/profiles.rs           connections.json (nie ein Geheimnis); db/secrets.rs: Secret, Schlüsselbund
  tests/db_integration.rs      Treiber gegen echte Server (ignoriert; pnpm rust:test:db)
  src/themes.rs                eigene Farbschemata: themes.json, Grenzen, Import/Export (rein, getestet)
  src/error.rs                 AppError { code, message, details } – details: was die Datenbank zum Fehler sagt
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
- **Bezeichner** quotet nur `meta::quote` in Rust; Knoten und DTOs bringen `quoted` mit. Katalogabfragen nur über
  `Session::ask` mit gebundenen Parametern.
- **Formatieren** ändert nur Leerraum und die Schreibung von Schlüsselwörtern; `format.rs` prüft jedes Ergebnis
  gegen die Tokens des Textes. Das Fenster ersetzt nur den Bereich (`replaceRange`), nie den ganzen Text.
  Stellen des Editors zählen Spalten in **Codepunkten**, JavaScript in UTF-16: umgerechnet wird nur mit
  `core/text/places.ts` (`placeIn`, `offsetAt`).
- **Tabellen-Ansicht**: Ihr SQL baut nur `db/filter.rs`; das Fenster setzt nie Werte oder Namen in SQL ein.
  Lokales Sortieren/Filtern geschieht im Ergebnisspeicher (`derive`), nie über die Zeilen im Fenster.
- **Spalten des Ergebnisses**: Gitterspalte ≠ Ergebnisspalte (das Layout versteckt und verschiebt). Umgerechnet
  wird nur im Gitter (`WindowAreaModel.resultColumn`, `ResultGrid.chosen/cursor`); nach außen gehen immer
  Spalten des Ergebnisses. Ein neues Layout baut die Tabelle neu (das Layout ist unseres, nicht der Zustand der
  Tabelle). Das Gitter hängt nur an der Zeilenhöhe, nie am ganzen Einstellungs-Signal.
- **Aktionen im Ergebnis** (`scope: 'result'`): wirken nur, solange ein Ergebnisgitter die Tastatur hat – so
  bleibt `Mod+F` im Editor dessen Suche.
- **Kennzahlen**: Summen rechnet nur `stats.rs` (dezimal, exakt) – nie JavaScript und nie über die Zeilen im
  Fenster; das Fenster zeigt den Text, den es bekommt.
- **Werte**: Eine `Cell` trägt den ganzen Wert; gekürzt wird nur beim Schreiben der Zeile. Nichts aus einem
  Wert wird als Markup in die Seite gesetzt; Bilder nur innerhalb der Grenzen von `value-logic.ts` als `blob:`.
- **Parameter**: Werte des Nutzers gehen nur als `Bind` über `run_query` und werden vom Treiber gebunden
  (`Session::execute_bound`); nie in den SQL-Text, den Verlauf, die Sitzung oder ein Log schreiben.
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
- Kein Push, kein Force-Push, kein `git reset --hard`, keine Releases ohne ausdrückliche Anweisung.
- README und `docs/` bei relevanten Änderungen mitpflegen; `prompts/README.md` führt den Status.

## 8. Lizenzen

- Eigene Lizenz: **MIT**. editlicious-editor: MIT. GuiExpert Table: MIT (aktuelle Releases).
- Farbschemata: nur Farbwerte nach bekannten Editor-Themes, Herkunft in `files-and-folders-tauri/docs/themes.md`.
