# Prompt E3 (editlicious): Vervollständigung von außen

> **Repo:** `../editlicious` · **Gebraucht von:** Schema Commander 021 · **Umfang:** M–L
> Lies `prompts/editlicious/README.md` hier; in editlicious `docs/completion.md` (Wort-Vervollständigung heute).

## Ziel

Die Seite liefert Vorschläge (Schema Commander: Tabellen, Spalten, Funktionen aus der Datenbank); der Editor zeigt
sie in seiner vorhandenen Vorschlagsliste, sortiert und fügt ein. Der Editor weiß nichts über SQL.

## Aufgaben

1. **Anbieter registrieren**: `el.completionProvider = async (ctx) => Item[] | null`. `ctx`: Cursorposition, Text der
   Zeile bis zum Cursor, das angefangene Wort, das auslösende Zeichen, ein `AbortSignal` (überholte Anfragen) und eine
   Funktion, um bei Bedarf Text um den Cursor zu holen (nicht der ganze Text ungefragt).
2. **Vorschlag**: `label`, `insertText` (optional mit Platzhaltern, s. E5), `kind` (frei wählbare Klasse für Icon und
   Farbe), `detail` (rechts, z. B. Typ), `documentation` (Text), `sortText`, `filterText`, zu ersetzender Bereich.
3. **Auslöser**: `Ctrl+Space`, beim Tippen (einstellbar), nach Zeichen, die der Anbieter nennt (`.`, Leerzeichen
   nach `FROM` entscheidet die Seite).
4. **Zusammenspiel** mit der eingebauten Wort-Vervollständigung: einstellbar „nur Anbieter“, „Anbieter zuerst, dann
   Wörter“, „nur Wörter“.
5. Liste per Tastatur und Maus, Filtern beim Weitertippen ohne neue Anfrage, wenn der Anbieter „vollständig“
   meldet; Barrierefreiheit (`role="listbox"`, aktives Element angesagt).
6. Nichts blockiert das Tippen: Antwort zu spät oder abgebrochen → kein Flackern, keine veraltete Liste.

## Akzeptanzkriterien

- Ein Demo-Anbieter mit 50 000 Einträgen bleibt beim Tippen flüssig.
- Ein Anbieter, der 2 s braucht, stört das Tippen nicht; seine verspätete Antwort erscheint nicht mehr.
- Ohne Anbieter verhält sich der Editor wie heute.
