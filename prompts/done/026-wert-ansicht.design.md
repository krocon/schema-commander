# Design 026: Wert-Ansicht

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/wert-ansicht` · Auftrag: [026-wert-ansicht.md](026-wert-ansicht.md) · Feature D3

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | **Wo liegt der ganze Wert?** | Bis 025 kürzten die Treiber Texte auf 32 768 Zeichen und behielten von Binärdaten 16 Bytes – der Ergebnisspeicher hatte den Wert gar nicht. Jetzt (mit Marcs Zustimmung): Die **Zelle trägt den ganzen Wert**, die **Zeile** kürzt beim Schreiben wie bisher (`Serialize for Cell`), und der Speicher legt, was die Zeile nicht ganz zeigt, in einer eigenen Datei je Ergebnis ab (`<id>.values`, Index Zeile/Spalte → Stelle, Länge, binär). Fenster, Kopieren und Export lesen weiter die kurzen Zeilen | die Zeilen bleiben klein und schnell, nichts an 006/007/009/011 ändert sich im Verhalten |
| E2 | Grenzen | Ganze Werte zählen gegen die Grenze des Ergebnisses (4 GB): ist sie erreicht, wird das Ergebnis dort abgeschnitten wie bisher. `VecSink` (kleine Fragen der App) zählt die ganzen Bytes | |
| E3 | Vertrag | `cell_value(result_id, row, col, from, max) → { kind: null \| text \| bytes \| unreadable, total, from, to, text?, base64?, image? }` – Bytes; ein Textstück endet an einem Zeichen (`to` kann bis 3 Bytes hinter `from + max` liegen), höchstens 8 MB je Stück. `save_cell_value(…, path)` schreibt den ganzen Wert (Text UTF-8, binär roh) neben das Ziel und benennt um; `copy_cell_value` legt den ganzen Text in die Zwischenablage, ohne dass er das Fenster passiert (bis 256 MB) | |
| E4 | Bilder | Erkannt im Backend an den ersten Bytes (`image_info.rs`: PNG, JPEG, GIF, WebP mit Breite und Höhe aus dem Kopf), **nie dort dekodiert**. Das Fenster zeichnet nur, wenn der Kopf ein Rasterformat nennt, die Daten ≤ 32 MB sind und der Kopf ≤ 16 384 px je Seite und ≤ 100 Megapixel zugibt; sonst Hex. Gezeichnet wird über `blob:` mit genau dem genannten Typ (CSP `img-src` um `blob:` erweitert). Scheitert das Zeichnen, fällt das Feld auf Hex zurück und sagt es. SVG ist Text und wird nie gezeichnet | Aufgabe 6, Akzeptanzkriterium 2 |
| E5 | Ansichten | Wahl aus Spaltenart und Anfang des Textes, umschaltbar: **Text**, **JSON** (Spalte `json` oder Text, der wie JSON beginnt), **XML**, **Hex + ASCII**, **Bild**, **Zahl** (ganze Zahl dezimal/hex/binär, exakt per `BigInt`), **Datum** (ein Zeitpunkt mit Zone in UTC, hiesiger Zeit und Sekunden seit 1970; ohne Zone nur der Wochentag – eine Uhrzeit wird nicht verschoben) | |
| E6 | JSON formatieren | **ohne zu parsen**: nur der Leerraum zwischen den Tokens wird neu gesetzt (`JsonLayout`). Lange Zahlen, doppelte Schlüssel, Reihenfolge bleiben; defektes JSON wird so weit gesetzt, wie die Klammern reichen, und geht nie verloren. Arbeitet in Schritten von 400 000 Zeichen, dazwischen kommt das Fenster dran | `JSON.parse` würde `12345678901234567890123` zu `1.2345678901234568e+22` machen |
| E7 | Mitlaufen | Das Gitter meldet die Zelle des Cursors (`focusChanged`); das Feld fragt 120 ms nach der letzten Bewegung und verwirft Antworten für eine Zelle, die der Cursor verlassen hat. Gelesen werden zuerst 256 KB; bis 4 MB (und für Bilder) der Rest sofort, darüber auf Knopfdruck – wer durch Zellen läuft, zieht keine 50 MB | Akzeptanzkriterium 3 |
| E8 | Anzeige | Text lebt in `<editlicious-editor readonly>` (Grammatik JSON/XML, Umbruch als Einstellung, Hex nie umbrochen). Kopfzeile: Spalte, Typ, Zeichen (sobald der Wert ganz da ist) und Bytes, bei Bildern Format und Maße. Hex zeigt die ersten 256 KB; die Datei hat alles | |
| E9 | Platz | rechts neben dem Gitter, mit Trenner; ein-/ausblendbar (`TOGGLE_VALUE_PANEL`, `Mod+K Mod+V`), Breite und Umbruch gemerkt. Nur rechts, nicht unten | ein Platz reicht; „unten“ nähme dem Gitter die Zeilen |
| E10 | Aktionen | `COPY_CELL_VALUE`, `SAVE_CELL_VALUE` (auch im Kontextmenü des Ergebnisses); Suchen im Wert macht der Editor (`Mod+F`) | |
| E11 | Lesend | Das Feld bekommt die Zelle als `(Ergebnis, Zeile, Spalte)` und hält den Wert als Signal – Schreiben (031/032) kann dort ansetzen | Aufgabe 5 |

## Geprüft

- **Rust**: ganze Werte getrennt ablegen und in Stücken lesen (Text mit Mehrbyte-Zeichen: 200+ Stücke, jedes endet an
  einem Zeichen, zusammen der ganze Wert; 100 000 Bytes binär; kurze Werte aus der Zeile; Stelle hinter dem Ende;
  Zelle, die es nicht gibt), Datei verschwindet mit dem Ergebnis, Grenze des Ergebnisses, Bilderkennung (vier
  Formate, behauptete Riesenmaße, SVG und anderes ist kein Bild). Alle Rust-Tests grün.
- **Rein**: Wahl der Ansicht, JSON (unverändert bis auf Leerraum, defekt, in Schritten, 2 MB unter 3 s im Test),
  XML, Hex, Zahl, Datum, Größen.
- **Feld mit Fake**: Mitlaufen, überholte Antworten, mittlere und große Werte, Bild/Riesenbild/kaputtes Bild,
  Kopieren und Speichern.
- **Unter der Produktions-CSP** (`pnpm build && pnpm preview:csp`, mit `editlicious-editor` 1.3.0): der Editor
  lädt (Worker, WebAssembly), ein Bild hinter `blob:` wird gezeichnet, keine Meldung in der Konsole.
- **Im Browser im echten Editor** (Backend nachgestellt): 50 MB JSON in einer Zelle – das Gitter zeigt den Anfang,
  das Feld erst 256 KB formatiert, auf Knopfdruck den ganzen Wert in 14 Stücken: 5,7 Mio. Zeilen, bis auf Leerraum
  identisch mit dem Wert, längste Pause des Fensters dabei 204 ms. Echtes PNG wird gezeichnet (120 × 80 über
  `blob:`); ein Kopf, der 4 Mrd. × 4 Mrd. Pixel behauptet, wird nie gezeichnet (nur Hex); kaputte „PNG“-Daten fallen
  auf Hex zurück mit Hinweis.

## Nicht umgesetzt, nicht geprüft

- **Das native Fenster** wurde nicht bedient; die Treiber liefern jetzt ganze Werte – das ist durch die
  Treiber-Suite gegen echte Server gedeckt (siehe unten), die Kette bis ins Feld nicht in einem Stück.
- **Kopieren und Export** (009/011) schreiben weiter, was die Zeile zeigt (Text ab 32 768 Zeichen gekürzt, von
  Binärdaten die ersten 16 Bytes). Das war schon so; mit E1 ließe es sich ändern – eigener Auftrag.
- **Geometrie als WKT**: Geometrie-Spalten kommen als „nicht lesbar“ aus den Treibern; das Feld nennt den Typ.
- „Als JSON-Pfad kopieren“ (im Auftrag „optional“); Feld unten statt rechts; Bild zoomen.
- **Speicher**: Ein Wert wird als Ganzes vom Treiber gelesen (eine Zeile mit 1 GB in einer Zelle braucht 1 GB).
  Das Fenster liest höchstens 256 MB eines Wertes; darüber bleibt die Datei.
- XML wird mit einfachen Regeln eingerückt (kein Parser): Text und Elemente gemischt landen auf eigenen Zeilen.

## Fortschritt

- [x] Rust · [x] Logik · [x] Feld · [x] Browser · [x] Doku · [x] `pnpm check` · [x] Treiber gegen Container
