# Prompt E1 (editlicious): Farben von außen

> **Repo:** `../editlicious` · **Gebraucht von:** Schema Commander 001 · **Umfang:** S–M
> Lies `prompts/done/editlicious/README.md` hier und in editlicious `CLAUDE.md`, `prompts/000-arbeitsweise.md`,
> `scripts/host-theme.mjs`, `src/styles.css`, `packages/editlicious-editor/README.md` („Styling“).

## Ziel

Eine Seite, die eigene Farbschemata hat (Schema Commander: 17 Schemata über CSS-Variablen), soll den Editor
**vollständig** einfärben können, ohne eines der 13 eingebauten Schemata zu wählen.

## Aufgaben

1. **Bestand aufnehmen**: Welche Variablen wirken heute von außen (`--ed-bg`, `--font-editor` …), welche nicht
   (Syntaxfarben, Gutter, Auswahl, Treffer, Cursor, Scrollbalken, Statuszeile, Dialoge wie Suchen)? Tabelle im Design.
2. **Öffentlicher Vertrag**: eine dokumentierte, stabile Liste von CSS-Variablen auf `:host` für alle Farben
   (Flächen, Text, Gutter, aktuelle Zeile, Auswahl, Treffer, Cursor, Klammerpaar, Einrückungslinien, Syntaxklassen
   Schlüsselwort/String/Zahl/Kommentar/Bezeichner/Funktion/Typ/Operator/ungültig, Wort-Marker, Übersichtsleiste).
   Was die Seite setzt, gewinnt über das gewählte `scheme`; was sie nicht setzt, kommt aus dem Schema.
3. **`scheme="none"`** (Arbeitsname) oder gleichwertig: kein eingebautes Schema, nur die Variablen der Seite plus
   `color-scheme` (hell/dunkel) als Attribut, damit Formularelemente und Scrollbalken passen.
4. Wechsel zur Laufzeit ohne Neuaufbau (die Seite ändert Variablen auf `<html>` oder am Element; der Editor folgt
   sofort, auch Canvas-Teile, falls es welche gibt).
5. README des Pakets: Tabelle aller Variablen mit Bedeutung und Beispiel; Test, der die Liste gegen den Code prüft.

## Akzeptanzkriterien

- Zwei Editoren nebeneinander, einer mit eingebautem Schema, einer nur über Variablen der Seite gefärbt.
- Jede dokumentierte Variable ändert sichtbar genau ihren Teil; keine Farbe im Editor ist von außen unerreichbar.
- Die Desktop-App und die 13 Schemata sehen aus wie vorher (Bildvergleich bzw. bestehende Tests).
