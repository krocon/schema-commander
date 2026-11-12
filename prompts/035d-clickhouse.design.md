# Design 035d: ClickHouse

> Durchlauf von [Prompt 035](035-weitere-datenbanken.md) für **ClickHouse**. Stand: umgesetzt am 12.11.2026,
> geprüft gegen ClickHouse 25.8 (Container `clickhouse/clickhouse-server:25.8`).

## Ergebnis in einem Satz

ClickHouse ist eine eigene `DbKind` zum **Lesen und Auswerten**: verbinden, ausführen, abbrechen, Baum, Details mit
DDL, Tabellen-Ansicht mit Filter und Sortierung, Suche auf dem Server, Namensindex. Zeilen im Gitter ändern, Dateien
importieren und Tabellen kopieren bietet die App dort nicht an – ohne Transaktionen und eindeutige Schlüssel ginge
das nicht sicher.

## Entscheidungen

| # | Entscheidung | Warum |
|---|---|---|
| E1 | **HTTP-Schnittstelle** mit `ureq` (blockierend, rustls mit ring) statt des Crates `clickhouse` | Der offizielle Rust-Client ist für feste, typisierte Zeilen gebaut (serde), nicht für beliebige Abfragen eines SQL-Clients. HTTP ist dokumentiert und stabil; `ureq` steht schon im Abhängigkeitsbaum |
| E2 | Ergebnisse im Format **`TabSeparatedWithNamesAndTypes`**, zeilenweise gelesen | Jeder Wert kommt als Text: keine Ziffer geht verloren (UInt64, Decimal, Int256), und es braucht **keine Einstellung** – eine Sitzung mit `readonly = 1` darf keine ändern (im Versuch scheiterte daran die JSON-Variante) |
| E3 | Eine Sitzung ist eine `session_id` des Servers (`SET …` und temporäre Tabellen bleiben); gehalten wird keine Verbindung | HTTP ist zustandslos; die Sitzung je Tab bleibt so, was sie bei den anderen Datenbanken ist |
| E4 | Abbruch und Zeitlimit: ein Wächter schickt `KILL QUERY WHERE query_id = …` (die Id vergibt die App); die Sitzung bleibt | `max_execution_time` wäre eine Einstellung (siehe E2) |
| E5 | **Keine Transaktionen**: `transaction_state` ist immer „keine“; `edit::steps`, `transfer::plan` lehnen ClickHouse ab, Fähigkeits-Flag `edit` blendet Bearbeiten, Import, Testdaten und Kopieren aus | Ein „Primärschlüssel“ sagt dort, wie sortiert wird, nicht, dass Zeilen eindeutig sind; `ALTER … UPDATE` ist eine asynchrone Mutation. Ein Gitter, das Zellen schreibt, würde etwas versprechen, das die Datenbank nicht hält |
| E6 | Gebunden wird über `param_pN` mit Platzhaltern `{pN:String}` (ganze Zahlen `Int64`, Wahrheitswerte `Bool`) | Der Server liest einen Text als das, womit er verglichen wird (Zahl, Datum, Decimal) – geprüft |
| E7 | „Enthält“ ohne `LIKE`: `position(…) > 0` bzw. `positionCaseInsensitiveUTF8` | ClickHouse kennt kein `ESCAPE`; so sind `%` und `_` einfach Zeichen |
| E8 | Nur lesen: `SET readonly = 1` in der Sitzung (nicht 2) | Mit `readonly = 2` schrieb `INSERT INTO FUNCTION file(…)` im Versuch trotzdem; mit 1 nicht, und die Einstellung lässt sich in der Sitzung nicht zurücknehmen |
| E9 | Schutz: `SYSTEM …` und `KILL …` gelten als gefährlich | Sie treffen den Server und andere |
| E10 | TLS über HTTPS: geprüft wird Zertifikat **und** Name oder nichts („nur CA“ gibt es bei HTTPS nicht); eigene CA und Client-Zertifikat aus dem Profil | wie beim SQL-Server-Treiber dokumentiert |
| E11 | Katalog aus `system.databases`, `system.tables`, `system.columns`; DDL ist `create_table_query` | gebundene Parameter, nichts zusammengesetzt |
| E12 | Mehrere Anweisungen in einem Text zerlegt der Treiber (der Server nimmt eine je Anfrage) | wie die anderen Treiber: ein Skript läuft, die letzte Anweisung antwortet |

## Was noch fehlt (bewusst)

- **Schreiben im Gitter, Import, Testdaten, Tabellen kopieren** (E5). `INSERT` als Anweisung im Editor geht natürlich.
- **Ausführungsplan** (`EXPLAIN` liefert Text), **Server-Monitor** (`system.processes`), **Rechte**, **Schema-Vergleich**,
  **Struktur bearbeiten**.
- Wörterbücher, Funktionen und benannte Sammlungen im Baum; Cluster (`ON CLUSTER`) kennt die App nicht eigens.
- `DateTime` zeigt die App so, wie der Server sie schreibt (in der Zone der Spalte bzw. des Servers), ohne Zone.

## Nicht getestet

- **TLS** und **SSH-Tunnel** (der Container spricht nur HTTP), ClickHouse Cloud, ältere Versionen als 25.8.
- Ein Fehler **mitten** im Ergebnis kommt als Textzeile des Servers; der Treiber erkennt sie an ihrem Anfang
  (`Code: … DB::Exception`) und der Spaltenzahl. Ein Wert, der genau so aussieht, in einem Ergebnis mit einer Spalte
  würde als Fehler gelesen.

## Tests

- `src-tauri/tests/clickhouse_integration.rs` (7 Tests, `pnpm rust:test:db`): Typen, Unicode, NULL; Skripte, Grenzen,
  Fehler mit Stelle, Fehler mitten im Ergebnis; falsches Passwort, unbekannte Datenbank, kein Server; Abbruch und
  Zeitlimit mit weiterlebender Sitzung; gebundene Werte und eine nur lesende Sitzung; Metadaten, Namensindex,
  Details mit DDL als Rundreise, Suche; Filtern und Sortieren, und dass Bearbeiten abgelehnt wird.
- Unit-Tests: `clickhouse.rs` (Fehlertexte, Typen, Werte, Zerlegen), `guard.rs`, `mod.rs` (Flags); im Fenster
  Zerlegen, Parameter.

## Review

Ein zweiter, nur lesender Blick über den Branch. Behoben, je mit Test (die ersten drei gegen den Container bestätigt):

| # | Befund | Behebung |
|---|---|---|
| 1 (hoch) | Der Server liest einen `param_…` in seiner maskierten Form: `C:\temp` kam als `C:<Tab>emp` an, ein echter Tab ließ die Anfrage scheitern | Werte werden maskiert (`\\`, `\t`, `\n`, `\r`, `\0`) |
| 2 (hoch) | In Backticks ist `\` dort ein Escape (anders als bei MySQL): Ein Name mit `\`` beendete seine Quotes, und der Schutz sah ein `DROP` dahinter nicht | `meta::quote` schreibt den Backslash aus; `guard::scan` nimmt ihn in Backticks als Escape |
| 3 | Bytes, die kein UTF-8 sind (`unhex('FF')`), brachen die Abfrage ab | Zeilen werden als Bytes gelesen, Unlesbares als Ersatzzeichen gezeigt |
| 4 | Ohne Antwort des Servers hing eine Anfrage endlos | Mit Zeitlimit gibt auch die Anfrage selbst auf (Limit + 15 s). **Offen:** Ohne Limit und bei totem Netz wirkt „Abbrechen“ erst, wenn das Betriebssystem die Verbindung aufgibt |
| 6 | Ein Tab im manuellen Modus schickte `BEGIN TRANSACTION` | Das Backend sagt, dass es dort keine Transaktionen gibt; der Umschalter im Fenster ebenso |
| 7 | Tabellenfunktionen, die die Datenbank verlassen (`url`, `remote`, `file`, `s3` …), galten als lesend | für ClickHouse nicht mehr: Ein Assistent bekommt sie nicht ausgeführt |
| 8 | Ein abgeschnittenes Ergebnis lief auf dem Server weiter | `KILL QUERY`, sobald keine Zeilen mehr gewollt sind |
| 9 | Import und Kopieren blieben im Menü; vor einem abgelehnten Import hätte eine Tabelle entstehen können | Aktionen hängen am Flag `edit`; `create_table` lehnt ab |
| 10 | IPv6-Adressen ohne Klammern | werden geklammert |

Offen geblieben:

- `#`-Kommentare, Heredocs (`$tag$…$tag$`) und verschachtelte Kommentare kennt weder der Treiber beim Zerlegen noch
  das Fenster: Solche Skripte lehnt der Server ab (kein falscher Lauf).
- Ein UInt64-Filterwert über 2⁶³ wird abgelehnt; `rows_affected` fehlt bei einem `INSERT` hinter einem Kommentar.
