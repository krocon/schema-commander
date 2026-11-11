# Prompt 005: Anweisungen ausführen

> **Slug:** `ausfuehren` · **Feature:** C2 · **Braucht:** 003, 004, E2 (editlicious: Auswahl abfragen) · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Bestand: `src/app/features/editor/sql-split.ts`, `sql-editor.ts`,
> `src-tauri/src/commands.rs`. Vorbild: DataGrip, DBeaver.

## Ziel

Ausführen, wie man es erwartet: **Anweisung unter dem Cursor**, **Auswahl**, **ganzes Skript**; mehrere Ergebnisse;
**Abbrechen auf dem Server**; Laufzeit, betroffene Zeilen und Meldungen des Servers.

## Aufgaben

1. **Zerlegen je Dialekt**: `sql-split.ts` ausbauen bzw. nach Rust verlegen: PostgreSQL (`$$`/`$tag$`, `E''`,
   verschachtelte Kommentare), MySQL (`DELIMITER`, Backticks, `#`-Kommentar), SQL Server (`GO`, `[…]`), SQLite
   (`BEGIN … END` in Triggern). Testkatalog als `.cases.json`.
2. **Auswahl ausführen**: editlicious liefert die Auswahl heute nicht als Text (`ed-caret` nennt nur Längen). Das
   bringt **Prompt E2** (`prompts/done/editlicious/E2-auswahl-abfragen.md`); hier wird nur die neue Methode benutzt.
3. **Ausführung als Job in Rust**: Skript = Liste von Anweisungen, nacheinander auf der Sitzung des Tabs;
   Ereignisse über einen `Channel` (gestartet, Spalten, Fortschritt, fertig, Fehler, Meldung/NOTICE). Einstellung
   „bei Fehler anhalten / weiterlaufen“.
4. **Abbrechen**: je Treiber der richtige Weg (PostgreSQL Cancel-Request, MySQL `KILL QUERY` über zweite Verbindung,
   SQL Server Attention, SQLite Interrupt). Danach ist die Sitzung wieder benutzbar.
5. **Ausgabe**: Reiter „Meldungen“ je Tab (Anweisung, Dauer, Zeilen, Hinweise, Fehler mit Position); mehrere
   Ergebnisse vorerst nacheinander als einfache Unter-Reiter (Ausbau in Prompt 041).
6. **Laufanzeige**: laufende Anweisung im Tab sichtbar (Reiter, Statuszeile, Dauer zählt), Toolbar-Knopf wird zu
   „Abbrechen“; Aktionen `RUN_STATEMENT`, `RUN_SELECTION`, `RUN_SCRIPT`, `CANCEL`.

## Entscheidungsfragen (Design)

- Zerlegen im Frontend (schnell für „unter dem Cursor“) oder in Rust (eine Wahrheit je Dialekt)? Oder beides aus
  einem Testkatalog?
- Zeitlimit je Anweisung als Einstellung? Was passiert mit einer laufenden Anweisung beim Schließen des Tabs?
- Wie viele Zeilen holt „Ausführen“ zunächst (bis Prompt 006 das Nachladen bringt)?

## Akzeptanzkriterien

- Skript mit 50 Anweisungen, eine davon fehlerhaft: je nach Einstellung hält es an oder läuft weiter; die Meldungen
  nennen jede Anweisung mit Dauer.
- `SELECT pg_sleep(60)` (und das Gegenstück je Datenbank) lässt sich in unter einer Sekunde abbrechen; danach läuft
  die nächste Anweisung normal.
- Cursor mitten in einer Funktion mit `$$ … ; … $$` führt die ganze Funktion aus, nicht ein Bruchstück.

## Tests und Review

Rein: Zerleger-Katalog je Dialekt. Rust gegen Container: Abbruch, Fehler mitten im Skript, Meldungen. Review:
Zustände bei Abbruch und Verbindungsverlust, keine Anweisungstexte im Log.
