# Prompt E2 (editlicious): Auswahl und Bereiche abfragen

> **Repo:** `../editlicious` · **Gebraucht von:** Schema Commander 005, 023 · **Umfang:** S
> Lies `prompts/editlicious/README.md` hier; in editlicious `packages/editlicious-editor/editlicious-editor.d.ts`.

## Ziel

Die Seite kann die **Auswahl als Text** lesen und einen **Bereich gezielt ersetzen**. Heute gibt es nur `getValue()`
(alles), `getSlice(from, to)` (ganze Zeilen) und `ed-caret` (Position und Längen).

## Aufgaben

1. `getSelection()` → `{ text, start: { line, ch }, end: { line, ch } }` der Hauptauswahl; leer, wenn nichts markiert
   ist. Bei mehreren Cursorn/Blockauswahl: `getSelections()` mit allen Bereichen in Dokumentreihenfolge.
2. `getRange(start, end)` → Text eines beliebigen Bereichs (nicht nur ganze Zeilen); mit Obergrenze bzw. Hinweis im
   Typ, dass riesige Bereiche teuer sind.
3. `replaceRange(start, end, text)` als **ein** Undo-Schritt (für „Auswahl formatieren“, „`*` aufklappen“);
   `replaceSelection(text)`.
4. `ed-caret` um die Endposition der Auswahl ergänzen (heute nur Längen), abwärtskompatibel.
5. Zeichen-Zählung festlegen und dokumentieren (UTF-16-Einheiten wie JavaScript oder Codepunkte?), mit Tests für
   Emoji, kombinierende Zeichen, CRLF.

## Akzeptanzkriterien

- Auswahl über mehrere Zeilen mit Emoji und CRLF kommt exakt zurück; `replaceRange` mit demselben Text ändert nichts.
- In einer Datei mit 5 Mio. Zeilen kostet `getSelection()` einer kleinen Auswahl keine messbare Zeit.
- Typen und README sind ergänzt; bestehende Methoden unverändert.
