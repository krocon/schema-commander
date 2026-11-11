# Prompt 016: Arbeitsbereich – geteilte Ansicht und Sitzung

> **Slug:** `arbeitsbereich` · **Feature:** G2 · **Braucht:** 004 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DataGrip, VS Code (Editor-Gruppen). Bestand: `app.ts`
> (Splitter, Größen in den Einstellungen), Tabs aus Prompt 004.

## Ziel

Das Fenster passt sich der Arbeit an: zwei Abfragen nebeneinander, Ergebnis unten oder rechts oder maximiert,
Seitenleiste nach Bedarf – und nach einem Neustart sieht alles aus wie zuvor.

## Aufgaben

1. **Geteilte Ansicht**: Tab-Gruppen nebeneinander oder übereinander (mindestens zwei), Tab per Kürzel oder Ziehen
   in die andere Gruppe; aktive Gruppe klar erkennbar; Aktionen „teilen“, „Gruppe wechseln“, „Teilung aufheben“.
2. **Ergebnisbereich**: unten (Vorgabe) oder rechts; ein-/ausblenden; maximieren (Editor weg) und zurück; je Tab
   oder global – im Design entscheiden.
3. **Seitenleiste**: Bereiche Verbindungen/Schema, Verlauf, gespeicherte Abfragen als umschaltbare Ansichten; Breite
   und Zustand merken.
4. **Sitzung**: offene Tabs, Gruppen, aktive Tabs, Verbindungen je Tab (ohne automatisch zu verbinden, außer der
   Nutzer will es), Größen, Scroll- und Cursorposition – gespeichert und wiederhergestellt. Mehrere Fenster: im
   Design entscheiden (Empfehlung: zunächst ein Fenster).
5. **Fokus-Navigation** per Tastatur zwischen Baum, Editor, Ergebnis, Meldungen (`F6`-Muster) und „Zen“/Vollbild.

## Entscheidungsfragen (Design)

- Layout-Modell: fester Aufbau mit Optionen oder frei verschachtelbare Teilungen? Empfehlung begründen (Aufwand,
  Tastaturbedienung, Barrierefreiheit).
- Was wird beim Start automatisch verbunden?

## Akzeptanzkriterien

- Zwei Abfragen nebeneinander auf verschiedenen Verbindungen ausführen; Layout nach Neustart identisch.
- Jede Layout-Funktion ist per Tastatur erreichbar; Fokus ist immer sichtbar.
- Fenster auf 720 × 420 verkleinern: nichts überlappt oder verschwindet unerreichbar.

## Tests

Rein: Layout-Modell (teilen, verschieben, schließen, wiederherstellen aus defektem Zustand). Komponente: Tastatur.
