# Design 022: Fehler an der Stelle zeigen

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/fehler-im-editor` · Auftrag: [022-fehler-im-editor.md](022-fehler-im-editor.md) · Feature C4

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Fehlerdetails | `AppError` bekommt `details: Option<ErrorDetails>` (fehlt bei Fehlern der App selbst): `sqlstate` (SQLSTATE bzw. Fehlernummer), `detail`, `hint`, `position` (Zeichen ab 1), `line` (ab 1), `near`, `context`, `schema`, `table`, `column`, `constraint`. Jede Datenbank füllt, was sie weiß | strukturiert statt Text; der Vertrag ist auf beiden Seiten getestet |
| E2 | Je Treiber | **PostgreSQL**: SQLSTATE, DETAIL, HINT, CONTEXT, Position, Schema/Tabelle/Spalte/Constraint (aus dem Fehler von sqlx). **MySQL/MariaDB**: Nummer und SQLSTATE; `near '…' at line n` aus der Meldung gelesen. **SQL Server**: Nummer, Zeile des Batches, Prozedur als Kontext, der Name in Hochkommas aus der Meldung. **SQLite**: erweiterter Code und der Byte-Offset der Stelle (neues Feature `modern_sqlite` von rusqlite, keine neue Abhängigkeit) | „soweit die Datenbank eine Position liefert“ |
| E3 | Einheit der Position | über die Brücke immer **Zeichen ab 1**: SQLite zählt Bytes – das Backend rechnet um (`char_position`). Das Frontend rechnet Zeichen → UTF-16 (ein Emoji ist für die Datenbank ein Zeichen, für den Editor zwei) | eine Einheit im Vertrag, zwei Umrechnungen, je eine Stelle |
| E4 | Von der Anweisung zum Editor | `core/errors/error-position.ts` (rein, Katalog mit 28 Fällen): Position → das Token, das dort beginnt (Wort, gequoteter Name, sonst ein Zeichen); `near` + Zeile → der Text auf dieser Zeile, sonst dahinter, sonst irgendwo (bei langem Zitat das erste Token; ohne Rücksicht auf Groß/Klein als letzter Versuch); nur Zeile → die Zeile ohne Ränder; nichts → die ganze Anweisung. Dann Offset → Zeile/Spalte ab dem Anfang der Anweisung im Skript | Aufgabe 2 |
| E5 | Wo steht die Anweisung? | Der Editor merkt sich beim Start eines Laufs, wo jede Anweisung beginnt (Auswahl: Anfang der Auswahl + Versatz; Skript: Versatz im Text). Für Läufe, die nicht aus dem Editor kommen (Tabelle öffnen, Verlauf), sucht er den Text | Zeilen dürfen sich nach dem Start nicht mehr auf den Lauf auswirken |
| E6 | Anzeige | Markierung `sql-error` (Wellenlinie, `!` am Rand, Meldung als Tooltip, verschwindet beim Bearbeiten der Stelle: `onEdit: 'remove'`) und beim nächsten Lauf. Der erste Fehler eines Laufs holt den Cursor an die Stelle. `F8`/`Umschalt+F8` springen im Editor zwischen den Markierungen (Funktion des Editors); „Zur Stelle“ an der Meldung | Aufgabe 3 |
| E7 | Laufende Anweisung | zweiter Besitzer `sql-running`: Zeilen getönt, `▶` am Rand, Tooltip „Anweisung 2 von 5“; Farbe `--ed-mark-running` aus dem Token `--ok` | Aufgabe 5 |
| E8 | Meldungsbereich | Meldung in voller Länge, darunter Code, Detail, Hinweis, Kontext, Objekt getrennt; „Meldung kopieren“ (Meldung, Teile und Anweisung als Text); bei einer genannten Tabelle „Details zu …“ (öffnet 019). Der Text lässt sich auch von Hand markieren | Aufgabe 4 |
| E9 | Vorabprüfung („Prüfen“) | **nicht umgesetzt.** `PREPARE` prüft in PostgreSQL und MySQL, hinterlässt aber eine vorbereitete Anweisung in der Sitzung und braucht dieselben Rechte wie das Ausführen; `EXPLAIN` gibt es nicht für DDL; SQL Server bräuchte `SET PARSEONLY`/`NOEXEC` als Sitzungszustand, SQLite prüft erst beim Vorbereiten gegen das Schema. Vier verschiedene Verhalten und ein Eingriff in die Sitzung des Tabs für eine Funktion, die der Auftrag „optional“ nennt | bewertet, wie verlangt |

## Geprüft

- Rust: Serialisierung der Details, `mysql_near`, `quoted_part`, `char_position`; SQLite-Positionen als Unit-Test.
- **Gegen echte Server** (`every_server_says_where_and_why_a_statement_failed`): PostgreSQL liefert SQLSTATE,
  Position (mit Umlaut und Emoji davor), HINT, bei einer Fremdschlüsselverletzung DETAIL, Constraint und Tabelle;
  MySQL und MariaDB `near` und Zeile; SQL Server Nummer, Zeile und den Namen in Hochkommas.
- Rein: Positions-Katalog (Umlaute, Emoji, CRLF, Anweisung mitten in einer Zeile, dritte Anweisung eines Skripts,
  alle vier Arten von Angaben, nichts bekannt).
- `query-tab.spec.ts`: Markierungen eines Laufs (löschen, läuft, Fehler mit Sprung, Ende).
- **Im Browser im echten Editor** (nachgestelltes Backend): Skript mit Umlauten und Emoji, Fehler in der dritten
  Anweisung mit PostgreSQL-Position – die Markierung liegt auf Zeile 4, Spalte 3–7, ihr Text ist `nmae`; `!` am
  Rand; der Cursor steht dort; die Meldung zeigt Code und Hinweis getrennt.

## Nicht umgesetzt, nicht geprüft

- Die Vorabprüfung (E9).
- **SQLite nennt nicht immer das Wort, das falsch ist:** `SELECT 'x' FORM t` scheitert für SQLite an `t` (es liest
  `FORM` als Alias) – markiert wird, was die Datenbank nennt.
- **SQL Server** nennt für manche Fehler die Zeile des Anweisungsanfangs, nicht die der Stelle; steht der Name aus
  der Meldung im Text, wird er gesucht, sonst die Zeile markiert.
- Ende-zu-Ende lief nur mit einer nachgestellten PostgreSQL-Antwort im Browser; die Kette Treiber → Fenster ist für
  die anderen Datenbanken in zwei Hälften geprüft (Server → Details, Details → Stelle), nicht am Stück.
- Der Fortschritt eines Skripts am Rand ist die Markierung der laufenden Anweisung; erledigte Anweisungen behalten
  kein Zeichen am Rand.
- Der Sprung an die Stelle verschiebt die Ansicht des Editors auch waagerecht (im Bild fehlten die ersten zwei
  Spalten) – Verhalten von `goTo` in editlicious.
- Das native Fenster wurde nicht bedient.
