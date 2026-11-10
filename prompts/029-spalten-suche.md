# Prompt 029: Spalten verwalten und im Ergebnis suchen

> **Slug:** `spalten-suche` · **Feature:** D8 · **Braucht:** 006, 007 · **Umfang:** S–M
> Lies zuerst `prompts/000-arbeitsweise.md`, `llms.txt` der GuiExpert Table (fixe Spalten, Verschieben, Zustand
> speichern). Vorbild: DBeaver, `log-commander/src/app/features/log-table/` (Spaltenmenü, Suche mit Treffer-Sprung).

## Ziel

Breite Ergebnisse zähmen und Werte finden: Spalten fixieren, ausblenden, umsortieren – und **Suchen im Ergebnis** mit
Sprung von Treffer zu Treffer.

## Aufgaben

1. **Spalten**: links fixieren (eine oder mehrere), ausblenden/einblenden, per Ziehen und Tastatur verschieben,
   Breite ändern, „alle Breiten anpassen“, zurücksetzen. Spaltenliste als Popover mit Filter (bei 500 Spalten nötig)
   und „Springe zu Spalte“.
2. **Merken**: Layout je Tabelle (Tabellen-Ansicht) bzw. je Abfrage-Tab; bei geänderter Spaltenliste sinnvoll
   zusammenführen.
3. **Suche** (`Mod+F` mit Fokus im Ergebnis): Text, Groß-/Kleinschreibung, ganzes Wort, Regex, nur in Spalte(n);
   läuft in Rust über den Ergebnisspeicher, abbrechbar; Trefferzahl, nächster/voriger Treffer, Treffer hervorgehoben
   (`--hit-*`), aktuelle Zelle scrollt in Sicht.
4. **Springen**: zu Zeile *n* (`Mod+G`), erste/letzte Zeile, nächste Zelle mit anderem Wert in der Spalte, nächstes
   `NULL`.
5. Zeilen transponiert kopieren/ansehen bleibt Prompt 040.

## Akzeptanzkriterien

- 500 Spalten: zwei fixierte links, horizontales Scrollen flüssig, Spalte per Namen in zwei Tastendrücken erreicht.
- Suche in 10 Mio. Zeilen zeigt die ersten Treffer sofort, zählt im Hintergrund weiter, lässt sich abbrechen.
- Ungültiger Regex ergibt einen Hinweis am Feld, keinen Fehlerdialog.

## Tests

Rust: Suche im Speicher (Unicode, Regex-Grenzen, Abbruch). Rein: Layout zusammenführen. Im Fenster: Tastatur.
