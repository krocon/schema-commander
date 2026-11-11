# Design 005: Anweisungen ausführen

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/ausfuehren` · Auftrag: [005-ausfuehren.md](005-ausfuehren.md) · Feature C2

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Zerlegen: Frontend oder Rust? | **im Frontend** (`features/editor/sql-split.ts`, rein), eine Wahrheit mit Testkatalog `sql-split.cases.json` (32 Fälle, 64 Läufe) | „Anweisung unter dem Cursor“ muss ohne Umweg über die Brücke gehen; Rust bekommt fertige Anweisungen |
| E2 | Dialekte | PostgreSQL: Dollar-Quoting (`$$`, `$tag$`), `E'…'` mit Backslash, verschachtelte Blockkommentare · MySQL: Backticks, `#`-Kommentar, Backslash in Strings, `DELIMITER` · SQL Server: `[Namen]`, `GO` · SQLite: `CREATE TRIGGER … BEGIN … END` behält seine inneren `;` | Auftrag |
| E3 | SQL Server | „unter dem Cursor“ trennt an `;`, ein **Skript läuft batchweise** (`GO`) – `splitForRun` | ein Batch wird als Ganzes übersetzt, seine Anweisungen teilen sich Variablen |
| E4 | Skript ausführen | das **Frontend** schickt Anweisung für Anweisung (`run_query`), kein Job mit Kanal in Rust | ein Aufruf je Anweisung reicht; Fortschritt, Abbruch und „bei Fehler anhalten“ liegen dort, wo die Anzeige ist. Server-Meldungen (NOTICE) gibt der Treiber ohnehin nicht her (s. unten) |
| E5 | Auswahl ausführen | `Mod+Enter`: ist etwas markiert, läuft **die Auswahl** (in ihre Anweisungen zerlegt), sonst die Anweisung unter dem Cursor. `Mod+Shift+Enter`: das ganze Skript | eine Taste für den häufigsten Fall; eigene Aktion `RUN_SELECTION` wäre dasselbe |
| E6 | Abbrechen | **auf dem Server**, die Sitzung bleibt: PostgreSQL `pg_cancel_backend(pid)` und MySQL/MariaDB `KILL QUERY id` über eine **zweite Verbindung**, SQLite `interrupt`. Die Anweisung bekommt 3 s, mit dem „abgebrochen“ des Servers zu enden; erst dann wird die Verbindung verworfen. **SQL Server:** `tiberius` kann das Attention-Signal nicht senden – dort kostet ein Abbruch die Verbindung (wie bisher) | temporäre Tabellen, Variablen und (später) offene Transaktionen überleben einen Abbruch; Test `a_cancelled_session_goes_on_with_its_state` |
| E7 | Zeitlimit | Einstellung `statementTimeoutSec` (0 = keins), als `timeout_ms` am Command; läuft es ab, wird wie bei E6 abgebrochen und `timeout` gemeldet | lange Läufer enden ohne Zutun; die Sitzung bleibt |
| E8 | Bei Fehler | Einstellung `stopOnError` (Vorgabe an): der Rest des Skripts wird nicht ausgeführt („nicht ausgeführt“ in der Zählung) | Vorgabe wie in den meisten Werkzeugen; für Lade-Skripte abschaltbar |
| E9 | Mehrere Ergebnisse | Unter-Reiter je Anweisung (✓ ✗ –) und „Meldungen“; nach dem Lauf steht der erste Fehler vorn, sonst das erste Ergebnis mit Zeilen, sonst die Meldungen | Ausbau (anpinnen, vergleichen) in Prompt 041 |
| E10 | Wie viele Ergebnisse bleiben? | die ersten **20** mit Zeilen je Lauf, weitere werden nur gezählt (Hinweis im Reiter); je Ergebnis weiter höchstens 100 000 Zeilen | Speicher der WebView, bis Prompt 006 Ergebnisse in Rust hält |
| E11 | Neuer Lauf während eines laufenden | der neue ersetzt den alten: der alte wird abgebrochen, seine Antworten verworfen | kein Stau; Schließen des Tabs bricht ebenfalls ab |
| E12 | Meldungen | je Tab die letzten 500 Einträge: Uhrzeit, erste Zeile der Anweisung, Ausgang, Dauer | nur im Speicher; den dauerhaften Verlauf bringt Prompt 010 |

Aktionen: `RUN_STATEMENT` (`Mod+Enter`), `RUN_SCRIPT` (`Mod+Shift+Enter`), `CANCEL_QUERY` (`Mod+.`), `SHOW_MESSAGES`.

## Nicht umgesetzt

- **Meldungen des Servers** (`NOTICE`, `PRINT`, Warnungen): `sqlx` reicht sie nicht an den Aufrufer weiter (nur ins
  Log), `tiberius` verwirft Info-Meldungen. Offen; braucht einen Eingriff in die Treiberschicht.
- **Fehler mit Position** im Editor: Prompt 022.
- **MySQL `SLEEP()`** endet nach `KILL QUERY` ohne Fehler (liefert 1): Ein abgebrochenes `SLEEP` erscheint als
  normales Ergebnis. Echte Abfragen werden als „abgebrochen“ gemeldet.
- Zwei Tabs auf derselben Verbindung teilen weiter eine Sitzung (Design 003 E4, 004).

## Tests

- Frontend (281): `sql-split.spec.ts` (Katalog je Dialekt, Positionen, 50 000 Anweisungen in < 2 s, ganze Funktion
  unter dem Cursor), `query-tab.spec.ts` (Reihenfolge, Anhalten/Weiterlaufen, Abbruch mitten im Skript,
  behaltene Ergebnisse, Zeitlimit), `run-state.spec.ts`.
- Rust (59) und **gegen echte Server** (10, alle grün am 11.11.2026): Abbruch in < 1 s auf allen vier; die Sitzung
  bleibt bei PostgreSQL, MySQL, MariaDB samt temporärer Tabelle bzw. Variable; Zeitlimit; SQL Server verliert die
  Verbindung.

## Ende-zu-Ende und was offen ist

- Im Browser mit nachgestelltem Backend: Skript mit vier Anweisungen, eine fehlerhaft → Reiter ✓ ✓ ✗ –, Fehler
  vorn, Meldungen mit Dauer, Statuszeile zählt.
- **Nicht geprüft:** das native Fenster gegen einen echten Server; das Akzeptanzkriterium „50 Anweisungen“ wörtlich
  (geprüft mit 4 im Browser und 22 im Test); `Mod+Shift+Enter` als echter Tastendruck; Windows und Linux.
