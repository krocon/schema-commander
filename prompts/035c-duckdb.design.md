# Design 035c: DuckDB

> Durchlauf von [Prompt 035](035-weitere-datenbanken.md) für **DuckDB**. Stand: umgesetzt am 12.11.2026 mit
> DuckDB 2.0.0 (Treiber `duckdb` 1.20000.1). Die Tests brauchen keinen Server: Sie laufen mit jedem `cargo test`.

## Ergebnis in einem Satz

DuckDB ist eingebettet wie SQLite – eine Datei oder `:memory:` –, mit eigener `DbKind`: verbinden, ausführen,
Abbrechen, Baum, Details mit DDL, Tabellen-Ansicht, Bearbeiten, Suche und Diagramm funktionieren; Parquet-, CSV- und
JSON-Dateien liest eine Abfrage direkt. Ausführungsplan, Schema-Vergleich und Struktur bearbeiten gibt es noch nicht.

## Entscheidungen

| # | Entscheidung | Warum |
|---|---|---|
| E1 | Treiber **`duckdb`** (duckdb-rs, MIT) mit `bundled`, `parquet`, `json` | Der offizielle Rust-Treiber; DuckDB wird mitgebaut, niemand muss etwas installieren. Preis: C++-Build (hier 2,5 Minuten je Ziel, in der CI mehr; das macOS-Paket baut zwei Architekturen) und rund 50 MB mehr im Paket |
| E2 | **Eine Datenbank je Profil**, geteilt von allen Sitzungen (`SHARED`: Schlüssel = kanonischer Pfad bzw. `:memory:` + Profil-Id); jede Sitzung ist ein Klon der Verbindung | Eine DuckDB-Datei verträgt nur einen schreibenden Prozess, und Tabs einer Verbindung sollen dieselben Tabellen sehen – auch im Speicher. Die Datenbank lebt, solange eine Sitzung lebt |
| E3 | Geöffnet mit `autoinstall_known_extensions = false` und `autoload_known_extensions = false` | Sonst lädt DuckDB bei Bedarf Code aus dem Netz nach – ohne dass es jemand sieht. Parquet und JSON sind eingebaut; wer mehr will, schreibt `INSTALL …` selbst |
| E4 | Die Datei muss es geben (wie bei SQLite); `:memory:` ist erlaubt | Ein Tippfehler legt keine leere Datenbank an. Eine neue Datei entsteht mit `ATTACH 'neu.duckdb'` aus einer Datenbank im Speicher |
| E5 | **Transaktionszustand aus den Anweisungen** (`BEGIN`/`COMMIT`/`ROLLBACK` …), nach einem Fehler durch einen Versuch geprüft | DuckDB sagt es nicht: `is_autocommit` bleibt in einer Transaktion `true`. Die Sitzung sieht jede Anweisung ihrer Verbindung. Abweichung von der Regel „der Server sagt es“ – hier gibt es keine Auskunft |
| E6 | Werte: ganze Zahlen bis 64 Bit als Zahl, `UBIGINT`/`HUGEINT`/`DECIMAL` als exakter Text, Zeitstempel mit Zone als Zeitpunkt in UTC; **Listen, Structs, Maps, Enums** als Text in DuckDBs Schreibweise | verlustfrei, wo es geht; verschachtelte Werte sind zum Lesen da |
| E7 | Vor jedem Zellzugriff prüft `readable` den Arrow-Typ | Der Treiber endet bei Typen, die er nicht kennt (schon bei einer Spalte, die nur `NULL` ist), in `unreachable!` – das wäre ein Absturz des Threads |
| E8 | KI-Steuerung: `run_query` und `explain_query` lehnt die App für DuckDB ab; Struktur und Vorschläge bleiben | `SELECT * FROM read_csv('/irgendeine/datei')` ist dort eine lesende Abfrage: „lesen“ hieße, den Rechner zu lesen |
| E9 | Schutz: `INSTALL`, `LOAD`, `FORCE INSTALL`, `UPDATE EXTENSIONS` gelten als gefährlich; `COPY … TO`, `EXPORT`, `ATTACH` als schreibend bzw. DDL | Erweiterungen sind fremder Code; die übrigen schreiben Dateien |
| E10 | Dialekt wie PostgreSQL, wo er gleich ist: `"Name"`, `$1`, `LIMIT`, `ILIKE`, `RETURNING`; keine Savepoints (Import und Bearbeiten weichen aus), mehrere Anweisungen in einem Text zerlegt der Treiber selbst | geprüft im Probelauf |
| E11 | Katalog über DuckDBs Tabellenfunktionen (`duckdb_tables()`, `duckdb_columns()`, `duckdb_constraints()` …) der offenen Datenbank; DDL ist der Text, den DuckDB hält | einfacher und vollständiger als `information_schema` |
| E12 | `DbKind::is_file` / `isFileKind` statt Vergleichen mit SQLite | Zwei Datei-Datenbanken: kein Host, kein Passwort, kein Tunnel |

## Was noch fehlt (bewusst)

- **Ausführungsplan** (DuckDB liefert eine gezeichnete Textbox), **Schema-Vergleich**, **Struktur bearbeiten**.
- **Makros und Funktionen** im Baum; **Trigger** hat DuckDB nicht.
- Weitere angehängte Datenbanken (`ATTACH`) zeigt der Baum nicht – nur die geöffnete.
- Server-Monitor und Rechte gibt es bei einer eingebetteten Datenbank nicht.

## Nicht getestet

- Windows und Linux (der Build läuft dort erst in der CI), Dateien, die ein anderes Programm geöffnet hält.
- Import einer Datei und Kopieren zwischen Verbindungen mit DuckDB als Ziel oder Quelle.
- Sehr große Ergebnisse (die Tests schneiden bei 1000 Zeilen ab).

## Tests

`src-tauri/src/db/duckdb_tests.rs` (12 Tests): Typen samt Listen, Structs und Maps; Änderungen, Skripte, Grenzen,
Fehler mit Stelle; Abbruch und Zeitlimit (die Sitzung bleibt); geteilte Datenbank und Transaktionen über zwei
Sitzungen; Datei muss existieren, Parquet und CSV daneben, nichts wird nachgeladen; gebundene Werte; Metadaten,
Namensindex, Beziehungen, Diagramm, Details und DDL als Rundreise; Filtern, Sortieren, Bearbeiten; Suche; was fehlt,
sagt es. Dazu `guard.rs` (Erweiterungen) und im Fenster Zerlegen, Parameter, Dialog.

## Review

Siehe unten, sobald der zweite Blick durch ist.
