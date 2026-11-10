# Prompt 028: Auswahl auswerten

> **Slug:** `auswahl-auswerten` · **Feature:** D7 · **Braucht:** 007 · **Umfang:** S
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: Excel, DataGrip (Aggregat-Anzeige).

## Ziel

Zellen markieren und in der Statuszeile sofort **Anzahl, Summe, Mittel, Minimum, Maximum** sehen.

## Aufgaben

1. **Berechnung in Rust** über den Ergebnisspeicher (die Auswahl kann Millionen Zellen umfassen): Anzahl, Anzahl
   nicht-`NULL`, verschiedene Werte, Summe, Mittel, Min, Max; für Datum/Zeit Min, Max und Spanne; für Text
   Min/Max-Länge. Dezimalzahlen exakt (keine Gleitkomma-Summe für `NUMERIC`), Überlauf bei 64 Bit behandeln.
2. **Anzeige** in der Statuszeile, gedrosselt, überholte Antworten verwerfen; bei großer Auswahl erst „…“ dann
   Ergebnis. Klick/Kürzel kopiert einen Wert; Auswahl, welche Kennzahlen gezeigt werden.
3. Gemischte Auswahl (Zahlen und Text): Zahlen-Kennzahlen nur über Zahlen, Hinweis auf die Anzahl ignorierter Zellen.
4. Aktion „Spalte zusammenfassen“: Kennzahlen der ganzen Spalte, plus häufigste Werte (Top 10) in einem kleinen
   Popover.

## Akzeptanzkriterien

- Summe über `NUMERIC(38,10)`-Werte stimmt auf die letzte Stelle mit `SELECT sum(…)` überein.
- Ganze Spalte mit 10 Mio. Zeilen markieren: Fenster bleibt bedienbar, Ergebnis erscheint, Abbruch durch neue
  Auswahl.
- Screenreader erfährt das Ergebnis über die Live-Region, ohne bei jeder Bewegung zu sprechen.

## Tests

Rust: Kennzahlen-Katalog (NULL, gemischt, Dezimal, Überlauf, Datum). Frontend: Drosselung mit Fake.
