# Prompt 035: Weitere Datenbanken

> **Slug:** `weitere-datenbanken` · **Feature:** A6 · **Braucht:** 003, 008 · **Umfang:** L (je Treiber S–M)
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DBeaver (Breite).

## Ziel

Über die vier Grundtreiber hinaus weitere Datenbanken anbinden – jede als **eigener kleiner Durchlauf** dieses
Prompts mit eigenem Design-Dokument (`035a-duckdb.design.md` …).

## Kandidaten (Reihenfolge im Design begründen)

DuckDB (eingebettet, Dateien/Parquet), CockroachDB/TimescaleDB/Redshift (PostgreSQL-Protokoll: Abweichungen im
Katalog), ClickHouse, Oracle, Snowflake, BigQuery, Trino/Presto, Db2, Firebird, libSQL/Turso, Cloudflare D1.

## Aufgaben je Datenbank

1. **Treiber wählen**: reines Rust bevorzugt; C-Bibliotheken (Oracle Instant Client, DuckDB) nur mit klarer
   Antwort auf Build je OS, Paketgröße und Lizenz – ggf. als optionales Cargo-Feature. Begründung in
   `docs/architecture.md`.
2. **Treiber-Trait erfüllen** (Prompt 003): verbinden, ausführen (Strom), abbrechen, Typabbildung → `Cell`,
   Fehlerdetails (Prompt 022).
3. **Dialekt**: Quoting, Zerlegen von Skripten (005), Einstufung schreibend/lesend (012), Parameterformen (025),
   Literale (009), `LIMIT`-Form, Schlüsselwörter und Funktionen (021).
4. **Metadaten** für Baum und Details (008, 019): Objektarten, DDL, Fremdschlüssel.
5. **Anmeldung**: besondere Wege (OAuth/SSO bei Snowflake/BigQuery, Schlüsseldateien, IAM) – Geheimnisse nur im
   Schlüsselbund; Browser-Anmeldung nur über den Systembrowser.
6. **Testumgebung**: Container oder Emulator; wo es keinen gibt, aufgezeichnete Antworten und ein klarer Hinweis im
   Bericht.
7. **Fähigkeits-Flags** je Treiber (Transaktionen? Abbruch? Fremdschlüssel? Schemata?), damit die Oberfläche
   Funktionen sauber ausblendet statt zu scheitern.

## Akzeptanzkriterien (je Datenbank)

- Die gemeinsame Treiber-Testsuite (Typen, Unicode, große Ergebnisse, Abbruch, Fehler) ist grün.
- Baum, Ausführen, Ergebnis, Kopieren/Export funktionieren; nicht Unterstütztes ist ausgeblendet und dokumentiert.
- Build und Pakete bleiben auf allen drei Betriebssystemen grün.
