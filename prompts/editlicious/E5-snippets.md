# Prompt E5 (editlicious): Textbausteine mit Platzhaltern

> **Repo:** `../editlicious` · **Gebraucht von:** Schema Commander 024 (und E3 für `insertText`) · **Umfang:** M
> Lies `prompts/editlicious/README.md` hier.

## Ziel

Einen Baustein einfügen und mit `Tab` von Platzhalter zu Platzhalter springen – die übliche Snippet-Syntax
(`${1:name}`, `$2`, `$0`, gleiche Nummer = gemeinsam bearbeiten).

## Aufgaben

1. `insertSnippet(template, range?)` und Unterstützung in den Vorschlägen (E3: `insertText` als Snippet).
2. Platzhalter-Modus: `Tab`/`Shift+Tab` springen, gleiche Nummern werden gemeinsam getippt (Mehrfach-Cursor),
   `Esc` oder Verlassen des Bereichs beendet, `$0` ist die Endposition; Einrückung der Zeile wird übernommen.
3. Variablen der Seite: `insertSnippet(template, { vars: { TABLE: 'orders' } })`; eingebaute wie Auswahl
   (`$SELECTION`) und Datum.
4. **Kürzel-Auslöser** (optional, Sache der Seite): `el.snippets = [{ prefix: 'sel', body: '…' }]` → erscheinen in
   der Vorschlagsliste und expandieren mit `Tab`.
5. Ein Einfügen = ein Undo-Schritt; Platzhalter-Zustand übersteht Undo/Redo sinnvoll.

## Akzeptanzkriterien

- `SELECT ${1:*} FROM ${2:table} WHERE ${3:1=1};$0` lässt sich nur mit Tab und Tippen ausfüllen.
- Gleiche Nummer an drei Stellen wird gemeinsam bearbeitet.
- Ein Snippet mit literalem `$` und `}` (maskiert) kommt richtig an (Parser-Tests).
