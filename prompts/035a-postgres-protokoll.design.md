# Design 035a: Server mit dem Protokoll von PostgreSQL (CockroachDB, TimescaleDB) und Fähigkeits-Flags

> **Status:** umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/weitere-datenbanken` · Auftrag: [035-weitere-datenbanken.md](035-weitere-datenbanken.md) · Feature A6
>
> Erster Durchlauf von Prompt 035. Der Prompt bleibt offen: Die übrigen Kandidaten stehen unten mit dem, was sie
> kosten.

## Reihenfolge der Kandidaten

| Rang | Datenbank | Weg | Warum an dieser Stelle |
|---|---|---|---|
| 1 | **CockroachDB**, **TimescaleDB** | vorhandener PostgreSQL-Treiber, Abweichungen im Katalog | kein neuer Treiber, keine neue Abhängigkeit, Container zum Testen – **dieser Durchlauf** |
| 2 | Redshift | derselbe Weg | kein Container, kein Emulator: nur mit einem echten Cluster prüfbar. Die Erkennung (`Flavor`) ist die Stelle dafür |
| 3 | DuckDB | C++-Bibliothek (`duckdb` mit `bundled`) | Build auf drei Systemen, Paket wächst deutlich, lange Übersetzung: als optionales Cargo-Feature in einem eigenen Durchlauf |
| 4 | ClickHouse | HTTP-Schnittstelle, reines Rust | eigener Dialekt ohne Transaktionen und Fremdschlüssel – der erste Fall, in dem die Flags unten etwas ausblenden |
| 5 | libSQL/Turso, Cloudflare D1 | HTTP, SQLite-Dialekt | brauchen Token-Anmeldung |
| 6 | Trino/Presto, Snowflake, BigQuery | HTTP + OAuth/SSO/Schlüsseldateien | Anmeldung über den Systembrowser ist ein eigenes Thema |
| 7 | Oracle, Db2, Firebird | C-Bibliotheken des Herstellers | Lizenz und Verteilung der Client-Bibliothek |

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Eigene Art von Verbindung? | **Nein.** CockroachDB und TimescaleDB werden als „PostgreSQL“ angelegt; welcher Server antwortet, stellt der Treiber beim Verbinden fest (`Flavor`: `SELECT version()` beginnt mit `CockroachDB`; die Erweiterung `timescaledb` ist installiert). `DbKind` bleibt bei vier Werten – Quoting, Zerlegen, Einstufung, Parameter, Literale und `LIMIT` sind die von PostgreSQL | ein fünfter `DbKind` hätte jede Dialekt-Stelle berührt, ohne dass sich dort etwas unterscheidet |
| E2 | Abbruch (CockroachDB) | Es gibt kein `pg_cancel_backend`. Der Treiber merkt sich `SHOW session_id` und schickt über die zweite Verbindung `CANCEL QUERIES (SELECT query_id FROM [SHOW CLUSTER STATEMENTS] WHERE session_id = '…')`. Die Id kommt vom Server und wird trotzdem nur als reine Hex-Folge eingesetzt | vorher: 3,7 s und die Sitzung war weg; jetzt 0,75 s und sie bleibt |
| E3 | Zustand der Transaktion (CockroachDB) | `SHOW TRANSACTION STATUS` (`NoTxn`/`Open`/`Aborted`). Der Vergleich `now() <> statement_timestamp()` sagt dort immer „offen“, weil jede Anweisung eine eigene Transaktion ist | sonst hätte jede Rückfrage beim Schließen und jedes Schreiben von Zellen eine offene Transaktion gesehen |
| E4 | Katalog | `relispartition IS NOT TRUE` statt `NOT relispartition` (CockroachDB liefert `NULL` – die Objektliste war leer); Trigger werden in CockroachDB nicht gelesen (`pg_get_triggerdef` fehlt); Details ohne Größen und Vacuum-Zeiten; `crdb_internal`, `_timescaledb_*`, `timescaledb_information`, `timescaledb_experimental` gelten als Schemata des Systems. Ein Hypertable erscheint so als eine Tabelle, seine Chunks nicht | Baum und Details ohne Fehlernotiz |
| E5 | **Fähigkeits-Flags** | `Capabilities { product, cancel, foreignKeys, schemas, triggers, routines }`, rein aus Art und Flavour (`db::capabilities`), in `ConnectionInfo`; der Store hält sie je Verbindung (nichts gesagt = alles). Heutige Verbraucher: der Tooltip der Verbindung nennt, wer geantwortet hat („CockroachDB (PostgreSQL)“); die Aktionen zum Folgen von Fremdschlüsseln hängen an `foreignKeys` | Aufgabe 7. Für die sechs heutigen Server sind fast alle Flags wahr – sie sind die Stelle, an der ClickHouse & Co. etwas abschalten |
| E6 | Testumgebung | `scripts/db-test-servers.sh` startet zusätzlich CockroachDB 24.3 (ein Knoten, `--insecure`) und TimescaleDB auf PostgreSQL 17 | Aufgabe 6 |

## Geprüft

- **Gegen echte Server** (`servers_with_the_protocol_of_postgres_work_like_it`: CockroachDB, TimescaleDB und zum
  Vergleich PostgreSQL): Werte mit Unicode, Dezimal, Bool, JSON, `NULL`; Zustand der Transaktion (leer, offen,
  gescheitert, wieder leer); eine zu lange Anweisung endet nach dem Zeitlimit auf dem Server und die Sitzung
  bleibt; Schemata (nur eigene sind nicht „System“), Objekte, Spalten mit Schlüsseln, Indizes; Details mit DDL
  ohne eine abgelehnte Liste; Fremdschlüssel; **Import einer Datei** (alles-oder-nichts und Zeile für Zeile mit
  Savepoints). `timescale_shows_a_hypertable_as_one_table`. Ganze Treiber-Suite: 40 Tests grün.
- **Rust**: Flavour aus dem Versionstext, die Abbruch-Anweisung nur mit Hex-Id (Katalog böser Ids), Zustände von
  CockroachDB, Fähigkeiten je Art.
- **Fenster**: Der Store hält die Fähigkeiten und nimmt für ein Backend, das nichts sagt, alles an.
- `pnpm check` grün.

## Nicht umgesetzt, nicht geprüft

- **Redshift**: nicht geprüft (kein Cluster). Wahrscheinlich nötig: eigener Flavour für Abbruch
  (`pg_cancel_backend` gibt es dort, `CANCEL` auch), Katalog ohne manche `pg_get_*`-Funktionen.
- CockroachDB: Trigger (seit 24.3 in Vorschau) werden nicht gelistet; Fehler tragen keine Position im Text (der
  Server schickt keine) – die Markierung im Editor fehlt dort; die Vervollständigung kennt seine eigenen Wörter
  (`UPSERT`, `SHOW …`) nicht; `UPSERT`/`SHOW` stuft der Schutz wie unbekannte Anweisungen als schreibend ein.
- TimescaleDB: keine eigenen Ansichten für Hypertables, Kompression, kontinuierliche Aggregate.
- Die Flags `schemas`, `triggers`, `routines`, `cancel` haben noch keinen Verbraucher im Fenster (E5).
- Im Fenster wurde nichts gegen diese Server bedient (weder Browser noch `pnpm tauri dev`): geprüft ist die
  Backend-Seite.
- Alle übrigen Kandidaten des Prompts (Tabelle oben).
