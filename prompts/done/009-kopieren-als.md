# Prompt 009: Kopieren als …

> **Slug:** `kopieren-als` · **Feature:** D6 · **Braucht:** 007 · **Umfang:** S–M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DataGrip (Daten-Extraktoren), TablePlus („Copy as“).

## Ziel

Markierte Zellen, Zeilen oder das ganze Ergebnis in dem Format in die Zwischenablage, das man gerade braucht.

## Aufgaben

1. **Formate** (reine Funktionen, eine Schnittstelle „Extraktor“, die Prompt 011 für Dateien wiederverwendet):
   TSV (Vorgabe für `Mod+C`, passt in Excel), CSV (Trenner, Anführungszeichen, Zeilenende einstellbar), JSON
   (Array von Objekten; Zahlen bleiben Zahlen, 64-Bit/Dezimal als Text), Markdown-Tabelle, `INSERT`-Anweisungen
   (Tabelle bekannt oder Platzhalter; Werte je Dialekt richtig geschrieben), `IN (…)`-Liste einer Spalte,
   `WHERE`-Bedingung aus der Zeile, HTML-Tabelle (für E-Mail), nur Werte einer Spalte zeilenweise.
2. **Optionen**: mit/ohne Kopfzeile, `NULL` als leer/`NULL`/`\N`, Spaltenauswahl.
3. **Bedienung**: `Mod+C` = Vorgabeformat, `Mod+Shift+C` bzw. Kontextmenü „Kopieren als …“ mit zuletzt benutztem
   Format oben; Aktionen in der Palette; Statuszeile meldet „n Zeilen kopiert“.
4. **Große Auswahl**: Die Zeilen liegen in Rust (Prompt 006) – das Kopieren läuft dort als abbrechbarer Job und
   schreibt direkt in die Zwischenablage; Grenze mit Rückfrage („2 Mio. Zeilen, ~600 MB – stattdessen exportieren?“).
5. Zwischenablage als `text/plain`, bei HTML zusätzlich `text/html`.

## Entscheidungsfragen (Design)

- Zwischenablage über die WebView (`navigator.clipboard`) oder über Rust? (Größe, Formate, Linux/Wayland.)
- Literale für `INSERT` je Dialekt: Datum, Bool, Binär, JSON – Tabelle im Design.

## Akzeptanzkriterien

- Auswahl mit Tabs, Zeilenumbrüchen, Anführungszeichen und `NULL` kommt in Excel/LibreOffice (TSV, CSV) und als
  ausführbares `INSERT` wieder richtig an (Rundreise-Test: kopieren → einfügen → vergleichen).
- 1 Mio. Zeilen kopieren blockiert das Fenster nicht und lässt sich abbrechen.

## Tests

Rein: Katalog je Format mit bösen Werten (Trenner im Wert, Unicode, sehr lange Zellen, `\0`). Ende-zu-Ende: Einfügen
in eine Tabellenkalkulation und zurück in die Datenbank.
