# Prompt 027: Sortieren und Filtern

> **Slug:** `sortieren-filtern` · **Feature:** D5 · **Braucht:** 006, 007, 008 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`, `llms.txt` der GuiExpert Table (Sortieren, Filtern, eigenes Modell).
> Vorbild: TablePlus (Filterzeile), HeidiSQL (Filter als `WHERE`), DBeaver.

## Ziel

Im Ergebnis schnell eingrenzen und ordnen – **lokal**, wenn das Ergebnis geladen ist, und **auf dem Server**, wenn
man eine Tabelle ansieht.

## Aufgaben

1. **Tabellen-Ansicht** (Daten einer Tabelle aus dem Baum) als eigene Art von Tab: Die App baut das `SELECT` selbst
   (Spalten, `WHERE`, `ORDER BY`, Seitenweise/Strom), zeigt es an und kann es in einen Abfrage-Tab übergeben.
2. **Filterzeile** für Tabellen-Ansichten: Bedingungen aus Spalte + Operator + Wert (`=`, `≠`, `<`, `>`, `LIKE`,
   `IN`, `IS NULL`, zwischen, enthält), verknüpft mit UND/ODER; alternativ freies `WHERE`-Feld mit
   Vervollständigung. Werte **immer gebunden**, Bezeichner über die Quoting-Funktion.
3. **Schnellfilter aus der Zelle** (Kontextmenü/Kürzel): „nur dieser Wert“, „ohne diesen Wert“, „größer/kleiner“,
   „ist NULL“ – fügt eine Bedingung hinzu.
4. **Sortieren**: Klick auf den Kopf (mehrere Spalten mit Modifier), `NULLS FIRST/LAST` je Dialekt; bei
   Tabellen-Ansichten als `ORDER BY` auf dem Server, bei freien Abfrage-Ergebnissen lokal im Ergebnisspeicher
   (Rust, nicht im Fenster).
5. **Lokaler Filter** für jedes Ergebnis: Textfilter über alle oder eine Spalte, in Rust über den Speicher, mit
   Trefferzahl; ändert die Abfrage nicht.
6. Filter und Sortierung je Tabelle merken (zuletzt benutzt, benannte Filter); deutliche Anzeige „gefiltert“ und
   ein Griff zum Zurücksetzen.

## Entscheidungsfragen (Design)

- Lokales Sortieren von 10 Mio. Zeilen: externe Sortierung im Speicher von Prompt 006 oder Grenze mit Hinweis „auf
  dem Server sortieren“?
- Vergleichssemantik lokal gegenüber Server (Kollation, Groß-/Kleinschreibung, `NULL`): wie kenntlich machen?

## Akzeptanzkriterien

- Kein Weg, über Filterwerte SQL einzuschleusen (Katalog böser Werte; Prüfung der gesendeten Anweisung).
- Tabelle mit 100 Mio. Zeilen: Filter und Sortierung laufen auf dem Server, die ersten Zeilen kommen sofort,
  Abbruch möglich.
- Filterzeile vollständig per Tastatur; Schnellfilter aus der Zelle mit einem Kürzel.

## Tests und Review

Rein/Rust: SQL-Erzeugung je Dialekt (Katalog), lokales Sortieren/Filtern im Speicher. Review: nur gebundene Werte.
