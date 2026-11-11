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
| A15 | Treiber wie log-commander (`sqlx`-Unterkrates, `tiberius`, `rusqlite`), Anweisungen über das einfache Protokoll, eine Sitzung je Profil | Design 003 E1–E5 |
| A16 | Zellen als JSON ohne Verlust (Ganzzahlen jenseits 2^53, Dezimal, Datum als Text; Spalte trägt die Art) | Design 003 E6 |
| A17 | Passwörter nur im Schlüsselbund des Systems; `connections.json` kennt kein Geheimnis | Design 003 E7–E9 |
| A18 | Ein Editor je Tab, gebaut beim ersten Zeigen; Text je Tab als eigene Datei, eine Weile nach der letzten Änderung gesichert; Schließen ohne Rückfrage | Design 004 E1–E7 |
| A19 | `.sql`-Dateien behalten ihre Kodierung (`textfile.rs`, ohne Abhängigkeit); nie Schreiben mit Verlust | Design 004 E10 |
| A20 | Eigenes macOS-Menü ohne „Fenster schließen“ | `Cmd+W` gehört den Tabs (Design 004 E12) |
| A21 | SQL wird im Frontend zerlegt (`sql-split.ts`, je Dialekt, mit Katalog); Rust führt fertige Anweisungen aus | Design 005 E1–E4 |
| A22 | Abbruch und Zeitlimit beenden die Anweisung auf dem Server über eine zweite Verbindung; die Sitzung bleibt (außer SQL Server) | Design 005 E6–E7 |
| A23 | Ergebnisse leben in Rust (`results.rs`: Zeilen als JSON + Offsets, 32 MB im Speicher, darüber Datei im Cache); das Gitter holt Fenster über ein eigenes `AreaModel`; es wird immer zu Ende gelesen, kein Server-Cursor | Design 006 E1–E7 |
| A24 | Metadaten nur über `Session::ask` mit gebundenen Parametern (`db/meta.rs`); Namen quotet allein `meta::quote`, jeder Knoten bringt `quoted` mit; der Zwischenspeicher liegt im Frontend (`SchemaStore`) | Design 008 E1, E3, E7 |
| A25 | Der Schema-Baum ist eine eigene virtuelle Liste mit den Rollen eines APG-Baums, keine GuiExpert Table | Design 008 E8 |
| A26 | Formate zum Kopieren und Exportieren schreibt Rust (`extract.rs`); die Zwischenablage gehört Rust (`arboard`, drei schmale Commands), Zeilen gehen nie durch die WebView | Design 009 E1–E2 |
| A27 | Verlauf in eigener SQLite-Datei (`history.rs`), Suche mit `LIKE`, Löschen mit `secure_delete` + `VACUUM`; was nicht gemerkt werden soll, verlässt das Frontend nicht | Design 010 E1–E6 |
| A28 | Export schreibt Rust zeilenweise (`export.rs`: Speicher oder `FileSink` am Treiber), neben das Ziel und benennt um; Jobs mit Id, Fortschritt über `Channel`, Abbruch | Design 011 E2, E6, E8 |
| A29 | Schutz der Verbindungen im Backend: `guard::classify` (eigener Scanner, im Zweifel schreibend), `admit` an jedem Ausführ-Command, Bestätigung als einmaliges Token, `readonly` zusätzlich auf dem Server | Design 012 E1–E6 |
| A30 | Jeder Tab hat eine eigene Sitzung (ersetzt „eine je Profil“ aus A15); die der Verbindung gehört der App (Baum, Export). Den Transaktionszustand sagt der Server nach jedem Lauf | Design 013 E1–E5 |
| A31 | SSH-Tunnel in Rust (`ssh/`, `russh`): Listener auf `127.0.0.1` mit Zufallsport, der nur angekündigte Verbindungen annimmt; Host-Schlüssel gegen `known_hosts`, unbekannt = Fingerabdruck bestätigen, geändert = Ablehnung. `trust.rs` und `ssh_config.rs` sind aus log-commander übernommen | Design 014 E1–E5 |
| A32 | Fremde Verbindungsdateien liest nur Rust (`db/import.rs`): begrenzt, ohne XML-Parser, ohne Ausführen; Klartext-Passwörter gehen auf Wunsch direkt in den Schlüsselbund und nie über die Brücke | Design 015 E1, E4, E5 |
| A33 | Fester Fensteraufbau mit höchstens zwei Tab-Gruppen; die Gruppe ist eine Eigenschaft des Tabs, „geteilt“ ist abgeleitet. Alle Tabs sind Kinder eines CSS-Rasters und wechseln nur die Zelle (ein Editor zieht im DOM nie um). Regeln rein in `layout-logic.ts` | Design 016 E1–E5 |
| A36 | Ein Menümodell aus Aktions-Ids (`features/menus/menu-model.ts`) für native Menüleiste (macOS), gezeichnete Menüleiste (Windows/Linux) und Kontextmenüs. Das Frontend schickt die Leiste als geprüfte `MenuSpec`; Zustände werden einzeln umgeschaltet | Design 018 E1–E4 |
| A37 | Objekt-Details als Listen aus Schlüsseln und Text (`db/details.rs`), gezeichnet vom Ergebnisgitter mit Zeilen im Speicher; DDL vom Server, für Tabellen von PostgreSQL und SQL Server aus dem Katalog zusammengesetzt und per Rundreise gegen echte Server geprüft | Design 019 E2–E6, E9 |
| A34 | Texte in typisierten Katalogen (Englisch Quelle, Deutsch typgeprüft), Sprache als Signal, Wechsel zur Laufzeit; `pnpm texts` hält Texte aus Templates und Deutsch aus dem Code. Ersetzt A10 | Design 017 E1–E6 |
| A35 | Einstellungen bleiben ein flaches, je Wert geprüftes Objekt; der Dialog hat ein eigenes Schema, ein Test hält beide zusammen. Keine Formularschicht: jede Änderung wirkt sofort | Design 017 E8, E9 |

## Offene Architekturfragen (entscheidet der jeweilige Prompt)

- **Treiber**: entschieden und umgesetzt (Design 003); Oracle, DuckDB und weitere mit Prompt 035.
- **Große Ergebnisse**: entschieden und umgesetzt (Design 006).
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
| `rust_xlsxwriter` (`constant_memory`) | Excel-Dateien zeilenweise schreiben | Design 011 E4; reines Rust, MIT/Apache-2.0 |
| `flate2` | gzip für exportierte Textdateien | Design 011 E5; war schon im Abhängigkeitsbaum |
| `russh` (+ `data-encoding`, `hmac`, `sha1` für `known_hosts`) | SSH-Tunnel ohne externes Programm | Design 014 E1; reines Rust, wie log-commander |
| `arboard` (ohne Bild-Feature, `wayland-data-control`) | Zwischenablage aus Rust: Text und HTML | Design 009 E1; kein Plugin mit breiter Oberfläche |
| `editlicious-editor` | SQL-Editor | Vorgabe; große Texte, SQL-Grammatik, 13 Schemata |
| `tauri-plugin-dialog`, `@tauri-apps/plugin-dialog` | native Öffnen-/Speichern-Dialoge (Schema-Import/-Export, später SQL-Dateien, Export) | wie log-commander; nur `dialog:allow-open`, `dialog:allow-save` |
| `tempfile` (dev) | Dateitests in Rust | Standard |
| `rusqlite` (bundled) | Demo-Datenbank und SQLite-Dateien | keine Systembibliothek; ohne Erweiterungsladen gebaut (`.cargo/config.toml`) |
| `sqlx-core`, `sqlx-postgres`, `sqlx-mysql` (=0.9.0) | PostgreSQL, MySQL/MariaDB | reines Rust; Unterkrates statt der Fassade (kein zweites SQLite); `rsa` für MySQL-8-Anmeldung ohne TLS |
| `tiberius`, `tokio-util` | SQL Server (TDS) | reines Rust, rustls |
| `tokio`, `futures-util` | Laufzeit der Netzwerk-Treiber (eigene, nicht Tauris) | Standard |
| `rustls` (ring) | TLS, Wurzeln des Systems | kein OpenSSL |
| `chrono` | Datum und Zeit aus den Treibern | von sqlx und tiberius benutzt |
| `keyring-core` + `apple-native-`, `windows-native-`, `dbus-secret-service-keyring-store` | Passwörter im Schlüsselbund des Systems | wie log-commander und files-and-folders |
| `zeroize`, `sha2`, `parking_lot` | Geheimnisse im Speicher löschen, Kontonamen als Hash, Sperren | klein, verbreitet |
| `serde`, `serde_json` | DTOs | Standard |
| Dev: `vitest`, `jsdom`, `eslint`, `angular-eslint`, `typescript-eslint`, `prettier` | Tests, Lint, Format | wie die Vorgänger |
