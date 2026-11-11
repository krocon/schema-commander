# Design 010: Abfrage-Verlauf

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/verlauf` · Auftrag: [010-verlauf.md](010-verlauf.md) · Feature C6

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Speicher | `history.sqlite` im Datenordner der App (`history.rs`, rein, `rusqlite`), eine Tabelle `entry` mit Index auf Zeit und Verbindung; geöffnet erst beim ersten Gebrauch | Auftrag; keine neue Abhängigkeit |
| E2 | Volltextsuche | **`LIKE`** je Wort (alle Wörter müssen vorkommen, Groß/Klein egal, `%` und `_` sind Text), kein FTS5 | gemessen: 100 000 Einträge öffnen und durchsuchen in unter 1,5 s im Debug-Test; FTS5 verdoppelt den Text in der Datei und erschwert das endgültige Löschen |
| E3 | Wiederholungen | dieselbe Anweisung (FNV-1a-Hash des Textes) auf derselben Verbindung mit demselben Ausgang **direkt nacheinander** zählt hoch (`count`), statt ein neuer Eintrag zu werden | F5-Schleifen füllen den Verlauf nicht |
| E4 | Lange Anweisungen | gespeichert werden die ersten 100 000 Zeichen; die Länge und der Hash des ganzen Textes bleiben | Lade-Skripte von vielen MB gehören nicht in den Verlauf |
| E5 | Aufbewahrung | Einstellungen `historyMaxEntries` (100 000) und `historyMaxDays` (365, 0 = egal); aufgeräumt wird bei jedem 200. Eintrag | ein Scan je Anweisung wäre zu viel |
| E6 | Datenschutz | `historyEnabled` und `historyOff` (Verbindungen ohne Verlauf): was nicht gemerkt werden soll, wird **nie an Rust geschickt**. Gespeichert werden nie Ergebnisse oder Parameterwerte. Löschen: ein Eintrag, eine Verbindung, alles – `secure_delete = ON` überschreibt die Seiten, nach mehr als einem Eintrag zusätzlich `VACUUM` (Test liest die Datei und sucht den Text) | Auftrag. `docs/best-practices.md` §6 nennt den Verlauf jetzt als einzige dauerhafte Stelle für Anweisungstexte |
| E7 | Anweisungen der App | werden gemerkt, als `origin = app` („Daten öffnen“); der Filter „nur eigene“ blendet sie aus, das Zurückblättern im Editor übergeht sie | Empfehlung des Auftrags |
| E8 | Ansicht | Dialog (`Mod+Shift+H`): Suche (200 ms nach dem letzten Tastendruck), Verbindung, „nur Fehler“, „nur eigene“; Liste als **Listbox nach APG** (200 Einträge je Seite, „Weitere laden“), darunter der ganze Text im Nur-Lesen-Editor und die Fehlermeldung | statt GuiExpert Table: fünf feste Spalten, eine Auswahl – eine Liste ist das passende Widget und für Screenreader das richtige |
| E9 | Aktionen | Einfügen (Enter, Doppelklick), in neuem Tab (mit der Verbindung des Eintrags, wenn es sie noch gibt), erneut ausführen, kopieren, Eintrag löschen (Entf), Verlauf löschen (der gefilterten Verbindung oder alles, mit Rückfrage); `TOGGLE_HISTORY`, `TOGGLE_HISTORY_CONNECTION` | – |
| E10 | Im Editor blättern | `Mod+Alt+↑/↓` holt die vorige/nächste eigene Anweisung der Verbindung des Tabs – **nur in einen leeren Editor** oder über den zuletzt geholten Text. Getippter Text wird nie ersetzt; dann sagt eine Meldung, dass der Dialog einfügt | der Editor fragt nie „Speichern?“, also darf nichts still überschrieben werden |
| E11 | Defekte Datei | wird beiseitegelegt (`history.broken-<Zeit>`), eine neue begonnen, die Ansicht sagt es einmal | wie Profile und Farbschemata |

## Geprüft

- Rust: Schreiben/Lesen über einen Neustart, Zusammenfassen, Kürzen, Suche und Filter, Aufbewahrung, Löschen (der
  Text ist nicht mehr in der Datei), defekte Datei, 100 000 Einträge.
- Frontend: Aufzeichnen aus dem Tab (Ausgang, Fehlermeldung, Herkunft), Abschalten, Blättern mit Fake.
- Im Browser mit nachgebildetem Backend: 451 Einträge, Suche mit zwei Wörtern, Pfeiltasten, Vorschau im
  Nur-Lesen-Editor, Enter fügt ein, `HISTORY_PREV/NEXT` im leeren Tab.

## Nicht umgesetzt, nicht geprüft

- **Zeitraum** als Filter in der Oberfläche (Rust kann `from`/`to`); „als gespeicherte Abfrage ablegen“ (Prompt 024).
- Eine Oberfläche für Aufbewahrung und Abschalten gibt es nur als Aktionen (Einstellungen: Prompt 017).
- Datenbank/Schema zum Zeitpunkt: gemerkt wird die Datenbank des Profils, nicht ein späteres `USE`.
- Das native Fenster wurde nicht von Hand geprüft; die echte Datei entsteht erst dort.
