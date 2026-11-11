# Design 023: SQL formatieren

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/sql-formatieren` · Auftrag: [023-sql-formatieren.md](023-sql-formatieren.md) · Feature C5

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Welcher Formatierer? | **Eigener, in Rust** (`src-tauri/src/format.rs`, rein, ohne Abhängigkeit). Verworfen: crate `sqlformat` (drei Dialekte, kein `DELIMITER`/`GO`, keine Zusage zur Bedeutung), npm `sql-formatter` (läuft im Fenster: für 20 MB bräuchte es einen eigenen Worker; baut bei Syntaxfehlern um oder scheitert), der Tokenizer aus 021 (für Tippen gebaut: `1e-5` sind dort drei Tokens) | Die Zusage „ändert nie die Bedeutung“ lässt sich nur geben, wenn der Formatierer nichts als Leerraum anfasst und das selbst prüft; große Skripte gehören nach den Architekturregeln in einen Job im Backend |
| E2 | Wie formatiert er? | Kein Syntaxbaum, der zurückgeschrieben wird. Der Text wird in Tokens zerlegt; entschieden wird **nur**, was zwischen zwei Tokens steht (nichts, Leerzeichen, Zeilenumbruch mit Einrückung) und – wenn gewünscht – die Schreibung eines Schlüsselworts. Strings, Kommentare, Namen in Anführungszeichen, Dollar-Quoting und Hinweise sind Tokens und bleiben, wie sie sind | fehlertolerant von selbst: kaputtes SQL hat trotzdem Tokens |
| E3 | Sicherheit | Jeder Aufruf zerlegt sein Ergebnis noch einmal und vergleicht Token für Token mit dem Text (`same_tokens`; nur Schlüsselwörter dürfen sich in Groß/Klein unterscheiden). Weicht etwas ab: Fehler `format_unsafe`, der Text bleibt. Text, der in einem String, Namen oder Kommentar endet, wird abgelehnt (`format_incomplete`): dort wäre Leerraum ein Wert. Tiefer als 200 Ebenen: `format_too_deep` | Akzeptanzkriterium „im Zweifel unverändert lassen und melden“ – als Eigenschaft des Codes, nicht nur des Tests |
| E4 | Leerraum, der etwas bedeutet | bleibt: Exponent (`1e-5` ist ein Token), `a - -1`, zusammengeschriebene Operatoren (`<->`, `!!`), `N'…'`/`E'…'`/`_utf8'…'`/`U&'…'`, `'u'@'h'`, zwei Strings mit Zeilenumbruch dazwischen (PostgreSQL verkettet nur so), Leerzeichen vor `(` hinter einem Namen (MySQL unterscheidet Funktionen daran), `.`/`:`/`?`/`%`/`[` behalten ihre Nachbarschaft. Zeilen des Clients (`GO`, `DELIMITER`) bleiben eigene Zeilen; ein Wort `go`, das durch das Layout allein auf einer Zeile stünde, fängt E3 ab | jeder dieser Fälle ist ein Test |
| E5 | Layout | Jede Klausel beginnt eine Zeile; `JOIN` eine Ebene tiefer. Eine Liste (`SELECT a, b`) oder Bedingung (`a AND b`) bleibt in ihrer Zeile, solange sie in die **Zeilenbreite** passt, sonst ein Eintrag je Zeile. Klammern, `CASE … END`, `BEGIN … END` (und in MySQL `IF`/`WHILE`/`LOOP`/`REPEAT`) sind Gruppen: passt eine, bleibt sie in der Zeile, sonst wird sie geöffnet, eingerückt und auf eigener Zeile geschlossen. Listen aus einzelnen Werten (`IN (1, 2, …)`) werden gefüllt statt gestapelt. Alle Entscheidungen hängen nur an den Tokens, nie am Leerraum des Textes → zweimal formatieren = einmal formatieren | Vorbild DataGrip („wrap if long“), mit sechs statt hundert Einstellungen |
| E6 | Schlüsselwörter | Eine Liste von rund 130 Wörtern; ein Wort ist nur Schlüsselwort, wo es eines sein kann: nicht neben einem Punkt (`t.order`), nicht als Name hinter `FROM`, `JOIN`, `INTO`, `UPDATE`, `TABLE`, `AS` … (`FROM user`, `AS key`), `left(`/`right(` sind Funktionen, `KEY` nur hinter `PRIMARY`/`FOREIGN`/`UNIQUE`. Funktions- und Typnamen bleiben, wie sie sind | Tabellennamen sind in MySQL unter Linux groß/klein-empfindlich; siehe „Nicht umgesetzt“ |
| E7 | Dialekte | **gleich**: Klauseln, Listen, Gruppen. **PostgreSQL**: Dollar-Quoting, `E'…'`, `U&'…'`, verschachtelte Kommentare, `::`, JSON-/Array-Operatoren, `$1`. **MySQL**: Backticks, `"` als String, Backslash, `#`-Kommentare, `DELIMITER`, `@var`, Kontrollfluss in Rümpfen. **SQL Server**: `[Namen]`, `GO`, `@var`/`#temp`, `BEGIN TRY`, Anweisungen ohne `;` (jede beginnt eine Zeile), verschachtelte Kommentare. **SQLite**: alle drei Arten von Namen, Trigger mit `BEGIN … END`. Rümpfe in Dollar-Quotes (PL/pgSQL) sind Strings und bleiben unformatiert | |
| E8 | Vertrag | Command `format_sql(job_id, sql, dialect, mode, style, crlf) → String`; `mode`: `format`, `oneline`, `upper`, `lower`; `style`: `keywordCase` (`upper`/`lower`/`preserve`), `indent` 1–8, `comma` und `andOr` (`leading`/`trailing`), `width` 40–400, `blankLines` 0–3. Ein Job wie der Export: `cancel_job(job_id)` bricht ab (Ids ab 1 000 000 000, die Exporte zählen ab 1). Fehlercodes `cancelled`, `format_incomplete`, `format_too_deep`, `format_unsafe`, `too_large` (über 256 MB). Fassade `core/format/format-api.ts`, Vertragstest auf beiden Seiten | |
| E9 | Was wird formatiert, was ersetzt? | Auswahl (ohne die Leerzeichen an ihren Rändern), sonst die Anweisung unter dem Cursor, oder das ganze Skript. Ersetzt wird immer nur dieser Bereich mit `replaceRange` – **ein** Undo-Schritt. Zum **Finden** der Anweisung wird der ganze Text gelesen (**Abweichung von Aufgabe 5**): Wo eine Anweisung beginnt, sagt nur der ganze Text – ein Ausschnitt, der in einem mehrzeiligen String beginnt, würde Code und String vertauschen, und gerade das dürfte der Formatierer nie tun. Geschrieben wird der ganze Text nie | Sicherheit vor Ersparnis; „Ausführen“ liest genauso |
| E10 | Cursor | steht nach dem Formatieren hinter denselben Zeichen wie vorher (gezählt ohne Leerraum, `mapOffset`); vor einem Wort bleibt er vor dem Wort | „bleibt sinnvoll stehen“ |
| E11 | Veraltete Antwort | Der Editor merkt sich die Revision des Textes; wurde er während des Formatierens bearbeitet, wird das Ergebnis verworfen und gemeldet. Ein Formatieren zur Zeit; ab 200 000 Zeichen zeigt die Statuszeile „Formatiere …“ mit „Abbrechen“ | Architekturregel „veraltete Antworten verwerfen“ |
| E12 | Aktionen und Kürzel | `FORMAT_SQL` (`Mod+Shift+F`), `FORMAT_SCRIPT` (`Mod+K Mod+F`), `TOGGLE_COMMENT` (`Mod+/`), `SQL_ONE_LINE`, `KEYWORDS_UPPER`, `KEYWORDS_LOWER`, `CANCEL_FORMAT` (ohne Kürzel). Menü „Bearbeiten“, die selteneren im Untermenü „Weitere Formatierung“ | |
| E13 | Zeilenkommentar | im Fenster (`toggleComment`, rein): der Editor hat keine solche Aktion. `-- ` an der Einrückung der am wenigsten eingerückten Zeile; sind alle Zeilen mit Text schon Kommentare, wird auskommentiert (MySQL: auch `#`) | Vorschlag für editlicious, siehe unten |
| E14 | Einstellungen | sechs Werte in einer neuen Gruppe „Formatierung“, darunter eine **Vorschau**: ein fester Beispieltext, bei jeder Änderung neu vom Backend formatiert. Einrückung nur mit Leerzeichen | Tabs zum Einrücken: nicht verlangt |

## Bausteine

| Baustein | wofür | passt / fehlt |
|---|---|---|
| editlicious `getSelection`, `getValue`, `getSlice`, `replaceRange`, `goTo` (E2) | lesen, ersetzen, Cursor setzen | passt |
| editlicious: Zeilenkommentar umschalten | Aufgabe 4 | fehlt → hier als reine Funktion; Vorschlag unten |
| `sql-split.ts` `statementAt` | Anweisung unter dem Cursor | passt |
| `Jobs` + `cancel_job` (011) | Abbruch | passt |
| Einstellungsdialog (017), Aktionen (002), Menümodell (018) | Stil, Kürzel, Menü | passt, erweitert |

## Geprüft

- **Rust** (`format_tests.rs`, 16 Tests): Katalog mit 23 Texten (CTEs, Fensterfunktionen, `CASE`, Unterabfragen,
  `MERGE`, Prozedurrümpfe in MySQL und T-SQL, Trigger in SQLite, DDL, kaputtes SQL) × 4 Dialekte × 4 Stile ×
  4 Modi: jedes Ergebnis hat die Tokens des Textes und ist stabil. Dazu Vorher/Nachher-Fälle, bedeutsamer
  Leerraum, Namen wie Schlüsselwörter, abgelehnte Texte, `GO`/`DELIMITER`, CRLF, Abbruch, 5000 Klammern tief,
  20 000 Anweisungen (2 MB) im Debug-Build in rund einer Sekunde.
- **Frontend**: `format-logic.spec.ts` (Stellen in Codepunkten mit Emoji und CRLF, Cursor-Abbildung,
  Zeilenkommentar), `format.service.spec.ts` (Stil, ein Job zur Zeit, Abbruch, Meldungen), Dialog mit Vorschau,
  Grenzen der Einstellungen. `pnpm check` grün.
- **Im Browser im echten Editor** (Backend nachgestellt; die Antworten für die Testtexte sind die des echten
  Formatierers): Anweisung unter dem Cursor mit `Cmd+Shift+F`, auch wenn sie mitten in einer Zeile hinter Emoji
  beginnt – ersetzt wird genau sie; **`Cmd+Z` stellt den alten Text Zeichen für Zeichen wieder her** (ein
  Schritt); ganzes Skript; Schlüsselwörter groß; Kommentar an und aus; abgelehnter Text bleibt, die Meldung
  nennt den Grund; während des Formatierens bearbeiteter Text bleibt, das Ergebnis wird verworfen; langer Text:
  „Formatiere …“ und „Abbrechen“ in der Statuszeile, danach unverändert. Vorschau im Dialog, dunkel und hell.

## Nicht umgesetzt, nicht geprüft

- **Das native Fenster** (`pnpm tauri dev`) wurde nicht bedient: die Kette Fenster → `format_sql` → Fenster ist
  durch den Vertragstest und die Tests beider Seiten gedeckt, nicht Ende-zu-Ende gesehen. **20 MB** wurden nicht
  gemessen (2 MB im Debug-Build ≈ 1 s; die Arbeit läuft als Job neben dem Fenster und ist abbrechbar).
- **Schlüsselwörter groß/klein kann Namen treffen**, die wie Schlüsselwörter heißen und nicht hinter `FROM`,
  `JOIN`, `AS` … stehen (eine Spalte `order` ohne Anführungszeichen gibt es nicht, eine Spalte `window` schon).
  Für PostgreSQL, MySQL (Spalten) und SQLite ist das ohne Wirkung; auf einem **SQL Server mit
  groß/klein-empfindlicher Sortierung** wäre es ein anderer Name. Wer das hat, stellt „Wie geschrieben“ ein.
- Rümpfe in Dollar-Quotes (PL/pgSQL) und der Text hinter `AS '…'` werden nicht formatiert (es sind Strings).
- Lange Ausdrücke ohne Klammern, Kommas, `AND`/`OR` werden nicht umbrochen: Die Zeilenbreite entscheidet, wo
  Listen und Gruppen brechen, sie ist keine harte Grenze.
- Kontrollfluss wird nur in MySQL eingerückt (`IF … END IF`); T-SQL über `BEGIN … END`.
- Einrücken mit Tabs; Ausrichten von Aliasen; eigene Stile je Verbindung.
- Windows und Linux: nicht gesehen (die Kürzel stehen in allen drei Keymaps).

## Gefunden

- **editlicious zählt Spalten in Codepunkten** (so steht es in `editlicious-editor.d.ts`; im Browser bestätigt:
  `getRange({1,1},{1,3})` von `a😀b` ist `a😀`). `offsetOf`/`positionOf` in `sql-split.ts` und
  `error-position.ts` (022, dort steht „UTF-16“) rechnen in UTF-16-Einheiten: hinter einem Emoji **in derselben
  Zeile** lagen Fehlermarkierung und „Anweisung unter dem Cursor“ um eine Spalte je Emoji daneben.
  **Behoben am 11.11.2026** (Branch `fix/spalten-codepunkte`): `placeIn`/`offsetAt` liegen jetzt in
  `core/text/places.ts`, `offsetOf`, `positionOf` und `placeOf` rechnen damit; rote Tests zuerst, im Browser
  im echten Editor bestätigt.
- **Nachtrag 11.11.2026:** beide Vorschläge sind mit `editlicious-editor` **1.3.0** umgesetzt (editlicious
  Prompt 031). Das `goTo(zeile, 1)` ist entfallen, `TOGGLE_COMMENT` ruft `runAction('edit.toggleComment')`
  (MySQL mit `line-comment="-- #"`), die eigene Funktion `toggleComment` ist gelöscht. Im Browser geprüft.
- **Vorschläge für editlicious**: (1) Nach einem `replaceRange`, das die längste Zeile kürzt, bleibt die Ansicht
  waagerecht verschoben, bis Spalte 1 gezeigt wird – hier mit `goTo(zeile, 1)` vor dem Setzen des Cursors
  ausgeglichen. (2) Eine Aktion `edit.toggleComment`, die das Kommentarzeichen der Grammatik kennt.

## Fortschritt

- [x] Rust: Formatierer, Command, Tests · [x] Frontend: Fassade, Dienst, Aktionen, Einstellungen, Vorschau
- [x] Browser-Durchlauf · [x] Doku · [x] `pnpm check`
