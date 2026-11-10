# Prompt 040: Zeile als Formular

> **Slug:** `zeilen-formular` · **Feature:** D4 · **Braucht:** 007 (026 und 031 für Wert-Ansicht/Bearbeiten) ·
> **Umfang:** S–M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DBeaver (Record-Ansicht), DbGate (Form View), DataGrip
> (Transpose).

## Ziel

Breite Tabellen lesbar machen: **eine Zeile**, alle Spalten untereinander als „Name – Wert“.

## Aufgaben

1. **Umschalten** zwischen Gitter und Formular für die aktuelle Zeile (Aktion + Kürzel, je Ergebnis gemerkt);
   alternativ als Seitenfeld neben dem Gitter.
2. **Darstellung** als GuiExpert Table mit zwei bzw. drei Spalten (Spaltenname, Typ, Wert): Renderer aus Prompt 007,
   lange Werte mehrzeilig mit Begrenzung und „mehr“ (öffnet die Wert-Ansicht, 026).
3. **Navigation**: vorige/nächste Zeile (bleibt auf demselben Feld), erste/letzte, Zeile *n*; Zeilenzähler.
4. **Filter über Spaltennamen** (bei 300 Spalten nötig), „nur Nicht-NULL“, „nur geänderte“.
5. **Mehrere Zeilen nebeneinander** (transponiert): markierte Zeilen als Spalten – zum Vergleichen; Unterschiede
   hervorheben.
6. **Bearbeiten** im Formular nutzt denselben Änderungspuffer wie das Gitter (Prompt 031), sobald vorhanden.
7. Kopieren: Feld, „Name: Wert“-Liste, JSON-Objekt der Zeile (Extraktoren aus 009).

## Akzeptanzkriterien

- Zeile mit 300 Spalten: Feld per Namensfilter in Sekunden gefunden; Zeilenwechsel ohne Verzögerung.
- Drei markierte Zeilen nebeneinander zeigen ihre Unterschiede farbig.
- Vollständig per Tastatur; Screenreader liest „Spaltenname, Wert“.

## Tests

Rein: transponiertes Modell, Unterschiede. Im Fenster: Navigation.
