# Prompt 019: Objekt-Details und DDL

> **Slug:** `objekt-details` · **Feature:** B3 · **Braucht:** 008 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DBeaver (Eigenschaften-Reiter), Postico (Struktur-Ansicht),
> HeidiSQL (Reiter „CREATE-Code“).

## Ziel

Zu jedem Objekt im Baum eine Ansicht, die alles Wissenswerte zeigt, und sein **DDL** zum Lesen und Kopieren.

## Aufgaben

1. **Tabellen-Ansicht** als Tab: Spalten (Name, Typ, NULL, Default, Schlüssel, Kommentar, generiert/Identity),
   Indizes (Spalten, eindeutig, Art, Größe), Constraints (Primär-, Fremdschlüssel mit Ziel und Regeln, Check,
   Unique), Trigger, Partitionen, Rechte, Statistik (Zeilen geschätzt, Größe Daten/Indizes, letzter Vacuum/Analyze,
   wo verfügbar). Jede Liste als GuiExpert Table, durchsuch- und kopierbar.
2. **Beziehungen**: „verweist auf“ und „wird referenziert von“ als Listen mit Sprung zum Objekt.
3. **DDL**: je Datenbank der beste Weg (`SHOW CREATE TABLE`, `sqlite_schema.sql`, `pg_get_viewdef`/
   `pg_get_functiondef`/`pg_get_indexdef`; für PostgreSQL-Tabellen und SQL Server aus dem Katalog zusammensetzen).
   Anzeige im Nur-Lesen-Editor mit Hervorhebung; kopieren, in neuen Tab.
4. **Views, Routinen, Trigger, Sequenzen, Typen**: Quelltext/Definition plus Kerndaten (Parameter, Rückgabetyp,
   Sprache, Besitzer).
5. **Schnellinfo**: Tooltip/Popover am Baumknoten und (später) am Bezeichner im Editor: Spalten mit Typen.
6. Abhängigkeiten „benutzt von / benutzt“, wo der Katalog sie hergibt.

## Entscheidungsfragen (Design)

- DDL für PostgreSQL-Tabellen selbst erzeugen (kein `SHOW CREATE`): Umfang festlegen (Spalten, Constraints, Indizes,
  Kommentare, Partitionierung, Rechte?) und gegen `pg_dump --schema-only` prüfen.
- Tab je Objekt oder ein Detailbereich, der der Auswahl im Baum folgt?

## Akzeptanzkriterien

- Für die Testschemata jeder Datenbank: Das angezeigte DDL lässt sich in einer leeren Datenbank ausführen und ergibt
  dieselbe Struktur (Vergleich über den Katalog).
- Tabelle mit 1 500 Spalten und 300 Indizes bleibt bedienbar.

## Tests

Rust gegen Container: Metadaten und DDL-Rundreise je Objektart. Frontend: Ansichten mit Fake.
