# Design 042: Diagramm aus dem Ergebnis

> **Status:** umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/diagramme` · Auftrag: [042-diagramme.md](042-diagramme.md) · Feature D11

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Bibliothek | **keine**: Das Fenster zeichnet selbst als SVG. Rust gibt nur die Punkte heraus, die gezeichnet werden – höchstens rund vier je Pixelspalte und Reihe –, dafür reicht ein `<path>` je Reihe | keine neue Abhängigkeit, kein Canvas unter der CSP, Farben folgen den Tokens von selbst; die Arbeit, für die man uPlot bräuchte (Millionen Punkte), macht das Backend |
| E2 | Aufbereiten | `chart::prepare` liest das Ergebnis **einmal** und nur die gebrauchten Zellen (eigener Visitor, kein Baum je Zeile): Kategorien (Balken, Text als X) werden je Reihe aggregiert; sonst die Punkte als Zahlen, nach X sortiert, gleiche X zusammengefasst (Summe, Mittel, Anzahl, Min, Max) | Aufgabe 3 |
| E3 | Ausdünnen | `chart::sample(breite, ausschnitt)`: je Pixelspalte der erste, kleinste, größte und letzte Wert – eine Spitze geht nie verloren; liegt ein NULL in der Spalte, bleibt die Lücke. Punktwolke: ein Punkt je Zelle eines Rasters von 4 px | Aufgabe 3, Akzeptanzkriterium 1 |
| E4 | Zoom | Das Backend hält die letzten drei vorbereiteten Diagramme (`ChartCache`); Zoomen und eine andere Breite fragen nur `chart_zoom` – das Ergebnis wird nicht noch einmal gelesen. Ist das Diagramm nicht mehr da, wird es neu aufbereitet | „bleibt beim Zoomen flüssig“ |
| E5 | Vorschlag | in Rust aus den Spaltentypen: Datum/Zeit → Linien über die Zeit; Text + Zahl → Balken; zwei Zahlen → Punktwolke; eine Zahl → Linie über einen Schlüssel oder die Zeilennummer. Spalten, die wie Schlüssel heißen (`id`, `…_id`), sind keine Werte, solange es andere gibt | Aufgabe 1 |
| E6 | Wo | „Diagramm“ in der Leiste der Unter-Reiter (`TOGGLE_CHART`, `Mod+K Mod+T`) zeigt das Ergebnis auf dem Schirm als Diagramm statt als Tabelle; die Einstellung gehört zum Tab und gilt, solange die Spalten passen | Aufgabe 1; das Gitter ist einen Tastendruck entfernt (Aufgabe 5) |
| E7 | Einstellen | Art, X (auch „Zeilennummer“), Werte (mehrere), Gruppieren (höchstens 12 Reihen, der Rest wird gezählt), Aggregation, Reihenfolge der Kategorien, logarithmisch, gestapelt (Balken) | Aufgabe 2 |
| E8 | NULL | Ein NULL ist eine Lücke der Linie bzw. ein fehlender Balken, nie 0; „Anzahl“ zählt Werte, die da sind. Die Zeile über dem Diagramm sagt, wie viele Werte NULL sind und wie viele ausgelassen wurden (keine Zahl, kein X) | Akzeptanzkriterium 3 |
| E9 | Zeit | Datum und Zeitstempel werden als Text des Speichers gelesen (eigener kleiner Parser, kein `chrono` je Zeile); ohne Zone gelten sie als UTC und werden so beschriftet, wie sie im Ergebnis stehen | 5 Mio. Zeilen in unter 2 s |
| E10 | Bedienen | Ziehen über das Diagramm wählt einen Ausschnitt, Doppelklick zeigt alles; dazu Knöpfe (+ − ← → Alles) für die Tastatur; Tooltip mit X und dem Wert jeder Reihe; Legende blendet Reihen ein und aus | Aufgabe 4 |
| E11 | Nicht nur Farbe | Linien haben je Reihe eine Strichart, Punkte eine Markerform, Balken eine Schraffur; das SVG hat eine Beschreibung (Art, Reihen, Punkte, Wertebereich je Reihe) als `aria-label` | Aufgabe 5 |
| E12 | Farben | nur `--chart-1…8`, `--chart-grid`, `--text-dim`; als CSS-Variablen im SVG – ein Schemawechsel braucht kein Neuzeichnen. Die Kontrastpaare für `--chart-*` gab es schon (`pnpm contrast`) | Akzeptanzkriterium 2 |
| E13 | Export | „Als SVG speichern“ und „Als SVG kopieren“: eigenständiges SVG mit aufgelösten Farben; Namen maskiert | Aufgabe 6, siehe „Nicht umgesetzt“ |
| E14 | Feindliche Namen | Kategorien und Gruppen sind Text des Ergebnisses: im Backend auf eine Zeile und 60 Zeichen gekürzt, im Fenster nur als Text gesetzt | Regel „nichts aus einem Wert als Markup“ |

## Geprüft

- **Rust** (12 Tests in `chart_tests.rs`, einer davon nur im Release-Build): Vorschlag aus den Typen (8 Fälle);
  Datum/Zeit lesen (10 gültige, 8 ungültige); Balken je Kategorie mit allen Aggregationen und Reihenfolgen;
  Linie nach X sortiert, gleiche X zusammengefasst, NULL als Lücke; Gruppen bis zur Grenze; Ausdünnen von
  200 000 Punkten auf 600 px – Spitze und Senke bleiben, die Lücke bleibt, im Ausschnitt sind alle Punkte da;
  Punktwolke; Zeilennummer als X; feindliche Namen; ungültige Angaben; Abbruch; Zwischenspeicher.
- **5 Mio. Punkte** (`cargo test --release --lib chart::tests::five_million -- --ignored --nocapture`):
  erstes Diagramm **0,64 s**, ein Zoomschritt **1,4 ms** (M-Serie, Release-Build).
- **Fenster** (28 Tests): Ticks (rund, logarithmisch, Zeit von Millisekunden bis Jahrzehnte), Beschriftungen,
  Skalen, Linie mit Lücken, Wertebereich (Balken ab 0, gestapelt, logarithmisch), Balken nebeneinander und
  gestapelt, Marker und Punkte, Punkt unter dem Zeiger, Ziehen und Schritte, Layout ohne ausgeblendete Reihen,
  Beschreibung, SVG-Datei (Namen maskiert, gültiges XML, keine Tokens); Komponente (Vorschlag, Einstellung des
  Tabs, unpassende Einstellung, nichts zu zeichnen, wartet auf das Ende der Anweisung, Zoom ohne erneutes Lesen,
  neu aufbereiten wenn das Backend das Diagramm nicht mehr hat, Reihe ausblenden, Namen als Text, Fehler,
  Kopieren und Speichern, Freigeben).
- **Im Browser** mit nachgebildetem Backend: Zeitreihe mit zwei Reihen (Lücken sichtbar, Spitze sichtbar, zweite
  Reihe gestrichelt), Tooltip, Ziehen → `chart_zoom` mit dem Ausschnitt, Doppelklick → alles; Wechsel auf das
  helle Schema → die Linien haben die Farben des Schemas, ohne neu zu lesen; Balken gestapelt mit Schraffur, eine
  Kategorie `<b>ES</b>` bleibt Text. **Nicht bedient:** das native Fenster; die 17 Schemata nicht einzeln
  angesehen (die Kontrastprüfung deckt `--chart-*` gegen den Hintergrund).
- `pnpm check` grün.

## Review

Kein zweiter Review: Das Diagramm liest nur aus dem Ergebnisspeicher und baut kein SQL.

## Nicht umgesetzt

- **PNG und „Kopieren als Bild“**: Die Zwischenablage gehört Rust (`arboard`), und dessen Bild-Unterstützung ist
  bewusst abgeschaltet (zieht eine Bildbibliothek nach). Es gibt SVG als Datei und als Text in der
  Zwischenablage.
- **Diagramm-Einstellung an der gespeicherten Abfrage** (024): Die Einstellung lebt mit dem Tab, nicht im Kopf
  der `.sql`-Datei.
- **Gestapelt** nur für Balken; Flächendiagramm und gestapelte Linien fehlen.
- **Zoom der Wertachse** und Zoom bei Balken (Kategorien): gezoomt wird X von Linie und Punktwolke.
- Mehr als 40 Mio. Punkte lehnt das Diagramm ab („in der Abfrage zusammenfassen“); mehr als 500 Kategorien und
  12 Reihen werden abgeschnitten und gezählt.
- Zeitstempel ohne Zone gelten als UTC; eine Umrechnung in die Zeitzone des Rechners gibt es nicht.
