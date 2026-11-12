# Design 035e: YugabyteDB und die Verwandten von PostgreSQL

> Durchlauf von [Prompt 035](035-weitere-datenbanken.md) für die Server, die PostgreSQLs Protokoll sprechen und
> noch fehlten. Stand: umgesetzt am 12.11.2026, geprüft gegen YugabyteDB 2025.1 (Container
> `yugabytedb/yugabyte:2025.1.1.2-b3`, YSQL).

## Ergebnis in einem Satz

**YugabyteDB** ist ein `Flavor` des PostgreSQL-Treibers: Die App erkennt es an seiner Version
(`PostgreSQL 15.12-YB-2025.1.1.2-b0 …`), nennt es beim Namen und behandelt es sonst wie PostgreSQL – im Versuch
brauchte es keine Abweichung.

## Entscheidungen

| # | Entscheidung | Warum |
|---|---|---|
| E1 | Kein eigener Treiber, keine eigene `DbKind`: `Flavor::Yugabyte` (wie 035a) | YSQL ist PostgreSQLs eigene Abfrageschicht; Katalog, `pg_cancel_backend`, `pg_get_triggerdef`, Savepoints und `EXPLAIN (FORMAT JSON)` antworten wie dort |
| E2 | Erkannt wird am Zeichen `-YB-` in der **Versionsnummer** (zweites Wort von `version()`), nicht irgendwo im Text | Ein PostgreSQL, dessen Plattform zufällig so heißt, bleibt PostgreSQL (Test) |
| E3 | Alle Fähigkeits-Flags wie PostgreSQL | geprüft: Trigger, Routinen, Plan, `ALTER TABLE`, Rollen |
| E4 | Der Container gehört nicht zu `up`, nur mit `SC_DBTEST_YUGABYTE=1`; der Test überspringt sich sonst selbst | etwa 3 GB und eine halbe Minute Start für einen Server, der sich wie PostgreSQL verhält |

## Was geprüft ist

`yugabytedb_works_like_postgres` in `src-tauri/tests/db_integration.rs` – derselbe Durchlauf wie für CockroachDB
und TimescaleDB (`like_postgres`): Werte und Unicode, Zustand der Transaktion vom Server, Zeitlimit mit
weiterlebender Sitzung, Schemata (die des Servers als solche markiert), Tabellen, Views, Spalten, Indizes, Details
mit DDL ohne Hinweis, Fremdschlüssel, Datei in eine Tabelle laden (ganz oder gar nicht; zeilenweise mit Savepoints).

Von Hand über `ysqlsh`: `EXPLAIN (ANALYZE, FORMAT JSON)`, `pg_stat_activity`, `pg_roles`, Spalte hinzufügen,
umbenennen, Typ ändern, Trigger mit `pg_get_triggerdef`.

## Nicht geprüft

- **Server-Monitor**: `pg_locks` ist dort leer (Sperren liegen im verteilten Speicher, `pg_locks` zeigt sie nicht
  so wie PostgreSQL) – „wer blockiert wen“ bleibt also leer, ohne falsch zu sein. Benutzer und Rechte, Struktur
  bearbeiten, Schema-Vergleich, Sichern (`pg_dump` von PostgreSQL gegen YSQL) im Fenster nicht durchgespielt.
- Ein Typwechsel einer Spalte schreibt dort die Tabelle neu; der Server meldet das als Hinweis, die App markiert es
  nicht eigens.
- YCQL (die Cassandra-Schnittstelle) kennt die App nicht. TLS, Cluster mit mehreren Knoten, YugabyteDB Aeon.

## Die anderen Verwandten

Ohne Server, gegen den sich prüfen ließe, behauptet die App nichts:

- **Amazon Redshift**, **Greenplum**: sprechen das Protokoll, ihr Katalog ist aber ein altes PostgreSQL (8.x) mit
  eigenen Tabellen. Verbinden und Ausführen dürften gehen, Baum und Details vermutlich nicht überall. Kein Flavor,
  kein Eintrag in der Liste – wer es versucht, sieht „PostgreSQL“.
- **Amazon Aurora PostgreSQL**, **AlloyDB**, **Neon**, **Supabase**, **Citus**: sind PostgreSQL (mit Erweiterungen)
  und brauchen nichts Eigenes; nicht eigens getestet.
- **Materialize**, **QuestDB**, **RisingWave**: eigener Katalog hinter dem Protokoll – offen, je eigener Durchlauf.
