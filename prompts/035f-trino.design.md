# Design 035f: Trino und Presto

> Durchlauf von [Prompt 035](035-weitere-datenbanken.md) für **Trino** (und Presto, das dasselbe Protokoll spricht).
> Stand: umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026), geprüft gegen Trino 476
> (Container `trinodb/trino:476`, Kataloge `memory` und `tpch`) und Presto 0.300 (`prestodb/presto`).

## Reihenfolge der übrigen Datenbanken aus Prompt 035

Marc hat am 12.11.2026 die Anbindung von Snowflake, BigQuery, Trino/Presto, Db2, Firebird, libSQL/Turso und
Cloudflare D1 beauftragt. Reihenfolge nach „lässt sich hier prüfen“ und „passt zu dem, was schon da ist“:

| # | Datenbank | Weg | Prüfbar hier |
|---|---|---|---|
| 035f | **Trino / Presto** | HTTP, wie ClickHouse | Container |
| 035g | libSQL / Turso | HTTP (Hrana), Dialekt wie SQLite | Container (`sqld`) |
| 035h | Cloudflare D1 | HTTP (REST-API von Cloudflare), Dialekt wie SQLite | nur mit einem Konto |
| 035i | Firebird | reiner Rust-Treiber | Container |
| 035j | BigQuery | HTTP (REST), Anmeldung mit Dienstkonto | Emulator, sonst nur mit einem Konto |
| 035k | Snowflake | HTTP (SQL-API), Anmeldung mit Schlüsselpaar | nur mit einem Konto |
| 035l | Db2 | kein reiner Rust-Treiber: braucht IBMs CLI-Bibliothek | Container (amd64, emuliert) |

## Ergebnis in einem Satz

Trino ist eine eigene `DbKind` zum **Lesen und Auswerten**: verbinden, ausführen (auch schreibende Anweisungen im
Editor), abbrechen, Baum, Details mit DDL, Tabellen-Ansicht mit Filter und Sortierung, Suche auf dem Server,
Namensindex, Sitzung nur zum Lesen. Zeilen im Gitter ändern, Import, Testdaten und Kopieren bietet die App dort nicht
an: Der Katalog nennt keine Schlüssel, und was eine Transaktion hält, hängt am Konnektor hinter der Tabelle.

## Entscheidungen

| # | Entscheidung | Warum |
|---|---|---|
| E1 | **HTTP-Protokoll** (`/v1/statement`) mit `ureq`, kein fremder Client | Das Protokoll ist klein und dokumentiert; die vorhandenen Rust-Clients sind asynchron, ziehen `reqwest` nach und lesen typisierte Zeilen. Was die HTTP-Treiber teilen (Client mit TLS des Profils, Adresse, Fehler des Transports, Prozent-Kodierung), liegt jetzt in `db/http.rs` |
| E2 | Die Antwort kommt **seitenweise** (`nextUri`); zwischen zwei Seiten sieht der Treiber auf Stopp und Uhr und beendet eine Anweisung, indem er ihre nächste Seite löscht (`DELETE`) | Kein Wächter-Thread nötig: Der Server antwortet auch auf eine laufende Anweisung binnen ein, zwei Sekunden. Die Sitzung lebt weiter |
| E3 | Von `nextUri` wird nur der **Pfad** genommen (`/v1/…`); gefragt wird immer der Server des Profils | Der Server nennt sich mit seiner eigenen Adresse – durch einen Tunnel oder einen abgebildeten Port ist das eine andere. Und eine Anmeldung darf nie einer Antwort zu einem anderen Host folgen |
| E4 | **Sitzung** = was der Server in Kopfzeilen zurückgibt (Katalog, Schema, `SET SESSION`, `PREPARE`, Transaktion); der Treiber schickt es bei jeder Anfrage mit | HTTP ist zustandslos; so bleibt die Sitzung je Tab, was sie überall ist. `transaction_state` ist die Id, die der Server nennt – keine Annahme |
| E5 | **Werte**: Das Protokoll kennt keine gebundenen Parameter. Eine Anweisung mit Werten wird vorbereitet (Kopfzeile `Prepared-Statement`) und mit **Literalen ausgeführt, die der Treiber selbst schreibt** (`EXECUTE … USING`) – so macht es auch der JDBC-Treiber | Jede Form wird geprüft oder gequotet (`trino::literal`): Text mit verdoppeltem `'` (Trino kennt in einem String keine andere Maskierung), Zahlen nur aus Ziffern, Datum und Zeit nur, wenn `chrono` sie liest. Nichts vom Wert wird als SQL gelesen |
| E6 | Tabellen-Ansicht: Der Vergleichswert wird auf den **Typ der Spalte gecastet** (`CAST(? AS date)`), aber nur auf einen Typ aus einer festen Liste mit Größe aus Ziffern (`filter::trino_castable`) | Trino vergleicht einen Text mit nichts als einem Text. Der Typname kommt vom Server und wird darum nach seiner Form geprüft, nicht eingesetzt |
| E7 | „Enthält“ ohne `LIKE`: `strpos(…) > 0`, ohne Groß/Klein über `lower` | Ein Escape-Zeichen darf bei Trino nur vor `%`, `_` und sich selbst stehen; das gemeinsame Muster maskiert auch `[` |
| E8 | **Nur lesen**: `Session::make_read_only` (keine Anweisung, die jemand tippen könnte); der Treiber hält die Sitzung danach **immer** in einer Transaktion `START TRANSACTION READ ONLY` – er öffnet sie neu, wenn eine endete, und rollt nach einem Fehler zurück | Der Server lehnt Schreiben darin ab (`READ_ONLY_VIOLATION`, geprüft). Ein `COMMIT`/`ROLLBACK` des Nutzers beendet nur die eine Transaktion, nicht den Zustand: Das lässt sich in der Sitzung nicht zurücknehmen |
| E9 | Schutz: `TABLE(…)` in einer lesenden Anweisung gilt als **schreibend** | `TABLE(katalog.system.query(query => '…'))` reicht einen Text an die Datenbank hinter einem Katalog; was er dort tut, liest hier niemand. Ein Assistent bekommt das nicht ausgeführt |
| E10 | Ein Passwort geht **nur über TLS**; ohne TLS lehnt schon die App ab | Trino nimmt es ohne TLS nicht an, und bis zur Ablehnung wäre es im Klartext unterwegs gewesen |
| E11 | `database` des Profils ist der **Katalog** (Pflicht); seine Schemata zeigt der Baum. Metadaten aus `information_schema` des Katalogs, DDL über `SHOW CREATE TABLE/VIEW` mit gequoteten Namen | Was jeder Konnektor gemeinsam hat. Schlüssel, Indizes, Trigger und Routinen kennt dieser Katalog nicht |
| E12 | **Presto** ist keine eigene `DbKind`: Der Treiber sendet und liest beide Kopfzeilen-Familien (`X-Trino-…`, `X-Presto-…`); `Flavor::Presto` am Versionstext (`0.300` statt `476`). Die Version kommt von `/v1/info` – Presto kennt kein `version()` | wie bei den Verwandten von PostgreSQL; gegen den Container geprüft |
| E13 | Fehler: `errorName` → Code, `errorCode errorName` als Kennung, Zeile und Spalte des Servers → Zeichenposition; in einem Text aus mehreren Anweisungen auf den ganzen Text umgerechnet | Der Editor markiert die Stelle wie bei PostgreSQL |
| E14 | Neue direkte Abhängigkeit `base64` (stand schon im Baum) | `varbinary` kommt als Base64, die Anmeldung geht als Basic-Auth |

## Was noch fehlt (bewusst)

- **Schreiben im Gitter, Import, Testdaten, Tabellen kopieren** (kein Schlüssel im Katalog). `INSERT`, `UPDATE`,
  `MERGE` als Anweisung im Editor gehen, soweit der Konnektor sie kann.
- **Manueller Transaktionsmodus** des Tabs (der Umschalter hängt am Flag `edit`). `START TRANSACTION` … `COMMIT` im
  Editor gehen und werden angezeigt.
- **Ausführungsplan** (`EXPLAIN` liefert Text; `EXPLAIN (FORMAT JSON)` wäre der Weg), **Server-Monitor**
  (`system.runtime.queries`), **Rechte**, **Schema-Vergleich**, **Struktur bearbeiten**.
- Anmeldung nur mit Benutzer und Passwort (Basic über TLS) oder ohne: **kein OAuth 2, Kerberos, JWT, Zertifikat als
  Anmeldung** – das Client-Zertifikat des Profils wird für TLS gesendet, ob der Server sich damit anmelden lässt,
  ist nicht geprüft.
- Materialisierte Views erscheinen als Tabellen; Kommentare, Tabelleneigenschaften und Statistiken (`SHOW STATS`)
  stehen nicht in den Details. Mehrere Kataloge in einem Baum gibt es nicht: ein Profil je Katalog (im Editor ist
  jeder Katalog erreichbar: `katalog.schema.tabelle`).
- Eine Anweisung mit Werten darf 48 KB lang sein (sie reist in einer Kopfzeile).
- Zeitstempel mit benannter Zone (`Europe/Berlin`) zeigt die App als Text, wie der Server sie schreibt; `time with
  time zone` ebenso.

## Nicht getestet

- **TLS**, **Passwort**, **SSH-Tunnel** (die Container sprechen nur HTTP ohne Anmeldung), Starburst/Galaxy, ältere
  Versionen als Trino 476 und Presto 0.300, Konnektoren außer `memory`, `tpch`, `system`.
- Presto nur in einem Durchlauf (`presto_answers_like_trino`, mit `SC_DBTEST_PRESTO=1`): Typen, Seiten, Grenze,
  Werte, Fehler, Sitzung, Transaktion, Baum, nur lesen. Details mit DDL, Suche und Filter liefen dort nicht. Arrays,
  Maps und Rows schreibt Presto als JSON-Text in eigener Formatierung – die App zeigt ihn so.
- Das native Fenster (`pnpm tauri dev`) wurde nicht bedient; im Browser ohne Backend ist der Verbindungsdialog
  gesehen (Trino / Presto wählbar, Feld „Katalog“, Port 8080).

## Tests

- `src-tauri/tests/trino_integration.rs` (8 Tests, `pnpm rust:test:db`): Typen, Unicode, NULL; Skripte, Seiten
  (15 000 Zeilen), Grenze mit Abbruch auf dem Server, `USE`/`SET SESSION`/`PREPARE` bleiben in der Sitzung, Fehler
  mit Stelle (auch in der zweiten Anweisung), Fehler mitten im Ergebnis; Transaktion nach den Kopfzeilen; unbekannter
  Katalog, Passwort ohne TLS, kein Server; Abbruch und Zeitlimit mit weiterlebender Sitzung, nichts läuft weiter;
  Werte als Literale (auch böse), nur lesende Sitzung gegen sechs Versuche zu schreiben; Metadaten, Namensindex,
  Details mit DDL als Rundreise, Namen mit Quote; Suche; Filtern, Sortieren mit NULLs, und dass Bearbeiten abgelehnt
  wird.
- Unit-Tests: `trino.rs` (Fehler, Typen, Werte, Literale, Zerlegen, Pfad der nächsten Seite), `http.rs`,
  `filter.rs` (Cast nur auf Typen der Liste), `guard.rs`, `mod.rs` (Flags); im Fenster Zerlegen, Parameter.

## Review

Ein zweiter, nur lesender Blick über den Branch, gegen den laufenden Server geprüft. Keine Injektion, kein Weg der
Anmeldung zu einem anderen Host, kein Umgehen von „nur lesen“ gefunden. Behoben, mit Tests
(`review_a_cut_result_keeps_the_session_and_errors_say_where`, `guard.rs`, `filter.rs`):

| # | Befund | Behebung |
|---|---|---|
| 1 (hoch) | Ein abgeschnittenes Ergebnis wurde auf dem Server beendet – das bricht dort die Transaktion ab: In einer nur lesenden Sitzung scheiterte die nächste Anweisung, die Transaktion eines Nutzers war tot und galt noch als offen | Nur lesend: zurückrollen und neu öffnen. In einer Transaktion des Nutzers wird nicht abgebrochen, der Rest der Antwort wird gelesen und verworfen (bis sie endet oder gestoppt wird) |
| 2 | Der Server verwirft eine Transaktion nach fünf Minuten ohne Anweisung: Die erste Anweisung danach scheiterte in nur lesenden Sitzungen | `UNKNOWN_TRANSACTION`/`TRANSACTION_ALREADY_ABORTED` → neue Transaktion, ein zweiter Versuch. **Nicht gegen die Uhr geprüft** (der Reviewer hat die Meldung nach 400 s gesehen) |
| 3 | Ein Syntaxfehler in einer Anweisung mit Werten kam als Verbindungsfehler ohne Stelle (HTTP 400 zur Kopfzeile) | wird als Fehler der Anweisung gelesen, mit Zeile und Position |
| 4 | Die Suche auf dem Server scheiterte an Tabellen mit `json`-, `array`-, `map`-, `row`-Spalten | solche Spalten werden nicht durchsucht |
| 5 | „Enthält“ scheiterte an `char(n)` | die Spalte wird immer auf `varchar` gecastet |
| 6 | Wörter der Sprache als Namen (`skip`, `trim`, `extract` …) wurden nicht gequotet | in der Liste der reservierten Wörter (für alle Datenbanken: ein Quote zu viel schadet nicht) |
| 7 | Eine Anweisung wurde nach 502–504 erneut gesendet – hinter einem Gateway kann ein `INSERT` so zweimal laufen | erneut nur nach 503 des Koordinators; Seiten weiter nach 502–504 |
| 8 | Wer `START TRANSACTION READ ONLY` tippte, machte seine Sitzung für immer nur lesend | eigene Methode der Sitzung (`make_read_only`) statt einer Anweisung |
| 9 | Nach einem Fehler beim Holen einer Seite lief die Anweisung auf dem Server weiter | die nächste Seite wird in jedem Fall gelöscht |
| 10 | Kommentar endet auch an `\r`; der Schutz hielt `'C:\\'` für mehrdeutig (Trino kennt kein Backslash-Escape); der Name der vorbereiteten Anweisung konnte mit einem des Nutzers zusammenfallen; altes Presto antwortet auf DDL mit einer Spalte | behoben |

Offen geblieben:

- `SET ROLE`, `SET PATH` melden Erfolg und wirken nicht (ihre Kopfzeilen liest der Treiber nicht); `SET SESSION
  AUTHORIZATION` lehnt der Server ab.
- Die Tabellen-Ansicht nennt `schema.tabelle` ohne Katalog: Nach `USE anderer_katalog.x` im selben Tab liest ein
  erneutes Filtern im falschen Katalog.
- „Enthält“ auf einer `json`-Spalte scheitert (kein Cast nach `varchar`); der Server sagt es.
- In einer Transaktion des Nutzers liest ein abgeschnittenes Ergebnis den Rest der Antwort mit – bei sehr großen
  Tabellen dauert das, bis man abbricht (und der Abbruch beendet dann die Transaktion).
