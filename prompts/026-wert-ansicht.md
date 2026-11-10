# Prompt 026: Wert-Ansicht

> **Slug:** `wert-ansicht` · **Feature:** D3 · **Braucht:** 006, 007 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DBeaver (Value-Panel), TablePlus (Seitenfeld).

## Ziel

Was nicht in eine Zelle passt, zeigt ein Seitenfeld: langer Text, formatiertes JSON/XML, Bilder, Binärdaten als Hex –
für die aktuelle Zelle, mitlaufend beim Bewegen im Gitter.

## Aufgaben

1. **Feld** rechts oder unten neben dem Ergebnis (ein-/ausblendbar, Größe gemerkt, Aktion + Kürzel); folgt der
   aktiven Zelle, gedrosselt.
2. **Voller Wert auf Anfrage** aus dem Ergebnisspeicher (Prompt 006): Command `cell_value(resultId, row, col,
   range)`; große Werte stückweise. Der Text lebt in `<editlicious-editor readonly>` – auch 100 MB sind kein Problem.
3. **Ansichten** mit automatischer Wahl und Umschalter: Text (Umbruch an/aus), JSON (eingerückt, Hervorhebung), XML,
   Hex + ASCII für Binär, Bild (PNG/JPEG/GIF/WebP aus Binärdaten; sicher dekodieren, Größenlimit), Datum mit
   Zeitzonen-Umrechnung, Zahl in Hex/Binär, Geometrie als WKT. Kopfzeile: Typ, Länge in Zeichen/Bytes, Kodierung.
4. **Aktionen**: kopieren, in Datei speichern (Binär roh), Suchen im Wert, „als JSON-Pfad kopieren“ – optional.
5. **Bearbeiten** bleibt Prompt 031/032; das Feld ist hier nur lesend, aber so gebaut, dass es später schreiben kann.
6. Sicherheit: nichts aus dem Wert wird als HTML/SVG gerendert oder nachgeladen; Bilder nur als Rasterdaten über
   `blob:`/`data:` im Rahmen der CSP.

## Akzeptanzkriterien

- JSON von 50 MB in einer Zelle: das Gitter zeigt den Anfang, das Feld den formatierten ganzen Wert, das Fenster
  bleibt bedienbar.
- Bild in `bytea`/`BLOB` wird gezeigt; eine als Bild getarnte Riesen- oder Kaputtdatei schadet nicht.
- Schnelles Durchlaufen von Zellen mit den Pfeiltasten ruckelt nicht (überholte Anfragen werden verworfen).

## Tests

Rust: Teilwerte, Grenzen, Bilderkennung. Rein: Wahl der Ansicht, JSON-Formatierung großer/defekter Werte. Frontend
mit Fake: Mitlaufen, überholte Antworten.
