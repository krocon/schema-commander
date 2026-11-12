# Prompt 042: Diagramm aus dem Ergebnis

> **Slug:** `diagramme` · **Feature:** D11 · **Braucht:** 006 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: Azure Data Studio (Chart-Reiter), DBeaver. Erprobt:
> `log-commander/src/app/features/dashboard/` (uPlot, Farben aus Tokens, Neuzeichnen bei Schemawechsel).

## Ziel

Ein Ergebnis mit einem Klick als Diagramm sehen: Zeitreihe, Balken, Linie, Punktwolke – ohne Export in ein anderes
Werkzeug.

## Aufgaben

1. **Reiter „Diagramm“** am Ergebnis. Vorschlag aus den Spaltentypen: erste Datums-/Zeitspalte → X, Zahlenspalten →
   Reihen; Textspalte + Zahl → Balken; zwei Zahlen → Punktwolke.
2. **Einstellen**: Diagrammart, X, Y-Reihen (mehrere), Gruppieren nach einer Spalte (Reihe je Wert, Obergrenze),
   Aggregation bei mehrfachen X (Summe, Mittel, Anzahl, Min, Max), Sortierung, logarithmische Achse, gestapelt.
3. **Daten aufbereiten in Rust** über den Ergebnisspeicher (Aggregieren, Ausdünnen großer Reihen auf Pixelbreite
   ohne Spitzen zu verlieren); ans Fenster gehen nur die Punkte, die gezeichnet werden.
4. **Zeichnen**: Bibliothek begründen (uPlot wie log-commander: klein, schnell, MIT) oder SVG selbst; Farben
   `--chart-1…8`, `--chart-grid`, Neuzeichnen bei Schemawechsel; Zoom/Ausschnitt, Tooltip mit Werten, Legende mit
   Ein-/Ausblenden.
5. **Barrierefreiheit**: Datentabelle zum Diagramm (das Ergebnisgitter ist nebenan), Reihen nicht nur über Farbe
   unterscheidbar (Strichart/Marker), Beschreibung für Screenreader.
6. **Export** als PNG/SVG, Kopieren als Bild; Diagramm-Einstellung mit der gespeicherten Abfrage ablegen (024).

## Akzeptanzkriterien

- Zeitreihe mit 5 Mio. Punkten erscheint in unter 2 s und bleibt beim Zoomen flüssig.
- Diagramm ist in jedem der 17 Schemata lesbar (Kontrastpaare für `--chart-*` existieren).
- `NULL`-Werte erzeugen Lücken, keine Nullen.

## Tests

Rust: Aggregation und Ausdünnen (Katalog), Typ-Vorschlag. Im Fenster: Schemawechsel, Zoom.
