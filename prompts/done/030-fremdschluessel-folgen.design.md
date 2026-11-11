# Design 030: Fremdschlüsseln folgen

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/fremdschluessel-folgen` · Auftrag: [030-fremdschluessel-folgen.md](030-fremdschluessel-folgen.md) ·
> Feature D10

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Woher die Beziehungen? | `db/relations.rs` liest sie als **Daten** aus dem Katalog (`pg_constraint`, `KEY_COLUMN_USAGE`, `sys.foreign_keys`, `pragma_foreign_key_list`): je Schlüssel Spaltenpaare in der Reihenfolge des Schlüssels, mit Schema – also zusammengesetzt und über Schemagrenzen. Eine Abfrage je Tabelle liefert, was sie hat und was auf sie zeigt; ein Verweis auf sich selbst ist beides. SQLite: fehlende Zielspalten sind der Primärschlüssel des Ziels. Alles über `Session::ask` mit gebundenen Parametern | Aufgabe 1 |
| E2 | **Wo geht es?** | **In Tabellen-Ansichten** (027): dort ist die Tabelle jeder Spalte bekannt. In beliebigen Abfrage-Ergebnissen ist die Funktion **aus** – die Herkunft einer Spalte (Tabelle/Spalte) liefern die Treiber nicht einheitlich (PostgreSQL und MySQL ja, SQL Server nur im Browse-Modus), und ohne sie wäre es Raten. Die Aktionen sagen dann, wo es geht | Aufgabe 1 „sonst ist die Funktion aus“ |
| E3 | Wie wird gefolgt? | Folgen = eine **Tabellen-Ansicht mit Schlüsselmenge** öffnen: `TableQuery.keys = { columns, rows }`. `filter.rs` schreibt bei einer Spalte `spalte IN (…)`, bei mehreren `((a = … AND b = …) OR …)`, jeden Wert gebunden (PostgreSQL mit Cast auf den Typ der Quellspalte). Mit den Bedingungen der Filterzeile per `AND` verbunden – man kann die Verwandten weiter filtern. Höchstens 1000 Schlüssel und 2000 Werte (SQL Server: 2100 Parameter), 16 Spalten | Akzeptanzkriterium 2 |
| E4 | `NULL` im Schlüssel | Eine Zeile, deren Schlüssel an irgendeiner Stelle `NULL` ist, verweist auf nichts: Sie wird ausgelassen; ist es die einzige, sagt die Statuszeile das. Zellen mit `NULL` sind nicht als Verweis markiert | Akzeptanzkriterium 1 |
| E5 | Vorwärts | Zellen von Fremdschlüssel-Spalten sind punktiert unterstrichen. `FK_FOLLOW` (`F4`, `Strg/Cmd`+Klick) öffnet das Ziel **im Tab**, `FK_FOLLOW_TAB` in einem neuen, `FK_PEEK` (`Umschalt+F4`) als **Vorschau** (bis zu 5 Zeilen, Spalte/Wert, von dort „Öffnen“). Drei Aktionen statt einer Einstellung mit Modifikator | Aufgabe 2; jede per Tastatur |
| E6 | Rückwärts | `FK_REFERENCED_BY` (`Alt+F7`): Liste „wird referenziert von“ mit Tabelle und Spalten; „Zählen“ je Eintrag oder für alle (`SELECT COUNT(*)` mit derselben Schlüsselmenge, gebunden, über `run_query` und damit durch den Schutz der Verbindung). Auswahl öffnet die gefilterten Zeilen; mit Modifikator im neuen Tab | Aufgabe 3 |
| E7 | Mehrere Zeilen | Sind Zeilen markiert, gelten alle (jeder Schlüssel einmal), sonst die Zeile des Cursors. Gelesen werden höchstens 20 000 Zeilen der Auswahl; über 1000 verschiedenen Schlüsseln sagt die Statuszeile, dass nur die ersten verfolgt werden | Aufgabe 4 |
| E8 | Gehört die Spalte zu mehreren Schlüsseln (oder steht der Cursor daneben)? | Liste der Schlüssel der Tabelle zur Auswahl; bei genau einem Schlüssel der Spalte geht es sofort | |
| E9 | Pfad | je Tab eine Liste von Tabellen-Ansichten mit Stelle (`NavState`), wie im Browser: weiter schneidet ab, was vorn lag; höchstens 50. Eine Zeile über dem Ergebnis: ←, →, die Orte als Knöpfe, dazu womit die Tabelle eingeengt ist („id = 42“) und „Ganze Tabelle zeigen“. `NAV_BACK`/`NAV_FORWARD` (`Alt+←/→` im Ergebnis). Ändert man den Filter eines Ortes, merkt der Pfad ihn | Aufgabe 5 |
| E10 | Gemerkte Filter | Eine über einen Schlüssel erreichte Ansicht wird nicht als Filter der Tabelle gemerkt (und löscht den gemerkten nicht) | Schlüssel sind „woher ich kam“ |
| E11 | Eigene Beziehungen | `FK_DEFINE`: Formular Spalte → Schema/Tabelle/Spalte, gemerkt je Verbindung in den Einstellungen (`virtualRelations`, nicht im Export; bis 500). Vorschläge aus dem Namen (`customer_id` → `customer.id`, `customers.id`) nur als Knöpfe, die das Formular füllen. Sie gelten wie Fremdschlüssel (vorwärts und rückwärts), in Listen mit „eigene“ markiert. Die Namen gehen als Namen ans Backend und werden dort gequotet | Aufgabe 6 |
| E12 | Aktualität | Die Schlüssel einer Tabelle gelten 60 s, dann werden sie beim nächsten Gebrauch neu gelesen (DDL) | |

## Verträge

`meta_relations(id, schema, table) → { outgoing: ForeignKey[], incoming: ForeignKey[] }`; `table_query` nimmt
zusätzlich `keys` und `count`.

## Geprüft

- **Rust**: Falten der Katalogzeilen, Einsortieren (Selbst-Verweis), SQLite gegen die Demo-Datenbank
  (zusammengesetzt, ohne Zielspalten, auf sich selbst); Schlüsselmengen im Erzeuger (Form je Dialekt, Klammerung
  mit ODER-Bedingungen, Zählen ohne `ORDER BY`/`LIMIT`/`TOP`, Grenzen, böse Werte × 3 Arten × 4 Datenbanken ×
  ein/mehrspaltig: nichts vom Wert in der Anweisung).
- **Gegen echte Server** (PostgreSQL, MySQL, MariaDB, SQL Server; `every_server_knows_its_foreign_keys_and_follows_them`):
  zusammengesetzter Schlüssel in anderer Spaltenreihenfolge als die Tabelle, Verweis in ein anderes Schema,
  Tabelle auf sich selbst; dann mit den erzeugten Anweisungen gefolgt – vorwärts über zwei Spalten, rückwärts
  gezählt, ein Wert, der wie SQL aussieht (findet nichts, richtet nichts an). Ganze Treiber-Suite: 30 Tests grün.
- **Fenster**: reine Logik (9 Tests: Verweis-Zellen, Schlüsselwerte ohne NULL und Doppelte, Grenzen, Sichten
  vorwärts/rückwärts/Baum, Pfad, eigene Beziehungen, Vorschläge); Dienst mit Fakes (9 Tests: einmal lesen, folgen
  im Tab, mehrere Zeilen, NULL, zurück/vor, Liste mit Zählen, neuer Tab, Vorschau mit gebundenem Wert, eigene
  Beziehung anlegen und entfernen).
- **Im Browser** mit nachgebildetem Backend: Verweis-Zellen unterstrichen (NULL nicht); `F4` → Ziel gefiltert,
  Pfad „orders › customer“, „id = 42“, gebundener Wert an der Brücke; `Umschalt+F4` auf dem Selbst-Verweis →
  Vorschau, Fokus auf „Öffnen“, `Esc`; `Alt+←` zurück; `Alt+F7` → Liste, „Alle zählen“ → 2. Ein Wert mit
  `<b>` erscheint als Text.
- **Sicherheits-Review** durch einen eigenen Agenten: siehe unten.
- `pnpm check` grün.

## Review (eigener Agent, nur lesend)

Keine Injektion, kein Markup aus Werten, kein Weg am Schutz der Verbindung vorbei; alle Katalogabfragen gebunden,
das eine `format!` setzt nur das gequotete Schema ein. Fünf kleine Befunde, alle mit rotem Test behoben:

| Befund | Behoben |
|---|---|
| Lange Text-Schlüssel kommen aus dem Fenster gekürzt (1000 Zeichen + „…“) und würden gekürzt verfolgt | Texte ab 1000 Zeichen sind kein Schlüssel; die Statuszeile sagt es |
| Schlüssel und Bedingungen zusammen konnten mehr Werte binden, als der Treiber nimmt – der Fehler kam erst beim Ausführen | `filter::build` lehnt über 2000 Werte ab, bevor etwas gezeigt wird |
| Keine Grenze für die Länge eines Schlüsselwerts | höchstens 4096 Bytes |
| Vorschau und Zählen gaben ihr Ergebnis nicht frei, wenn das Lesen scheiterte; „Alle zählen“ startete alles zugleich und lief nach dem Schließen weiter | `try/finally`; gezählt wird nacheinander und nur, solange die Liste offen ist |
| Der Schlüssel des Zwischenspeichers (`schema.tabelle`) war mehrdeutig | JSON aus Verbindung, Schema, Tabelle |

**Für Marc zu entscheiden** (Hinweis des Reviews, nichts geändert): Die lesbare Form einer Tabellen-Ansicht steht
seit 027 im Editor und damit in Verlauf und Tab-Sicherung. Seit 030 enthält sie auch Schlüsselwerte **aus
Ergebnissen** (bis zu 2000). Das bricht keine Regel (gebunden gesendet, nichts geloggt), legt aber Daten ab.
Denkbar: Ansichten, die die App geöffnet hat, mit gekürzter Liste im Verlauf.

Außerdem (Eigenheit von SQLite): Ein vertippter Spaltenname einer eigenen Beziehung gilt dort in Anführungszeichen
als Text – es kommen keine Zeilen statt eines Fehlers.

## Nicht umgesetzt, nicht geprüft

- **Abfrage-Ergebnisse** (kein „Daten öffnen“): keine Verweise – die Herkunft der Spalten aus den Treibern zu
  holen, ist ein eigener Schritt (E2).
- **Master-Detail** (optional im Auftrag): nicht gebaut.
- Eigene Beziehungen haben eine Spalte; zusammengesetzte lassen sich nicht anlegen. Ob Tabelle und Spalte
  existieren, prüft das Formular nicht – der Fehler der Datenbank erscheint beim Folgen.
- „Alles markiert“ gilt wie „nichts markiert“: die Zeile des Cursors.
- Der Titel des Tabs bleibt beim Folgen im Tab der alte; der Pfad sagt, wo man ist.
- Das native Fenster (`pnpm tauri dev`) wurde wie bisher nicht bedient, kein echter Screenreader.
