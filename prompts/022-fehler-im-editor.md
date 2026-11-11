# Prompt 022: Fehler an der Stelle zeigen

> **Slug:** `fehler-im-editor` · **Feature:** C4 · **Braucht:** 005, E4 (editlicious: Markierungen von außen) ·
> **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`, `prompts/done/editlicious/E4-markierungen-von-aussen.md`. Vorbild: pgAdmin,
> DataGrip.

## Ziel

Schlägt eine Anweisung fehl, sieht man **wo**: Die Stelle ist im Editor unterstrichen, der Cursor springt hin, und die
Meldung des Servers ist vollständig lesbar.

## Aufgaben

1. **Fehlerdetails je Treiber** in `AppError` (strukturiert, nicht nur Text): Code (`SQLSTATE` bzw. Fehlernummer),
   Meldung, Detail, Hinweis, Position (PostgreSQL: Zeichenposition; MySQL: „near '…' at line n“ auswerten; SQL
   Server: Zeile; SQLite: Offset, wo verfügbar), Kontext, betroffenes Objekt/Constraint.
2. **Position umrechnen**: von der Position in der gesendeten Anweisung auf Zeile/Spalte im Editor (Anfang der
   Anweisung im Skript, Zeichenzählung Bytes/Zeichen/UTF-16, CRLF) – reine Funktion mit Katalog.
3. **Anzeige**: Markierung über E4 (`setMarkers('sql-error', …)`), Randsymbol, Tooltip; Sprung mit `F8`/Klick auf
   die Meldung; Markierung verschwindet beim nächsten Lauf oder beim Bearbeiten der Stelle.
4. **Meldungsbereich**: Fehler mit Code, Detail und Hinweis getrennt dargestellt; kopierbar; bei
   Constraint-Verletzungen das Objekt als Verweis (öffnet Details, Prompt 019).
5. **Laufende Anweisung** im Editor hervorheben (zweiter Markierungs-Besitzer), bei Skripten Fortschritt am Rand.
6. Optional: **Vorabprüfung** ohne Ausführen (`PREPARE`/`EXPLAIN` bzw. Entsprechung) als Aktion „Prüfen“ – im
   Design bewerten (Nebenwirkungen, Rechte).

## Akzeptanzkriterien

- Tippfehler in der dritten Anweisung eines Skripts mit Umlauten und Emoji davor: Unterstreichung sitzt exakt auf
  dem Wort, in allen vier Datenbanken (soweit die Datenbank eine Position liefert).
- Liefert die Datenbank keine Position, wird die ganze Anweisung markiert.
- Die Meldung zeigt `DETAIL` und `HINT` von PostgreSQL.

## Tests

Rein: Positions-Katalog. Rust gegen Container: Fehlerdetails je Treiber. Ende-zu-Ende: Sprung und Markierung.
