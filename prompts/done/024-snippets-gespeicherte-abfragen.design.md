# Design 024: Gespeicherte Abfragen und Snippets

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/snippets-gespeicherte-abfragen` · Auftrag:
> [024-snippets-gespeicherte-abfragen.md](024-snippets-gespeicherte-abfragen.md) · Feature C7

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Ablage | Einzelne `.sql`-Dateien in einem Ordner mit Unterordnern (`src-tauri/src/saved.rs`, rein). Vorgabe `<App-Daten>/queries`, wählbar über den Ordner-Dialog (`savedQueriesDir`); ist der gewählte Ordner weg, gilt wieder die Vorgabe (mit Meldung). Keine Datenbank, kein Index: jeder Aufruf liest den Ordner, wie er ist | mit Git teilbar, außerhalb bearbeitbar |
| E2 | **Kopfkommentar** (Entscheidungsfrage) | Der erste Block aus Zeilen `-- schlüssel: wert` mit bekanntem Schlüssel: `name`, `description`, `tags` (Kommas), `connection`, `dialect`; dann eine Leerzeile, dann der Text. Jede andere Zeile – auch ein anderer Kommentar – beendet den Kopf und ist Text. Groß/klein und Leerzeichen egal; Werte werden beim Lesen gekürzt und geprüft (`connection` nur als Id). Ohne Kopf heißt die Abfrage wie die Datei. Zeilenenden und Kodierung der Datei bleiben | lesbar, von Hand zu schreiben, nichts geht kaputt, wenn man sich vertippt; gültiges SQL in jedem Werkzeug |
| E3 | Adressierung | Eine Abfrage ist ihr Pfad unter dem Ordner (`berichte/umsatz.sql`). Das Backend prüft jeden: keine `..`, kein Laufwerk, keine versteckten Namen, höchstens 8 Ebenen, nur `.sql`, und die Datei muss wirklich im Ordner liegen (kein Link führt hinaus). Der Ordner selbst kommt nur aus dem Ordner-Dialog | schmale Commands |
| E4 | **Tabs als Datei** (Entscheidungsfrage) | **Eine Mechanik:** Eine gespeicherte Abfrage zu öffnen heißt, ihre Datei als Datei-Tab zu öffnen (Prompt 004) – mit Kopf, den man dort von Hand ändern kann; `Strg+S` schreibt die Datei. „Als Abfrage speichern“ legt eine neue Datei an und lässt den Tab, wie er ist. „Einfügen“ und „Ausführen“ nehmen den Text ohne Kopf | kein zweiter Speicherweg, keine Abgleichsfragen |
| E5 | Änderungen von außen | **Abfragen statt Überwachen:** `saved_stamp` bildet ohne eine Datei zu lesen einen Fingerabdruck aus Namen, Zeiten, Größen; das Fenster fragt alle 3 s danach, solange die Ansicht zu sehen ist (und beim Öffnen von `q:`), und liest nur bei Abweichung neu. `notify` (in den Schwesterprojekten im Einsatz) verworfen: eine Abhängigkeit und ein Ereigniskanal mehr für etwas, das bei ein paar tausend Dateien unmessbar wenig kostet und auf Netzlaufwerken ohnehin nicht verlässlich meldet | |
| E6 | Löschen | in den Papierkorb des Systems: crate `trash` (wie files-and-folders-tauri), nach Rückfrage | Auftrag; neue Abhängigkeit, Architektur A42 |
| E7 | Ansicht | dritte Ansicht der Seitenleiste „Abfragen“ (`Mod+K Mod+Q`): Baum nach APG (ein Tab-Stopp, Pfeile, rechts/links öffnen und schließen), Suche über Name, Schlagworte, Ordner und Text (im Backend), Vorschau der Abfrage unter dem Cursor. `Enter` öffnen, `Alt+Enter` einfügen, `Strg/Cmd+Enter` öffnen und ausführen, `F2` Eigenschaften (umbenennen, verschieben, beschreiben), `Entf` löschen | |
| E8 | Speichern | `SAVE_QUERY` (`Mod+Alt+S`): die Auswahl, sonst der ganze Text; im Verlauf-Dialog „Als Abfrage speichern …“. Dialog: Name (Vorschlag aus der ersten Zeile), Ordner (mit Vorschlägen; neue werden angelegt), Beschreibung, Schlagworte, „gehört zur Verbindung …“ (dann öffnet sie auf dieser) | |
| E9 | Erreichbar | `q:` in „Springen zu allem“ (ohne Text: zuletzt benutzte zuerst), `GOTO_SAVED` (`Mod+Alt+O`) öffnet die Palette damit; dieselben Tasten wie in der Ansicht | Aufgabe 5 |
| E10 | Snippets | Eigene als Einstellung (`snippets`, höchstens 300), ein mitgelieferter Satz je Dialekt (19 Bausteine; `sell`/`selt`, `exp`, `tx` unterscheiden sich). Eigene mit gleichem Kürzel ersetzen mitgelieferte. Sie gehen als `el.snippets` an den Editor (E5): Vorschlagsliste und `Tab` hinter dem Kürzel. Editor dafür: `OPEN_SNIPPETS` | |
| E11 | Variablen | `$TABLE` und `$SCHEMA` (was im Schema-Baum unter dem Cursor steht, gequotet vom Backend) setzt das Fenster ein, bevor der Editor den Baustein sieht – als Vorgabe des Platzhalters; `$SELECTION`, `$DATE` … kennt der Editor selbst | siehe „Nicht umgesetzt“ zur Zwischenablage |

## Verträge

`saved_use_folder(path?) → Listing`, `saved_list() → Listing`, `saved_stamp() → String`, `saved_read(id) → Saved`,
`saved_save(id?, folder, meta, text) → id`, `saved_rename(id, folder, name) → id`, `saved_create_folder(folder)`,
`saved_delete(id)`, `saved_search(query) → ids`. Fassade `core/saved/saved-api.ts`. Grenzen: 5000 Dateien, 4 MB je
Abfrage, Kopf in den ersten 8 KB.

## Geprüft

- **Rust** (8 Tests): Kopf schreiben/lesen (Unicode, CRLF), von Hand bearbeitete und defekte Köpfe, Dateinamen aus
  Namen, Konflikte (`Name 2.sql`), Suche, Änderungen von außen (anlegen, ändern, löschen, andere Kodierung, versteckte
  Ordner), umbenennen/verschieben, Pfade, die hinausführen (auch über einen Link), anderer Ordner.
- **Frontend**: Zeilen des Baums, Formular, Snippet-Variablen und -Satz (rein); Store (speichern, ändern, Ordner weg,
  beobachten nur solange jemand zusieht, öffnen als Datei-Tab, löschen); Ansicht (Baum, Tasten, Suche, Rückfrage);
  `q:` in der Palette. `pnpm check` grün.
- **Im Browser im echten Editor** (Backend nachgestellt): `selw` + `Tab`, drei Platzhalter nur mit `Tab` und Tippen
  → `SELECT id, name / FROM kunden / WHERE ort = 'Köln';`. Abfrage mit Emoji im Namen in einen neuen Unterordner
  gespeichert, in der Ansicht mit Vorschau gesehen, eine „von außen“ angelegte Datei erscheint von selbst, Doppelklick
  öffnet die Datei als Tab. Dunkel und hell.

## Nicht umgesetzt, nicht geprüft

- **Das native Fenster** wurde nicht bedient: „speichern, App neu starten, finden, ausführen“ ist durch die Tests
  von `saved.rs` (die Dateien sind der Zustand) und des Stores gedeckt, nicht Ende-zu-Ende gesehen; ebenso der
  Papierkorb (`trash::delete` ist ein Aufruf der Bibliothek, ohne eigenen Test) und der Ordner-Dialog.
- **Variable Zwischenablage**: Der Editor expandiert ein Kürzel selbst und fragt die Seite dabei nicht. Vorschlag für
  editlicious: Variablen der Seite als Funktion (`snippetVars: (name) => string | Promise<string>`), dann auch
  `$CLIPBOARD`.
- **Import** von Snippets aus VS Code (im Auftrag „optional“). SQL-Dateien eines Ordners übernimmt man, indem man
  den Ordner wählt.
- Ordner umbenennen oder löschen, Ziehen mit der Maus, mehrere Abfragen auf einmal: in der Ansicht nicht – im
  Dateimanager, die Ansicht folgt.
- `$TABLE` ist der Stand des Baums in dem Moment, in dem die Bausteine gesetzt werden (bei jeder Bewegung im Baum
  neu) – nicht die Tabelle unter dem Cursor des Editors.
- Windows und Linux: nicht gesehen.

## Fortschritt

- [x] Rust · [x] Frontend · [x] Browser-Durchlauf · [x] Doku · [x] `pnpm check`
