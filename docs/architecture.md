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
| A38 | Namensindex je Verbindung im Backend (`db/names.rs`): einmal aus dem Katalog gelesen, im Speicher durchsucht (Wortanfänge, Tippfehler, Rangfolge), Spalten erst auf Nachfrage; eine Palette für Befehle und Sprünge | Design 020 E1–E7 |
| A39 | Vervollständigung: Kontext aus Tokenizer + Regeln im Frontend (Fallkatalog je Dialekt), Namen aus dem Namensindex und dem Katalog im Backend; gelesen wird nur die Anweisung um den Cursor | Design 021 E1–E3, E7 |
| A40 | `AppError` trägt strukturierte Details der Datenbank (Code, Detail, Hinweis, Position in Zeichen, Zeile, Objekt); die Umrechnung auf Zeile/Spalte des Editors ist eine reine Funktion mit Katalog; Markierungen je Besitzer (`sql-error`, `sql-running`) | Design 022 E1–E7 |
| A41 | SQL formatieren in Rust (`format.rs`, rein, keine Abhängigkeit): Tokens statt Syntaxbaum, verändert wird nur Leerraum und die Schreibung von Schlüsselwörtern; jedes Ergebnis wird gegen die Tokens des Textes geprüft (`format_unsafe` statt eines falschen Textes). Ein Job mit Abbruch; das Fenster ersetzt nur den betroffenen Bereich (ein Undo-Schritt) und verwirft Antworten für einen inzwischen geänderten Text. Verworfen: `sqlformat`, `sql-formatter` | Design 023 E1–E3, E9, E11 |
| A42 | Gespeicherte Abfragen sind `.sql`-Dateien mit Kopfkommentar in einem Ordner (`saved.rs`, rein): kein Index, Änderungen von außen über einen Fingerabdruck des Ordners, den das Fenster abfragt (statt `notify`); geöffnet wird die Datei als Datei-Tab. Neue Abhängigkeit `trash` (MIT, wie files-and-folders-tauri): Löschen geht in den Papierkorb des Systems. Snippets sind Einstellungen plus ein Satz je Dialekt und gehen an den Editor | Design 024 E1–E6, E10 |
| A43 | Parameter: erkannt und auf die Platzhalter des Treibers umgeschrieben im Fenster (rein, Katalog), gebunden im Treiber (`Session::execute_bound`, `Bind`); Zahlen und Daten reisen als Text und werden exakt (CAST bzw. `numeric`). Werte stehen nie im SQL-Text, im Verlauf oder in der Sitzung; `NULL` und leere Listen sind Konstanten im Text. Kein „nur ersetzen“ | Design 025 E1, E5–E7, E9 |
| A44 | Die Zelle trägt den ganzen Wert, die Zeile im Ergebnisspeicher kürzt beim Schreiben; was sie nicht ganz zeigt, liegt in einer eigenen Datei je Ergebnis und kommt stückweise über `cell_value`. Bilder werden im Backend nur am Kopf erkannt, im Fenster nur innerhalb fester Grenzen als `blob:` gezeichnet (CSP `img-src … blob:`). JSON wird ohne Parsen gesetzt (nur Leerraum). Ersetzt die Kürzung im Treiber aus A-006/007 | Design 026 E1–E6 |
| A45 | Tabellen-Ansicht: das `SELECT` baut das Backend aus Bedingungen (`db/filter.rs`) – Bezeichner über `meta::quote`, jeder Wert gebunden, in PostgreSQL auf den Spaltentyp gecastet; das Fenster führt `sql` + `params` aus. Lokales Sortieren und Filtern sind Sichten im Ergebnisspeicher (Zeilennummern statt Kopien), gelesen wie ein Ergebnis; Grenze 5 Mio. Zeilen fürs Sortieren | Design 027 E2, E3, E9, E10 |
| A46 | Kennzahlen einer Auswahl rechnet das Backend über den Ergebnisspeicher (`stats.rs`): Zahlen als Dezimaltext mit eigener Arithmetik beliebiger Länge (kein Gleitkomma, kein Überlauf), als abbrechbarer Job; das Fenster fragt gedrosselt und verwirft überholte Antworten. Keine neue Abhängigkeit | Design 028 E1–E4 |
| A47 | Spalten-Layout eines Ergebnisses als eigenes, reines Modell (Schlüssel = Spaltenname), nicht als Zustand der Tabelle: jede Änderung baut das Tabellenmodell neu, der Seiten-Cache bleibt; das Gitter rechnet Gitter- in Ergebnisspalten um. Suche im Ergebnis in Rust über den Speicher, stückweise vom Fenster gefragt (erste Treffer sofort, Abbruch); Muster über `regex` (lineare Laufzeit, Größengrenze). Aktionsbereich `result` für Kürzel, die im Editor etwas anderes sind | Design 029 E1–E4, E9 |
| A48 | Fremdschlüsseln folgen heißt: eine Tabellen-Ansicht mit einer Schlüsselmenge (`KeySet`: Spalten + Wertezeilen) öffnen. Die Beziehungen liest das Backend als Daten aus dem Katalog (`db/relations.rs`), das `SELECT` – auch das zählende und das der Vorschau – baut weiter nur `db/filter.rs` mit gebundenen Werten; der Pfad eines Tabs ist eine Liste von Tabellen-Ansichten. Nur in Tabellen-Ansichten: die Herkunft der Spalten eines beliebigen Ergebnisses liefern die Treiber nicht einheitlich | Design 030 E1–E4 |
| A49 | Daten bearbeiten: Änderungen sammelt das Fenster in einem reinen Puffer je Tab (Zeile = Werte ihres Primärschlüssels); geschrieben wird als Plan (`UpdatePlan`), aus dem das Backend je Zeile ein gebundenes `UPDATE` baut (`db/edit.rs`) und alle in einer Transaktion auf der Sitzung des Tabs ausführt – „genau eine Zeile“ je Anweisung, sonst Rollback (`ConnectionManager::apply_updates`). Optimistische Sperre über die alten Werte der geänderten Zellen ist Vorgabe. Nur Tabellen-Ansichten mit Primärschlüssel im Ergebnis | Design 031 E1–E6 |
| A50 | Zeilen einfügen und löschen gehören in denselben Puffer und denselben Plan wie geänderte Zellen: Geschrieben wird als Löschen → Ändern → Einfügen in einer Transaktion; jede Anweisung muss genau die Zeilen treffen, die sie abdeckt. Neue Zeilen mit denselben Spalten teilen sich ein `INSERT` (bis 200 Zeilen); scheitert ein solches, wird die Zeile in einer zweiten, immer zurückgerollten Transaktion gesucht. Undo ist ein Schnappschuss des Puffers. Eingefügte Blöcke liest ein reiner Parser | Design 032 E1–E6 |
| A51 | Eine Datei wird als Strom gelesen (`data_import.rs`: Kodierung → UTF-8, CSV/JSON Datensatz für Datensatz) und über die gebündelten, gebundenen `INSERT`s aus `edit.rs` geschrieben (`db/load.rs`) – kein `COPY`, kein `LOAD DATA`: Fehler je Zeile, ein Schreibweg für alle Treiber. Die Datei ist feindlich: Ihre Namen werden nur gequotet, ihre Werte nur gebunden; ein PostgreSQL-`CAST` trägt nie eine Größe (er würde kürzen). Eine Transaktion oder blockweise; der Schutz sieht das `INSERT` und das `DELETE` des Plans | Design 033 E1–E13 |
| A52 | Ein Release entsteht aus einem Tag: Version aus `package.json`, Pakete je System über `tauri-action` als Entwurf, Prüfsummen, Notizen aus den Commits. Signierung nur über Secrets der CI. Die Lizenztexte aller ausgelieferten Teile erzeugt ein eigenes Skript; `pnpm check` hält die Datei aktuell, jedes Paket trägt sie, der About-Dialog zeigt sie. Auto-Update bewusst noch nicht (braucht Schlüsselpaar, Signatur, erstes Release) | Design 034 E1–E10 |
| A53 | Server, die das Protokoll einer unterstützten Datenbank sprechen, sind keine eigene Art: Der Treiber stellt beim Verbinden fest, wer antwortet (`Flavor`), und weicht nur dort ab, wo der Server es verlangt (Abbruch, Zustand der Transaktion, Katalog). Was eine Verbindung kann, sagt sie dem Fenster als `Capabilities` | Design 035a E1–E5 |
| A54 | Die Suche auf dem Server ist ein lesender Job im Backend: je Tabelle eine Anweisung mit gebundenem Text (`LIKE … ESCAPE '!'`), begrenzt nach Treffern und Zeit, eine Tabelle nach der anderen; Definitionen liefert der Katalog, gesucht wird in Rust. Treffer kommen als Ereignisse und bleiben nach einem Abbruch stehen. Ein Treffer führt als Bedingung in eine Tabellen-Ansicht, nie als SQL | Design 036 E1–E9 |
| A55 | Das ER-Diagramm ist reine Logik im Fenster über drei Katalogfragen je Schema: Modell mit Kardinalität, eine eigene Anordnung in Schichten (keine Layout-Bibliothek: stabil, überlappungsfrei, klein), Export als Mermaid, DBML und SVG mit festen Farben. Gezeichnet wird SVG mit den vorhandenen Tokens; daneben steht dasselbe als Listen | Design 037 E1–E9 |
| A56 | Der Schema-Vergleich arbeitet auf Schnappschüssen (serialisierbar, auch als Datei): Vergleich und Migrationsskript sind reine Funktionen in Rust. Das Skript ist ein Vorschlag in fester, tragfähiger Reihenfolge; was Daten kosten kann, steht als markierter Kommentar; ausgeführt wird es nie von der App, sondern vom Nutzer in einem Tab | Design 038 E1–E8 |
| A57 | Ausführungspläne aller Datenbanken werden in ein Modell gelesen (Knoten mit Zeilen, Kosten, Zeit über alle Schleifen, Eigenzeit); die Parser sind rein und nachsichtig – Unbekanntes bleibt mit Rohdaten sichtbar. „Mit Ausführung“ führt aus: durch den Schutz, auf eigener Sitzung, in einer Transaktion, die immer zurückgerollt wird | Design 039 E1–E8 |
| A58 | Das Zeilen-Formular ist ein Seitenfeld neben dem Gitter ohne eigenen Zustand der Zeile: Es folgt dem Cursor des Gitters und bewegt ihn; bearbeitet wird über die Zelle des Gitters und ihren Puffer | Design 040 E1–E7 |
| A59 | Ein Tab hat neben den Anweisungen des letzten Laufs gehaltene Ergebnisse (angepinnt, Vergleiche). Der Vergleich zweier Ergebnisse läuft in Rust über den Ergebnisspeicher und merkt je Zeile nur Fingerabdrücke; sein Ergebnis ist selbst ein Ergebnis im Speicher (Zustand als erste Spalte) mit einer Sicht der Unterschiede – Gitter, Export und Suche brauchen keinen eigenen Weg | Design 041 E2, E6, E7 |
| A34 | Texte in typisierten Katalogen (Englisch Quelle, Deutsch typgeprüft), Sprache als Signal, Wechsel zur Laufzeit; `pnpm texts` hält Texte aus Templates und Deutsch aus dem Code. Ersetzt A10 | Design 017 E1–E6 |
| A35 | Einstellungen bleiben ein flaches, je Wert geprüftes Objekt; der Dialog hat ein eigenes Schema, ein Test hält beide zusammen. Keine Formularschicht: jede Änderung wirkt sofort | Design 017 E8, E9 |

## Offene Architekturfragen (entscheidet der jeweilige Prompt)

- **Treiber**: entschieden und umgesetzt (Design 003); CockroachDB und TimescaleDB über den PostgreSQL-Treiber
  (Design 035a); DuckDB, ClickHouse, Oracle und weitere bleiben mit Prompt 035 offen (Reihenfolge dort).
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
| `regex` | Suche im Ergebnis: Muster mit linearer Laufzeit und Größengrenze | Design 029 E4; war schon im Abhängigkeitsbaum, MIT/Apache-2.0 |
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
| `quick-xml` | Showplan-XML von SQL Server lesen (Design 039 E9) | schon im Baum (über Tauri/`plist`), MIT |
| `serde`, `serde_json` | DTOs; `serde_json` mit `raw_value`: JSON-Dateien beim Import ohne Verlust lesen (Zahlen Ziffer für Ziffer, Schlüssel in der Reihenfolge der Datei – Design 033 E2) | Standard; kein neues Paket, nur ein Feature |
| Dev: `vitest`, `jsdom`, `eslint`, `angular-eslint`, `typescript-eslint`, `prettier` | Tests, Lint, Format | wie die Vorgänger |
