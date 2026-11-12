# Design 035j: Google BigQuery

> Durchlauf von [Prompt 035](035-weitere-datenbanken.md) für **BigQuery**. Stand: umgesetzt am 12.11.2026 (ohne
> Freigabe-Halt, Marcs Anweisung vom 11.11.2026) – geprüft gegen den **Emulator** (`goccy/bigquery-emulator`) und
> einen nachgestellten Server, **nicht gegen Google**: Dafür braucht es ein Projekt und ein Dienstkonto.

## Ergebnis in einem Satz

BigQuery ist eine eigene `DbKind` zum **Lesen und Ausführen**: verbinden mit der Schlüsseldatei eines Dienstkontos,
Anweisungen ausführen und abbrechen, Baum (Datasets, Tabellen, Spalten), Details mit DDL, Tabellen-Ansicht mit
Filter, Suche. Zeilen im Gitter ändern, Import und Kopieren gibt es dort nicht.

## Entscheidungen

| # | Entscheidung | Warum |
|---|---|---|
| E1 | **REST-API** (`jobs.query`, `jobs.getQueryResults`, `jobs.cancel`) mit `ureq`, kein fremder Client | die Rust-Clients für Google Cloud sind asynchron und ziehen `reqwest`, `tonic` und Dutzende Crates nach; gebraucht werden drei Aufrufe |
| E2 | Das Profil: **Datenbank = Projekt-ID**, **Benutzer = Ort der Jobs** (`EU`, `US`, `europe-west3`; darf leer sein), **Client-Schlüssel = Pfad der Schlüsseldatei** des Dienstkontos (JSON). Host `bigquery.googleapis.com`, TLS geprüft | der Schlüssel bleibt eine Datei auf der Platte (wie bei `gcloud`), er steht nicht in `connections.json` und nicht im Schlüsselbund; kein neues Feld im Profil |
| E3 | **Anmeldung**: Der Treiber signiert eine kurzlebige Zusicherung (JWT, RS256) mit `ring` – der Bibliothek, mit der rustls schon signiert – und tauscht sie bei `https://oauth2.googleapis.com/token` gegen ein Token. **Nur dort**: Eine Schlüsseldatei, die eine andere Adresse nennt, wird abgelehnt; der Schlüssel wird nie an einen anderen Host als Google und nie ohne geprüftes TLS benutzt | ein Schlüssel öffnet ein Projekt. Kein OAuth im Browser, kein `gcloud`-Login, keine Metadaten-Dienste |
| E4 | Eine Anweisung ist ein **Job**: gestartet, dann gefragt, bis er fertig ist; Seiten über `pageToken`. Zwischen zwei Anfragen sieht der Treiber auf Stopp und Uhr und bricht den Job ab (`jobs.cancel`) | kein Wächter-Thread nötig; nichts läuft unbemerkt weiter |
| E5 | **Werte** als Parameter der Abfrage mit Typ (`INT64`, `NUMERIC`/`BIGNUMERIC`, `BOOL`, `DATE`, `DATETIME`, `STRING`) | die API bindet sie |
| E6 | Tabellen-Ansicht: Der Vergleichswert wird als Text gebunden und auf den **Typ der Spalte gecastet** – nur auf einen aus einer festen Liste | BigQuery vergleicht einen Text mit nichts als einem Text (wie Trino, 035f E6) |
| E7 | Ein Dataset lässt sich nicht binden: Katalogabfragen nennen es gequotet (`` `name`.INFORMATION_SCHEMA.TABLES ``) | Bezeichner quotet nur `meta::quote` – mit Backticks, Backslash und Backtick maskiert |
| E8 | Zeichenketten kennen dort kein verdoppeltes `'`: Literale (Kopieren als, Anzeige) schreiben `\'` | Dialekt |
| E9 | Zeitstempel als ganze Zahl von Mikrosekunden (`useInt64Timestamp`), Listen und Records als JSON mit den Namen ihrer Felder | keine Ziffer geht in einem Bruch verloren |
| E10 | **Keine Sitzung, keine Transaktionen**: `edits_rows` falsch; ein Assistent bekommt keine Abfrage ausgeführt | wie D1 (035h E6, E9); was ein Dienstkonto schreiben darf, entscheidet Google |

## Kosten

BigQuery rechnet nach gelesenen Bytes ab. Die Tabellen-Ansicht (`SELECT * … LIMIT 200`) liest dort **die ganze
Tabelle**, auch wenn sie nur 200 Zeilen zeigt. Die App begrenzt das nicht (`maximumBytesBilled` wäre der Weg) und
sagt es noch nirgends im Fenster – das gehört vor den ersten Einsatz gegen ein Projekt mit großen Tabellen.

## Was noch fehlt (bewusst)

- Bearbeiten, Import, Testdaten, Kopieren; Plan (`dryRun`), Monitor (`INFORMATION_SCHEMA.JOBS`), Rechte, Struktur.
- Anmeldung als Nutzer (OAuth im Browser), `gcloud`-Zugangsdaten, Workload Identity.
- Datasets an einem anderen Ort als dem der Verbindung erscheinen nicht; die Suche nach Namen fragt die ersten
  zwanzig Datasets, der Namensindex die ersten fünfzig.
- Routinen, Modelle, Fremdschlüssel (dort ein Versprechen, das niemand prüft); Definitionen von Views in der Suche.

## Nicht getestet

- **Alles gegen Google**: Anmeldung (der Tausch des Tokens), Orte, Kosten, `ddl`, Seiten und geänderte Zeilen (die
  beiden letzten nur gegen den nachgestellten Server). Der Emulator kann weniger als BigQuery und weicht ab.
- Das native Fenster.

## Tests

- `src-tauri/tests/bigquery_integration.rs` (gegen den Emulator, `pnpm rust:test:db`): Typen, Unicode, NULL, Listen
  und Records, gebundene Werte, Fehler mit Stelle, Datasets, Tabellen, Spalten, Suche, Filter mit Cast und Position.
- `src-tauri/src/db/bigquery_tests.rs` (6 Tests, bei jedem `cargo test`): Warten auf einen Job, Seiten, Typen der
  Parameter, Abbruch, Fehler, dass ein Login nur zu Google geht, die signierte Zusicherung (mit `openssl`, wo es da
  ist), Werte.

## Review

Ein zweiter, nur lesender Blick, gegen Googles Dokumentation und den Emulator geprüft. Behoben, mit Tests
(`bigquery_tests.rs`, `guard.rs`, `filter.rs`, `meta.rs`, Fälle des Zerlegers):

| # | Befund | Behebung |
|---|---|---|
| 1 (hoch) | Mit einer Schlüsseldatei und einem lokalen Host – oder durch einen SSH-Tunnel, der den Host zu `127.0.0.1` macht – holte der Treiber ein echtes Token bei Google und schickte es an einen anderen Host | Eine Schlüsseldatei gilt nur für `bigquery.googleapis.com` über geprüftes TLS mit den Zertifikaten des Systems (keine eigene CA); für einen lokalen Host wird sie abgelehnt; kein SSH-Tunnel |
| 2 (hoch) | Der Schutz las einen Text anders als BigQuery: `#`-Kommentare, Zeichenketten aus drei Anführungszeichen, Backslash in Backticks, das verdoppelte `'` (das es dort nicht gibt). Ein Skript galt als lesend, während BigQuery darin ein `DROP` ausführte | Der Lexer des Schutzes kennt für BigQuery alle vier; eine nicht geschlossene Zeichenkette gilt nie als lesend |
| 3 | Die freie Bedingung der Tabellen-Ansicht hatte dieselben Lücken | liest wie BigQuery; `#`, `@name` und Zeichenketten aus drei Anführungszeichen werden abgelehnt |
| 4 | 23 reservierte Wörter (`hash`, `new`, `at`, `groups` …) wurden nicht gequotet | eigene Liste |
| 5 | Ein Job wurde am Ort des Profils abgebrochen, nicht dort, wo er lief: Bei einem regionalen Dataset lief (und kostete) er weiter | abgebrochen wird am Ort des Jobs |
| 6 | `errors` in einer Antwort, die eine ist, galt als Fehlschlag – es können Warnungen eines Jobs sein, der ging | nur ein Fehler der API ist einer |
| 7 | Die Liste der Datasets kam aus `INFORMATION_SCHEMA.SCHEMATA` – das meint ohne Region die USA: Ein Projekt in der EU zeigte einen leeren Baum | über `datasets.list` der API, alle Orte |
| 9 | Der Zerleger im Fenster zerschnitt Skripte (`DECLARE x …; SELECT x`) in einzelne Jobs und kannte `#` und drei Anführungszeichen nicht | ein Skript läuft als Ganzes; der Lexer wie im Backend |
| 10 | Die Lebenszeit des Tokens zählte nicht weiter, während der Rechner schlief; ein abgelehntes Token wurde nicht erneuert | Uhr an der Wand; ein neuer Versuch mit neuem Token |
| 11, 13, 14 | Die Schlüsseldatei wurde ganz gelesen, bevor ihre Größe geprüft war; ein Wert mit Zeitzone ging als `DATETIME`; `..` als Projekt | behoben |

Offen geblieben:

- **Kosten** (siehe oben): Vorschau und Suche lesen ganze Tabellen; `maximumBytesBilled` und eine kostenlose Vorschau
  über `tabledata.list` gibt es noch nicht. Tabellen, die einen Partitionsfilter verlangen, lassen sich nicht
  einfach öffnen.
- Werte in Listen und Records bleiben, wie die API sie schreibt (ein Zeitstempel darin als Zahl von Mikrosekunden).
- Tabellen an einem anderen Ort als dem der Verbindung erscheinen im Baum, lassen sich von dort aber nur fragen,
  wenn der Ort der Verbindung leer ist. `CLONE`-, `SNAPSHOT`- und externe Tabellen fehlen in Suche und Diagramm.
- Der Namensindex stellt bis zu hundert Fragen nacheinander (zwei je Dataset).
