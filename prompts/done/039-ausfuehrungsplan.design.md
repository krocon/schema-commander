# Design 039: Ausführungsplan

> **Status:** umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/ausfuehrungsplan` · Auftrag: [039-ausfuehrungsplan.md](039-ausfuehrungsplan.md) · Feature C9

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Plan holen | je Datenbank in ihrer maschinenlesbaren Form: PostgreSQL `EXPLAIN (FORMAT JSON[, ANALYZE, BUFFERS])`; MySQL `EXPLAIN FORMAT=JSON`, mit Ausführung `EXPLAIN ANALYZE` (Textbaum); MariaDB `ANALYZE FORMAT=JSON`; SQL Server `SET SHOWPLAN_XML ON` bzw. `SET STATISTICS XML ON`; SQLite `EXPLAIN QUERY PLAN` (ohne Zeiten); CockroachDB `EXPLAIN [ANALYZE]` (Textbaum) | Aufgabe 1 |
| E2 | Modell | `PlanNode { op, object, detail, estRows, actRows, cost, timeMs, selfMs, loops, buffers, extra, hints, children }`. Zeilen und Zeiten sind **über alle Schleifen** gerechnet (PostgreSQL und MySQL nennen sie je Schleife); die Eigenzeit ist die Zeit eines Knotens ohne die seiner Kinder | Akzeptanzkriterium 1 |
| E3 | **Nachsichtig** | Die Parser sind rein und scheitern nie: Ein unbekannter Knotentyp ist ein Knoten mit seinem rohen Namen und allem, was die Datenbank über ihn sagte; ein Format, das gar nicht gelesen werden kann, ist ein Plan, der nur aus seinem Rohtext besteht (`known: false`) | Akzeptanzkriterium 3 |
| E4 | Nur eine Anweisung | Vor dem Fragen prüft `guard::is_single_statement`: Hinter einem `EXPLAIN …; DELETE …` liefe die zweite Anweisung | Sicherheit |
| E5 | **Mit Ausführung** | führt die Anweisung aus. Deshalb: (1) das Fenster sagt es und fragt; (2) die Anweisung geht durch `admit` wie jeder Lauf (Schutzstufen aus 012, Rückfrage mit Token); (3) sie läuft auf einer **eigenen Sitzung** in einer Transaktion, die **immer zurückgerollt** wird; die Sitzung wird danach geschlossen (auch ein `SET SHOWPLAN_XML` verschwindet so) | Aufgabe 2, Akzeptanzkriterium 2 |
| E6 | Ansicht | Dialog mit **Baumtabelle** (`role="treegrid"`, auf- und zuklappbar): Operation, Objekt, Zeilen geschätzt/tatsächlich, Abweichung (`×175`), eigene Zeit mit Balken, Gesamtzeit, Kosten, Seiten. Die teuersten Knoten (ab der halben längsten Eigenzeit) und große Fehlschätzungen sind hervorgehoben (`--danger`, `--accent`). Darunter Einzelheiten des gewählten Knotens und der Rohplan | Aufgabe 3; siehe „Nicht umgesetzt“ |
| E7 | Hinweise | vier Regeln, im Backend: ganze Tabelle gelesen und ≥ 90 % verworfen (ab 1000 Zeilen); Sortierung auf Platte; Schätzung um Faktor ≥ 10 daneben (ab 100 Zeilen); ≥ 1000 Schleifen. Im Fenster stehen sie unter „Einen Blick wert“ mit dem Satz „Hinweise, keine Urteile“ | Aufgabe 4 |
| E8 | SQL Server | Der Treiber hängt an jeden Stapel eine Abfrage der Zeilenzahl; `SET SHOWPLAN_XML` muss allein stehen (Fehler 1067 → der Stapel wird ohne den Zusatz wiederholt, wie schon für `CREATE VIEW`). Der Plan einer **ausgeführten** Anweisung kommt als eigene Ergebnismenge hinter ihren Zeilen: Der Treiber reicht sie weiter, behalten wird nur die Zeile mit dem Plan | sonst gäbe es dort keinen Plan mit Ausführung |
| E9 | Abhängigkeit | `quick-xml` als direkte Abhängigkeit für das Showplan-XML – es ist über Tauri (`plist`) schon im Baum | kein neues Paket |

## Verträge

`explain_plan(id, sql, analyze, confirmation, allowDangerous, timeoutMs) → Plan { nodes, raw, format, analyzed,
totalMs, known, cut }`. Fenster: `PlanApi` (`core/plan/`), `PlanService`, `PlanDialog`, `plan-logic.ts`; Aktionen
`EXPLAIN_PLAN` (`Mod+K Mod+X`) und `EXPLAIN_ANALYZE`; `QueryTab.currentStatement()`.

## Geprüft

- **Parser-Katalog mit echten Plänen** (`src-tauri/src/db/plan_cases/`, von den Test-Servern geholt): PostgreSQL 17
  (geschätzt, mit Ausführung, mit Schleifen), MySQL 8.4 (JSON, Textbaum), MariaDB 11.4 (beide JSON), SQL Server 2022
  (Showplan geschätzt und tatsächlich), CockroachDB 24.3. **Die Summe der Eigenzeiten ist die Zeit der Wurzel**
  (PostgreSQL, Schleifen mitgerechnet). Unbekanntes: kaputtes JSON/XML, ein Knotentyp und Schlüssel der Zukunft,
  ein Rohplan von Megabytes. Hinweise an einem gebauten Plan. Fragen je Datenbank; zwei Anweisungen werden
  abgelehnt. SQLite gegen die echte Bibliothek.
- **Gegen echte Server** (PostgreSQL, CockroachDB, MySQL, MariaDB, SQL Server;
  `every_server_explains_a_join_and_a_run_changes_nothing`): Plan-Baum für eine Verbund-Abfrage, geschätzt und mit
  Ausführung; **ein `UPDATE` mit Ausführung hat danach nichts geändert**, die Sitzung ist ohne Transaktion und zeigt
  wieder Ergebnisse; zwei Anweisungen laufen nicht. Ganze Treiber-Suite: 46 Tests grün.
- **Fenster**: Logik (3 Tests: Zeilen des Baums, Hervorhebungen, Zahlen), Dienst (2 Tests: Schätzung ohne Rückfrage;
  Ausführung mit Hinweis, Nein, Schutz), Dialog (3 Tests).
- **Im Browser** mit nachgebildetem Backend: Baumtabelle mit Balken, teuerstem Knoten, Abweichung, Einzelheiten und
  Hinweisen. **Nicht bedient:** das native Fenster; die Aktionen über den echten Editor (nur über Tests).
- `pnpm check` grün.

## Nicht umgesetzt

- **GuiExpert-Baumtabelle**: Es ist eine eigene `treegrid`-Tabelle (Pläne haben selten mehr als einige hundert
  Knoten; bei 5000 wird abgeschnitten und gesagt).
- Der Rohplan steht als Text in einem Kasten, nicht im **Nur-Lesen-Editor**.
- **Zwei Pläne vergleichen**, **Knotendiagramm** (beide im Prompt als optional).
- Plan exportieren: Rohplan als Datei (`.json`, `.sqlplan`, `.txt`) und der Baum als Text in die Zwischenablage.
- Der Plan läuft auf einer eigenen Sitzung: temporäre Tabellen und Einstellungen der Sitzung des Tabs kennt er nicht.
- Hinweise für SQL Server, MySQL und SQLite sind dünner als für PostgreSQL (was der Plan dort nicht sagt, wird nicht
  geraten).
- `EXPLAIN` ohne Ausführung kann in MySQL Unterabfragen auswerten; das ist Sache der Datenbank.
- Kein Review durch einen zweiten Agenten: Was ausgeführt wird, geht durch `admit` und wird zurückgerollt; der Rest
  liest.
