# Design 031: Daten bearbeiten mit Änderungsvorschau

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/daten-bearbeiten` · Auftrag: [031-daten-bearbeiten.md](031-daten-bearbeiten.md) · Feature E1

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | **Abfrage-Ergebnisse bearbeitbar?** (Entscheidungsfrage) | **Zunächst nur Tabellen-Ansichten** (027). Dort ist die Tabelle jeder Spalte sicher. Die Herkunft der Spalten eines beliebigen Ergebnisses liefern die Treiber nicht einheitlich (wie in 030) – und ein `UPDATE` auf geratener Herkunft ist kein Risiko, das man eingeht | Datenverlust vermeiden |
| E2 | **Tabellen ohne Schlüssel?** (Entscheidungsfrage) | **Gar nicht.** Bearbeitbar ist, was einen **Primärschlüssel** hat, dessen Spalten alle im Ergebnis stehen. Sonst nur lesen, mit einem Satz, warum (kein Schlüssel / Schlüssel nicht gezeigt / Verbindung liest nur / lokale Sortierung aktiv). Eindeutige Nicht-NULL-Schlüssel als Ersatz: nicht umgesetzt | „alle Spalten im WHERE“ trifft bei Duplikaten mehrere Zeilen |
| E3 | **Optimistische Sperre als Vorgabe?** (Entscheidungsfrage) | **Ja** (Einstellung `editLock`, an). Im `WHERE` stehen neben dem Schlüssel die **alten Werte der geänderten Zellen** (`NULL` als `IS NULL`). Nicht verglichen wird, wo Gleichheit kein Test ist: **Gleitkomma**, Binärdaten, Texte ab 1000 Zeichen (die Zeile hat sie gekürzt). Zeitstempel und Dezimalzahlen gehen als der Text zurück, den die Datenbank geliefert hat (PostgreSQL mit Cast auf den Spaltentyp) | Akzeptanzkriterium 2; Frage zu Gleitkomma/Zeitstempel |
| E4 | Wer baut das SQL? | **Das Backend** (`db/edit.rs`): je Zeile ein `UPDATE … SET … WHERE schlüssel [AND alt]`, Namen über `meta::quote`, jeder Wert gebunden – mit demselben Baustein wie die Tabellen-Ansicht. Das Fenster sendet einen **Plan** (Zellen und Werte), nie SQL; `edit_apply` baut die Anweisungen aus dem Plan neu | Akzeptanzkriterium 3 |
| E5 | Schreiben | `ConnectionManager::apply_updates`: erst jede Anweisung durch den Schutz der Verbindung (`admit`), dann auf der Sitzung des Tabs `BEGIN`, die Anweisungen, `COMMIT`. **Jede muss genau eine Zeile ändern** – keine oder mehrere heißt Konflikt → `ROLLBACK`. Fehler der Datenbank → `ROLLBACK`. Ist auf dem Tab schon eine Transaktion offen (manueller Modus), wird nichts geschrieben: erst Commit oder Rollback | Akzeptanzkriterium 1 „alles oder nichts“ |
| E6 | Danach | Puffer leeren, Tabelle **neu lesen** (Trigger, Defaults). Bei Konflikt oder Fehler bleibt der Puffer, die Zeile ist markiert, der Cursor steht dort, die Statuszeile sagt, was war | Aufgabe 5 |
| E7 | Änderungspuffer | rein (`edit-buffer.ts`), je Tab: Zeile = Werte ihres Schlüssels, dazu die Zeile, wie sie gelesen wurde. Ein Wert, den die Zelle ohnehin hat, ist keine Änderung. Undo/Redo je Zelle (500 Schritte), Zelle/Zeile zurücksetzen, alles verwerfen | Aufgabe 3; Akzeptanzkriterium 4 |
| E8 | Editoren | Eine **Bearbeitungszeile** über dem Ergebnis statt eines Editors in der Zelle: Feld (mehrzeilig, wenn der Wert Zeilen hat), „NULL“, „Default“, OK. `F2` oder Doppelklick öffnet, `Enter` übernimmt, `Esc` lässt die Zelle. Geprüft wird vor dem Übernehmen: ganze Zahl, Zahl, Bool, Datum, JSON (bei `json`/`jsonb`), Länge (`varchar(n)`), NOT NULL – am Feld gemeldet. Lange Texte werden zum Bearbeiten ganz gelesen (bis 1 MB) | Aufgabe 2; ohne Eingriff in die Tabelle, vollständig per Tastatur |
| E9 | Anzeige | geänderte Zellen in `--cell-changed-bg/-text` mit dem neuen Wert (`NULL`/`DEFAULT` kursiv); neue Tokens auch für „neu“ und „gelöscht“ (für 032), alle mit Kontrastpaaren. Darüber: „3 Änderungen in 3 Zeilen, nicht geschrieben“ mit Vorschau, Schreiben, Rückgängig, Wiederholen, Verwerfen | Aufgabe 3 |
| E10 | Vorschau | Dialog mit den `UPDATE`-Anweisungen in lesbarer Form, dem Satz „gesendet wird gebunden“ und ob die Sperre gilt; von dort „Schreiben“ | Aufgabe 4 |
| E11 | `Mod+S` | `SAVE_FILE` schreibt die Änderungen, wenn der Tab welche hat (sonst wie bisher die Datei). Dazu `EDIT_SAVE` ohne eigenes Kürzel – ein Kürzel gehört in der Belegung genau einer Aktion | Auftrag „`Mod+S`“ |
| E12 | Schutz (012) | „nur lesen“ → nicht bearbeitbar (und das Backend lehnt ohnehin ab). „Nachfragen“ → vor dem Schreiben die bekannte Rückfrage mit den lesbaren Anweisungen; die Bestätigungen gehen je Anweisung mit | Aufgabe 6 |
| E13 | **Offene Änderungen und Neu-Lesen** (festzulegen) | Alles, was Zeilen neu liest (Filter, Sortieren auf dem Server, Grenze, Ausführen, Fremdschlüssel folgen, Zurück/Vor), läuft über `QueryTab.runAll` und **fragt vorher**, ob die Änderungen verworfen werden dürfen. Lokales Sortieren/Filtern ist während offener Änderungen egal für den Puffer, macht aber das Bearbeiten aus (Zeilen sind dort umgestellt). Tab und Fenster schließen fragen ebenso | Aufgabe 6 |

## Verträge

`edit_preview(id, plan) → Built[]`; `edit_apply(id, session, plan, confirmations?, timeout_ms?) → { done, failed,
conflict, error, tx }`. `UpdatePlan { schema, table, rows: [{ key, set, expect }] }`.

## Geprüft

- **Rust, Erzeuger** (5 Tests): Form je Dialekt mit Sperre, `NULL`, `DEFAULT`; zusammengesetzter Schlüssel;
  **böse Werte** (8 Werte × 3 Arten × 4 Datenbanken, als neuer Wert, als Schlüssel und in der Sperre: nichts vom
  Wert in der Anweisung); Namen gequotet, Typname, der keiner ist; was kein Plan ist (leer, Schlüssel `NULL`, Zelle
  doppelt, zu viel).
- **Rust, Schreiben** (SQLite über den Manager): zwei Zeilen geschrieben und für andere sichtbar; zweite Zeile
  inzwischen geändert → **nichts** geschrieben, auch die erste nicht; Anweisung, die zwei Zeilen träfe → Konflikt;
  Fehler der Datenbank → Rollback; offene Transaktion des Tabs → abgelehnt; „nur lesen“ → abgelehnt; „nachfragen“ →
  ohne oder mit nur einem Teil der Bestätigungen nichts, mit allen geschrieben.
- **Gegen echte Server** (PostgreSQL, MySQL, MariaDB, SQL Server): mehrere Zellen mit Sperre (eine alte `NULL`)
  → eine Zeile; dieselbe Sperre noch einmal → keine Zeile; `NULL` und `DEFAULT`; Zeile, die es nicht gibt → keine;
  **derselbe Wert noch einmal** → trotzdem eine Zeile (auch MySQL); Text mit `'`, `\`, `"`, Umlaut, Emoji und
  `; DROP TABLE` steht danach genau so in der Zelle; ein Trigger je Server lief je geschriebener Zeile einmal und
  verfälscht die gemeldete Zeilenzahl nicht (SQL Server: Trigger, der selbst Zeilen ändert).
- **Fenster**: Puffer rein (11 Tests); Dienst mit Fakes (6 Tests: bearbeitbar/Grund, Zelle öffnen, prüfen,
  sammeln, Undo; schreiben mit Plan, Sperre und Neu-Lesen ohne Rückfrage; Konflikt und Fehler mit markierter
  Zeile; Schutz mit Rückfrage und Bestätigungen; Vorschau; Rückfrage vor Verlust beim Neu-Lesen und Schließen).
- **Im Browser** mit nachgebildetem Backend: `F2` → Feld mit dem Wert, zu langer Wert am Feld gemeldet, gültiger
  übernommen (Zelle farbig, „1 Änderung …“), „NULL“ per Aktion, Doppelklick, Vorschau (`Mod+K Mod+P`) mit drei
  Anweisungen und Fokus auf „Schreiben“, geschrieben → Plan mit alten Werten an der Brücke, Tabelle neu gelesen;
  Konflikt → Puffer bleibt, Meldung.
- **Review durch einen zweiten Agenten**: siehe unten.
- `pnpm check` grün.

## Nicht umgesetzt, nicht geprüft

- **Zell-Editoren je Typ** nur als Feld mit Prüfung: keine Auswahl für `ENUM` oder kleine Fremdschlüssel-Tabellen,
  kein Datums-Wähler, kein JSON-Editor; mehrzeiliger Text im Feld, nicht über die Wert-Ansicht.
- Abfrage-Ergebnisse und Tabellen ohne Primärschlüssel sind nur lesbar (E1, E2).
- Der Primärschlüssel selbst lässt sich ändern wie jede Zelle; die Zeile wird über ihren alten Schlüssel gefunden.
- Was geschrieben wurde, steht nicht im Verlauf (dort stünden die Werte).
- Zwanzig Zellen in fünf Zeilen im echten Fenster gegen eine echte Datenbank: nicht durchgespielt – die Teile
  sind einzeln geprüft (Erzeuger und Zeilenzahl je Server, Transaktion im Manager, Ablauf im Browser mit
  Attrappe). Das native Fenster (`pnpm tauri dev`) wurde wie bisher nicht bedient.
