# Prompt 039: Ausführungsplan

> **Slug:** `ausfuehrungsplan` · **Feature:** C9 · **Braucht:** 005, 012 · **Umfang:** M–L
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: pgAdmin (grafisches EXPLAIN), SSMS (Ausführungsplan),
> DataGrip (Plan als Baum), explain.dalibo.com (Lesbarkeit).

## Ziel

Verstehen, warum eine Abfrage langsam ist: der Plan als **Baumtabelle** mit Kosten, Zeiten und Zeilen, die teuren
Knoten auf einen Blick.

## Aufgaben

1. **Plan holen** je Datenbank in maschinenlesbarer Form: PostgreSQL `EXPLAIN (FORMAT JSON[, ANALYZE, BUFFERS])`,
   MySQL `EXPLAIN FORMAT=JSON`/`EXPLAIN ANALYZE`, SQL Server Showplan-XML (geschätzt/tatsächlich), SQLite
   `EXPLAIN QUERY PLAN`. Gemeinsames Modell: Knoten (Operation, Objekt, Bedingung), geschätzte/tatsächliche Zeilen,
   Kosten, Zeit gesamt/eigen, Schleifen, Puffer, Rohdaten.
2. **Zwei Aktionen**: „Plan zeigen“ (nur schätzen, führt nichts aus) und „Plan mit Ausführung“ (`ANALYZE`). Letztere
   **führt die Anweisung aus**: deutlicher Hinweis; schreibende Anweisungen nur in einer Transaktion mit Rollback
   und nach den Regeln aus Prompt 012.
3. **Ansicht**: GuiExpert-Baumtabelle (Operation, Objekt, Zeilen geschätzt/tatsächlich mit Abweichungsfaktor, Zeit
   eigen/gesamt mit Balken, Kosten, Puffer); teuerste Knoten und große Fehlschätzungen farbig (Tokens); Details des
   gewählten Knotens (Bedingungen, Ausgabe, Sortierschlüssel); Rohplan als Text/JSON im Nur-Lesen-Editor.
4. **Hinweise** (vorsichtig, regelbasiert): sequentieller Scan mit stark filternder Bedingung, Sortierung auf Platte,
   große Fehlschätzung, verschachtelte Schleife über viele Zeilen – als Hinweis, nicht als Wahrheit.
5. Plan speichern/exportieren; zwei Pläne nebeneinander vergleichen (optional).
6. Optional: grafische Darstellung als Knotendiagramm (SVG, Technik aus Prompt 037).

## Akzeptanzkriterien

- Für eine Verbund-Abfrage in jeder der vier Datenbanken erscheint ein Plan-Baum; die Summe der Eigenzeiten passt zur
  Gesamtzeit (PostgreSQL, Schleifen berücksichtigt).
- „Plan mit Ausführung“ für ein `UPDATE` ändert nach dem Rollback nichts.
- Ein unbekannter Knotentyp oder ein neueres Planformat führt zu „unbekannt“ mit Rohdaten, nicht zu einem Fehler.

## Tests

Rust: Parser-Katalog mit echten Plänen je Datenbank und Version (als Dateien), Zeitberechnung. Frontend: Ansicht
mit Fake.
