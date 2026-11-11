# Design 028: Auswahl auswerten

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/auswahl-auswerten` · Auftrag: [028-auswahl-auswerten.md](028-auswahl-auswerten.md) · Feature D7

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Wo wird gerechnet? | **Im Backend** über den Ergebnisspeicher (`stats.rs`, rein): Das Fenster kennt nur den sichtbaren Ausschnitt. Die Auswahl kommt wie beim Kopieren als `Selection` (Zeilenbereiche × Spalten); eine lokale Sicht (027) wird gelesen wie ein Ergebnis. `getSelectionAggregates()` der Tabelle wird nicht benutzt: es sieht nur geladene Zeilen und rechnet mit Gleitkomma | Akzeptanzkriterien 1 und 2 |
| E2 | Exakte Summe | Jede Zahl eines Ergebnisses ist Dezimaltext (Ganzzahl, `NUMERIC`, kürzeste Form eines Float). `Dec` addiert Dezimalziffern beliebiger Länge: **kein Gleitkomma, kein Überlauf** bei 64 oder 128 Bit. Positives und Negatives wird getrennt an Ort und Stelle aufaddiert und am Ende verrechnet. Das Mittel hat sechs Stellen mehr als die Summe, kaufmännisch gerundet; Nullen, die nur die Division angehängt hat, entfallen. **Keine neue Abhängigkeit** (`rust_decimal` endet bei 96 Bit, `bigdecimal` wäre eine für 150 Zeilen) | Akzeptanzkriterium 1 |
| E3 | Floats | werden als ihr kürzester Dezimaltext addiert: `0.1 + 0.2` ergibt hier `0.3`. `NaN` und `Infinity` sind keine Zahlen und zählen als „ignoriert“ | die Summe zeigt, was im Gitter steht |
| E4 | Welche Kennzahlen | Anzahl, nicht NULL, verschiedene (über Hashes, bis 5 Mio., darüber „mehr als“); Zahlen: Summe, Mittel, Min, Max; Datum/Zeit: erster, letzter, Spanne (Zeitpunkte mit Zeitzone werden als Zeitpunkte verglichen; Spalten verschiedener Zeit-Arten zusammen haben keine gemeinsame Zeitachse → keine Angabe); Text: kürzester und längster in Zeichen | Aufgabe 1 |
| E5 | Gemischte Auswahl | Zahlen-Kennzahlen nur über die Zahlen; die Statuszeile sagt „n Zellen sind keine Zahlen“ | Aufgabe 3 |
| E6 | Wann wird gefragt? | Ab **zwei** markierten Zellen. „Nichts markiert“ heißt beim Kopieren „alles“ – für die Statuszeile heißt es „nichts“. 150 ms nach der letzten Änderung der Auswahl; eine neue Auswahl bricht die laufende Frage ab (`cancel_job`, Ids ab 3 000 000 000), eine überholte Antwort wird verworfen. „…“ erscheint nach 250 ms Warten, ab 200 000 Zellen sofort | Aufgabe 2, Akzeptanzkriterium 2 |
| E7 | Anzeige | rechts in der Statuszeile, jede Kennzahl ein Knopf: Klick kopiert den **genauen** Wert (die Anzeige gruppiert Ziffern, wenn das Gitter es tut – die Kopie nie). Aktion `COPY_SELECTION_SUM` kopiert die Summe (ohne Vorgabe-Kürzel, im Menü und in der Palette). Im schmalen Fenster werden die Kennzahlen beschnitten, nicht der Rest der Zeile | Aufgabe 2 |
| E8 | Auswahl der Kennzahlen | Einstellung `statsMeasures` (Vorgabe: Anzahl, Summe, Mittel, Min, Max). Gewählt wird im Popover von E10, je Kennzahl ein Kästchen „Statuszeile“ – dort stehen alle mit ihren Werten. Kein eigener Abschnitt im Einstellungsdialog | eine Stelle, an der man sieht, was man wählt |
| E9 | Screenreader | Die sichtbaren Kennzahlen stehen in der Statuszeile (`role="status"`) mit `aria-live="off"`; gesprochen wird über eine eigene Live-Region erst, wenn die Auswahl 1,2 s geruht hat – ein Satz mit den gezeigten Kennzahlen | Akzeptanzkriterium 3 |
| E10 | Spalte zusammenfassen | Aktion `SUMMARIZE_COLUMN` (`Mod+K Mod+A`, Kontextmenü des Ergebnisses, Menü Abfrage): die Spalte der Zelle unter dem Cursor, alle Kennzahlen und die zehn häufigsten Werte mit Anzahl und Anteil (NULL zählt mit). Ein modaler `<dialog>`, `Esc` schließt und bricht ab. Gezählt werden die ersten 200 Zeichen eines Werts, höchstens 200 000 verschiedene – darüber sagt das Popover, dass die Liste unvollständig sein kann | Aufgabe 4 |

## Verträge

`result_stats(job_id, result_id, selection, top) → Stats` (camelCase; Zahlen als Text; `spanMs`; `top: [{ value,
count }]`), abbrechbar mit `cancel_job`. Fehler: `cancelled`, `unknown_result`, `io`.

## Nebenbei behoben

**Kopieren und Export bei lokaler Sicht** (027): Das Gitter meldete seine Auswahl unter der Id der Sicht,
`CopyService.current()` lieferte aber das Ergebnis dahinter – kopiert und exportiert wurde das ungefilterte,
unsortierte Ergebnis ohne die Auswahl. Roter Test zuerst (`copy.service.spec.ts`), dann behoben: `current()` nimmt
die Sicht, wenn sie auf dem gezeigten Ergebnis liegt.

## Geprüft

- **Rust** (10 Tests): `Dec` lesen/schreiben (Vorzeichen, Exponent, 38+10 Stellen, Unsinn), addieren über 64 und 128
  Bit hinaus, das schnelle Addieren gegen das einfache (81 Paare), vergleichen, teilen mit Runden; Summe von
  `NUMERIC(38,10)`-Werten **von Hand nachgerechnet** auf die letzte Stelle; gemischte Auswahl, `i64::MAX + …` ohne
  Überlauf, `0.1 + 0.2`, `NaN`, doppelt gewählte Zeilen; Datum, Zeitstempel, Zeitpunkte mit Zeitzone, Spanne;
  häufigste Werte mit NULL; Abbruch, unbekanntes Ergebnis; DTO über die Brücke.
- **Fenster**: reine Logik (Kennzahlen je Art, Gruppierung nur in der Anzeige, Spanne, Auswahl, Satz für den
  Screenreader); Dienst mit Fake und falscher Uhr: **Drosselung** (20 Änderungen → eine Frage), überholte Antwort,
  „…“ erst nach Wartezeit bzw. sofort bei großer Auswahl, Live-Region erst in Ruhe, Kopieren, Zusammenfassung und
  ihr Abbruch.
- **Im Browser** mit nachgebildetem Backend (5000 Zeilen): Bereich mit Umschalt-Klick → Kennzahlen in der
  Statuszeile, gemischte Auswahl mit Hinweis, alles markieren → „…“ dann Ergebnis, Klick kopiert den genauen Wert,
  Live-Region gefüllt nach der Ruhezeit, Popover der Spalte mit häufigsten Werten, Statuszeile einzeilig bei 800 px.
- **Gemessen** (`big_column_is_summed_in_a_time_one_can_wait`, ignoriert): 2 Mio. Dezimalzellen im Speicher –
  0,76 s im Release-Build (8,6 s im Debug-Build); 10 Mio. also rund 4 s, in denen das Fenster frei bleibt (der Command läuft nicht auf dem Async-Thread). Der Abbruch wird alle 2048 Zeilen geprüft.
- `pnpm check` grün.

## Nicht umgesetzt, nicht geprüft

- **Gegen `SELECT sum(…)` einer echten Datenbank** wurde nicht verglichen; die Summe ist gegen eine Rechnung von
  Hand geprüft. Der Weg der Werte aus dem Treiber in den Speicher ist seit 007 verlustfrei getestet.
- **10 Mio. Zeilen im echten Fenster** nicht gemessen (nur die Rechnung oben, hochgerechnet); das native Fenster
  (`pnpm tauri dev`) wurde wie bisher nicht bedient, auch kein echter Screenreader.
- Mehrere Bereiche in verschiedenen Spalten werden wie beim Kopieren als Zeilen × Spalten gelesen (das Rechteck
  darum), nicht Zelle für Zelle.
- Lange Zahlen werden in JSON-Spalten o. Ä. nicht gesucht: Zahl ist, was in einer Zahlenspalte steht.
- Kennzahlen für die Listen der Objekt-Details (Zeilen im Fenster, kein Ergebnis des Speichers) gibt es nicht.
- Kein Median, keine Standardabweichung (nicht verlangt).
