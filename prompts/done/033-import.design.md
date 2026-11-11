# Design 033: Import aus CSV und JSON

> **Status:** umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/import` · Auftrag: [033-import.md](033-import.md) · Feature F2

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Lesen | `data_import.rs` (rein): die Datei ist ein **Strom**. `Transcoder` macht aus jeder Kodierung UTF-8 (BOM, UTF-16 LE/BE, Windows-1252; was kein Text ist, wird U+FFFD), gzip wird am Anfang erkannt. `CsvReader` liest Datensatz für Datensatz (Anführungszeichen, verdoppelte Anführungszeichen, Umbrüche im Feld, LF/CRLF/CR), `JsonArray` Element für Element, NDJSON Zeile für Zeile. Grenzen: 64 MB je Feld, 2000 Spalten | Aufgabe 1; 500 000 Zeilen mit 14,6 MB Speicher |
| E2 | JSON ohne Verlust | Objekte werden mit `serde_json` (`raw_value`) gelesen: Zahlen bleiben Ziffer für Ziffer (`2.50` bleibt `2.50`), Schlüssel in der Reihenfolge der Datei. Verschachtelte Werte kommen als ihr JSON-Text an | sonst gingen Nachkommastellen verloren |
| E3 | Erkennen | Aus den ersten 256 KB: Format (Endung, dann Inhalt), Kodierung, **Trenner** (der Kandidat aus `, ; Tab |`, bei dem die meisten Datensätze so viele Felder haben wie der erste – gezählt je Datensatz, nicht je Zeile), **Kopfzeile** (alle Zellen da, verschieden, keine Zahl). Alles im Dialog überschreibbar; die Vorschau liest dann neu | Aufgabe 1, 2 |
| E4 | Zu viele Felder | Ein CSV-Datensatz mit **mehr Feldern als Spalten** ist ein fehlerhafter Datensatz (ein Trenner ohne Anführungszeichen im Wert würde sonst alles dahinter stillschweigend abschneiden). Leere Felder am Ende (Trenner hinter dem letzten Wert) zählen nicht. Zu wenige Felder: was fehlt, ist leer | Datenverlust ohne Meldung |
| E5 | Typen | Stichprobe von 2000 Datensätzen: der engste Typ, in den jeder Wert passt – Ganzzahl, Dezimal, Bool, Datum, Datum/Zeit, sonst Text mit der größten Länge. Der Vorschlag für `CREATE TABLE` gibt Texten doppelte Länge (20 … 4000, darüber `text`/`longtext`/`nvarchar(max)`). **Späterer Widerspruch** (Zeile 2001 passt nicht): Die Datenbank lehnt die Zeile ab – sie steht im Bericht bzw. beendet den Import; nichts wird passend gemacht | Entscheidungsfrage 2 |
| E6 | Neue Tabelle | `load_table_ddl` baut das `CREATE TABLE` im Backend (Namen der Datei durch `quote`), der Dialog zeigt es **änderbar**. Ausgeführt wird der Text von `load_create_table` – nur wenn der Schutz ihn als **DDL** einstuft (kein `DROP`, kein zweites Schreiben), über `admit` wie jede Anweisung. Danach ist die Tabelle eine vorhandene: Ihre Spalten werden aus dem Katalog gelesen | Aufgabe 3; einzige Stelle, an der Text aus dem Fenster läuft – wie im Editor |
| E7 | Zuordnung | Je **Zielspalte**: Spalte der Datei, fester Wert oder nichts (dann nennt das `INSERT` die Spalte nicht: Default der Datenbank). Automatisch nach Namen (ohne Groß/Klein und Satzzeichen), passt kein Name, nach Stelle. Umwandlung für alle Spalten: Leerraum entfernen, Dezimalkomma (nur Zahlspalten), Datum Tag-zuerst/Monat-zuerst (nur Datumsspalten). **Kein Ausdruck** als fester Wert: Das wäre SQL aus dem Fenster | Aufgabe 4 |
| E8 | **Schreiben** | Gebundene Stapel-`INSERT`s aus `edit.rs` (bis 200 Zeilen und 2000 Werte je Anweisung), Namen durch `meta::quote`, **jeder Wert gebunden**; in PostgreSQL mit `CAST` auf den Typ der Spalte – **ohne Größe** (`character varying(20)` → `varchar`), damit zu lange Werte abgelehnt statt gekürzt werden. **Kein `COPY`, kein `LOAD DATA`**: `COPY` meldet Fehler nicht je Zeile (ein Fehler bricht alles ab), braucht ein eigenes Format samt Escaping und einen dritten Schreibweg je Treiber; `LOCAL INFILE` bleibt aus Sicherheitsgründen aus. Gemessen: 58 000 Zeilen/s nach PostgreSQL | Entscheidungsfrage 1 |
| E9 | Transaktion | **Eine Transaktion** (Vorgabe, nur mit „abbrechen“): alles oder nichts – auch „vorher leeren“ wird zurückgenommen. Sonst **blockweise**: jeder Stapel eine Transaktion; was geschrieben ist, bleibt, der Bericht nennt die Zahl | Aufgabe 6 |
| E10 | Fehler | „Abbrechen“: Der erste Fehler beendet den Import; bei einem Stapel nennt der Bericht den Zeilenbereich. „Überspringen“: Ein gescheiterter Stapel wird zurückgerollt und **Zeile für Zeile** geschrieben (eine Transaktion, Savepoint je Zeile); was die Datenbank ablehnt, nicht lesbar oder nicht umwandelbar ist, steht mit Zeilennummer, Grund und Originalzeile in der **Fehlerdatei** (TSV, Pfad aus dem Speichern-Dialog) und – die ersten 20 – im Bericht | Aufgabe 7 |
| E11 | Schutz | `load_run` baut alle Anweisungen selbst aus dem Plan und lässt vorher das `INSERT` (und das `DELETE` für „vorher leeren“, als gefährlich eingestuft) durch `admit`; das Fenster fragt wie überall über `check_statements`/`confirm_statements` | Aufgabe 5, Prompt 012 |
| E12 | Job | `load_run` ist ein Job (Ids ab 5 · 10⁹) mit Fortschritt (gelesene Datensätze) und `cancel_job`; er läuft auf der Sitzung der Verbindung. Der Dialog bleibt offen und zeigt Fortschritt, dann den Bericht | Aufgabe „als Job mit Fortschritt“ |
| E13 | Leeren | „Vorher leeren“ ist `DELETE FROM`, nicht `TRUNCATE`: überall zurückrollbar | Abbruch räumt auf |

## Verträge

`load_preview(path, options, nulls) → Preview`, `load_table_ddl`, `load_create_table`, `load_statements(id, plan) →
string[]`, `load_run(jobId, id, path, options, plan, errorPath, confirmations, allowDangerous, timeoutMs,
onProgress) → Loaded { read, written, skipped, errors, cancelled, failed, rolledBack, errorFile }`. Fenster:
`DataImportApi` (`core/import/`), `DataImportService`, `DataImportDialog`, `data-import-logic.ts`. Aktionen
`IMPORT_DATA` (Datei-Menü), `SCHEMA_IMPORT_TABLE` (Knoten einer Tabelle).

## Geprüft

- **Rust, Leser** (15 Tests): CSV mit Anführungszeichen, Umbrüchen im Feld und jedem Zeilenende; Trenner, Kopfzeile,
  Zeilennummern; alle Kodierungen, ein Zeichen über eine Blockgrenze; JSON-Array und NDJSON Objekt für Objekt; gzip;
  Typ-Erkennung; Vorschau; Trenner bei mehrzeiligen Feldern; Datensatz mit zu vielen Feldern.
- **Rust, Schreiben** (7 Tests gegen SQLite): Zuordnung und Umwandlung; **Katalog böser Namen und Werte** (nichts
  davon wird SQL, in allen vier Dialekten); `CREATE TABLE` je Dialekt; alles-oder-nichts, Überspringen mit
  Fehlerdatei, „vorher leeren“ samt Rücknahme; 20 000 Zeilen blockweise, Abbruch in beiden Arten.
- **Gegen echte Server** (PostgreSQL, MySQL, MariaDB, SQL Server; `a_file_is_loaded_into_a_table_and_comes_back_the_same`):
  3003 gute und 5 schlechte Zeilen (kein Name, Name zu lang, Schlüssel doppelt, 31.02., keine Zahl) – in einer
  Transaktion bleibt die Tabelle leer; mit Überspringen sind 3003 Zeilen da und die fünf mit ihren Zeilennummern in
  der Fehlerdatei; Werte mit `'`, `;`, Umbruch, Umlauten kommen unverändert an. **Rundreise mit dem Export (011)**:
  Tabelle als CSV exportiert, in eine zweite geladen – beide gleich. Abbruch blockweise (Geschriebenes bleibt,
  Zahl stimmt) und in einer Transaktion (Tabelle wie vorher).
- **Große Datei** (`a_large_file_is_loaded_block_by_block`, Release): 500 000 Zeilen nach PostgreSQL in 8,6 s,
  höchstens 14,6 MB Speicher, Anzahl und Summen stimmen. Fünf Millionen wurden nicht eigens geladen (hochgerechnet
  etwa 90 s; der Speicher wächst nicht mit der Datei).
- **Fenster**: Logik (9 Tests), Dialog (8 Tests: Vorschau als Text, Zuordnung, neues Lesen bei geänderter Option,
  Start mit Plan und Rückfrage, Nein des Schutzes, neue Tabelle, Fehler).
- **Im Browser** mit nachgebildetem Backend: Datei wählen → Vorschau (ein Wert `<img …>` steht als Text da), erkannte
  Angaben, Zuordnung nach Namen (`Ordered at` → `ordered_at`), Umwandlungen, Fehlerdatei, Start → Fortschritt →
  Bericht mit Zahlen und ersten Problemen. **Nicht bedient:** das native Fenster (`pnpm tauri dev`) mit echtem
  Datei-Dialog.
- Nach dem Review: MyISAM/Aria Zeile für Zeile (MySQL, MariaDB), Tag und Zeit für `datetime` in SQL Server unter
  deutscher Sprache. Ganze Treiber-Suite: 38 Tests grün.
- `pnpm check` grün (904 Tests im Fenster, 294 in Rust).

## Review (zweiter Agent, nur lesend: Die Datei ist feindlich)

**Einschleusen:** kein Weg gefunden. Namen gehen nur durch `filter::name`/`meta::quote`, Werte sind immer `Bind`s,
ein `CAST` nimmt nur die Form eines Typnamens; `shape()` und die laufenden Anweisungen kommen aus demselben Erzeuger;
der Dialog zeigt Inhalte nur als Text. Die Befunde betreffen Datenkorrektheit, Fehlerpfade und Speicher – alle
behoben, jeweils mit rotem Test zuerst, soweit nicht anders vermerkt:

| Befund | Behoben |
|---|---|
| **H1** Dezimalkomma: `2.000` blieb `2.000` (also 2), `1.2.3,4` wurde `123.4` | Mit Dezimalkomma gruppiert ein Punkt **immer** drei Ziffern; alles andere ist ein Fehler der Zeile |
| **H2** Ein nie geschlossenes Anführungszeichen machte den Rest der Datei zu **einem** Wert, ohne Meldung | Dateiende im Anführungszeichen = fehlerhafter Datensatz („a quote is not closed“) |
| **M3** Nicht dekodierbare Bytes wurden als U+FFFD geschrieben | Ein Wert mit U+FFFD ist ein Fehler der Zeile |
| **M4** JSON: Schlüssel, die erst nach der Stichprobe auftauchen, fielen weg | Objekt mit unbekanntem Schlüssel = fehlerhafter Datensatz |
| **M5/M6** Ein gescheitertes `COMMIT` ließ die Transaktion offen; jeder Fehlerausgang verwarf den Bericht (wie viele Zeilen schon in der Tabelle sind) | `load` ist neu gebaut (`Loader`): Nach dem Start endet alles im Bericht (`failed`/`cancelled` mit den Zahlen), eine offene Transaktion wird immer zurückgerollt, die Fehlerdatei immer abgeschlossen. `COMMIT`-Fehler zählen wie Fehler der Anweisung |
| **M7** „Überspringen“ versuchte nach einem Zeitlimit jede Zeile einzeln (jede wartet erneut) | Zeitlimit und verlorene Verbindung beenden den Import |
| **M8** Einzelversuche liefen ohne Transaktion: Eine Zeile mit „nicht genau eine Zeile“ (Trigger, View) galt als ausgelassen und blieb doch | Einzelversuche in **einer Transaktion mit Savepoint je Zeile**; nimmt ein Fehler die Transaktion mit (SQL Server) oder scheitert erst das `COMMIT` (verzögerte Constraints), läuft der Block mit einer Transaktion je Zeile |
| **M9** Unbegrenzte Puffer | JSON-Skalar und übersprungene Zeilen begrenzt; Stichprobe höchstens 16 MB; Vorschau-Zellen auf 300 Zeichen gekürzt; ein Block schließt bei 8 MB |
| **M10** SQL Server las `2026-03-05` für `datetime` nach der Sprache des Logins | Tag allein → `20260305`, Zeit ohne Sekunden → `…T10:30:00` (Test gegen den Server mit `SET LANGUAGE German`) |
| **M11** `load_create_table` ließ jede DDL und mehrere Anweisungen durch | `guard::is_create_table`: genau **eine** Anweisung `CREATE [TEMP…] TABLE`, nichts dahinter; mit Zeitlimit |
| **M12** Start war möglich, während die Vorschau neu las (Zuordnung für alte Spalten); der Lauf erkannte Trenner/Kopfzeile erneut | „Importieren“ gesperrt, solange gelesen wird; der Lauf liest mit den **erkannten** Angaben der Vorschau; ein Plan, der auf eine fehlende Spalte zeigt, wird abgelehnt |
| **L13** Datumsreihenfolge auch auf `time`-Spalten | nur Datums- und Zeitstempel-Typen; eine Zeit allein bleibt, wie sie ist |
| **L14** Leeres/Leerraum in Zahl- und Bool-Spalten | dort immer getrimmt, leer = `NULL` |
| **L16** „Vorher leeren“ blockweise: Scheitern danach sagte nicht, dass die Tabelle leer ist | `cleared` im Bericht, der Dialog sagt es |
| **L17** Trenner wurde aus übersprungenen Zeilen erraten; Überspringen kannte nur `\n` | Stichprobe ohne die übersprungenen Zeilen; jedes Zeilenende |
| **L18** Fehlerdatei = Quelldatei über andere Schreibweise des Pfads | Vergleich der aufgelösten Pfade (`.`, Links, Groß/Klein) |
| **L19** Grenze 1000 Spalten (erlaubt sind 400); `raw.pop()` entfernte ein Datenbyte | behoben |
| **S1** MySQL/MariaDB ohne Transaktionen (MyISAM, Aria): Teilzeilen blieben, Einzelversuche schrieben sie doppelt | Die Engine wird gelesen: „alles oder nichts“ wird abgelehnt, sonst Zeile für Zeile (Test gegen beide Server) |
| **S4** PostgreSQL-Typen wie `timestamp(3) without time zone` bekamen keinen `CAST` | Größe hinter dem ersten Wort erlaubt – dahinter nur die festen Wörter der Zeittypen (der Katalog böser Typnamen hat die erste Fassung abgefangen) |
| **S5** SQLite und MySQL ohne strikten Modus nehmen Nicht-Zahlen an | Zahlspalten werden vor dem Senden geprüft |

Offen gelassen (bewusst): **L15** der Vorschlag `decimal(38, 10)` rundet mehr als zehn Nachkommastellen in MySQL und
SQL Server; Typen mit Schema (`anderes.enum`) bekommen in PostgreSQL keinen `CAST` und scheitern laut; Datumswerte
werden nicht vorab geprüft (SQLite speichert jeden Text); die dritte Spalte der Fehlerdatei ist die Originalzeile
unverändert (in einer Tabellenkalkulation kann sie als Formel gelesen werden); die Fehlerdatei ist nicht nach
Zeilen sortiert.

## Nicht umgesetzt

- **Upsert** über einen Schlüssel (Aufgabe 5): je Dialekt eine eigene Anweisung (`ON CONFLICT`, `ON DUPLICATE KEY`,
  `MERGE`) mit eigener Zählung der betroffenen Zeilen – ein eigener Schritt.
- **`.xlsx`** lesen (als „optional“ genannt): bräuchte einen Leser als neue Abhängigkeit.
- PostgreSQL **`COPY`** (E8).
- Ein **Ausdruck** als fester Wert (E7); Umwandlung **je Spalte** (sie gilt für alle Spalten der passenden Art).
- Die Vorschau ist eine einfache Tabelle der ersten 20 Datensätze, nicht das Ergebnisgitter.
- Der Fortschritt zählt gelesene Datensätze, keinen Anteil der Datei; während des Imports wartet der Schema-Baum
  dieser Verbindung (dieselbe Sitzung).
- MyISAM-/Aria-Tabellen kennen keine Transaktion: „alles oder nichts“ gilt dort nicht.
