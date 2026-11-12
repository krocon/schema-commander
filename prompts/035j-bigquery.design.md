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
