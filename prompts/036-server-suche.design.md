# Design 036: Suche auf dem Server

> **Status:** umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/server-suche` · Auftrag: [036-server-suche.md](036-server-suche.md) · Feature B4

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Wo wird gesucht? | **Daten**: je Tabelle eine `SELECT`-Anweisung im Backend (`db/find.rs`), die die gesuchten Spalten als Text vergleicht. **Definitionen**: Der Katalog liefert die Texte (Views, Routinen, Trigger, Checks, Vorgaben, Kommentare), gesucht wird in Rust – so gibt es reguläre Ausdrücke und Zeilennummern in allen vier Datenbanken. **Namen** als Option über die vorhandene Namenssuche | Aufgaben 2–4 |
| E2 | Der Suchtext | **immer gebunden**. „enthält“: `LIKE` mit `ESCAPE '!'` – `%`, `_`, `!` (und in SQL Server `[`) sind Zeichen; kein Backslash, den MySQL und ein so eingestelltes PostgreSQL in Strings eigen lesen. „genau“: Vergleich des Texts. „regulärer Ausdruck“: `~`/`~*` bzw. `REGEXP`; SQL Server und SQLite haben keinen – die Suche lehnt ab | Akzeptanzkriterium 1 |
| E3 | Groß/Klein | PostgreSQL `ILIKE`/`LIKE`; MySQL/MariaDB über `utf8mb4_general_ci`/`utf8mb4_bin`; SQL Server über `Latin1_General_100_CI_AS`/`_CS_AS`; SQLite `LIKE` (nur ASCII ohne Unterschied) bzw. `instr` | je Dialekt, was die Datenbank kann |
| E4 | Spalten | Art aus dem Typnamen: Texte (Vorgabe), Texte und Zahlen, alles außer Binärdaten. Eine Tabelle ohne passende Spalte wird ausgelassen und genannt | Aufgabe 1 |
| E5 | Treffer | Je Tabelle höchstens *n* Zeilen (Vorgabe 20; eine mehr wird gelesen, um „weitere“ zu wissen). Zurück kommen die ersten 4000 Zeichen jeder gesuchten Spalte; **welche Spalte** traf, findet das Backend lokal und schneidet eine Vorschau um die Stelle. Sieht nur die Datenbank den Treffer (eigene Regeln für Buchstaben, Stelle hinter 4000 Zeichen), bleibt die Spalte leer | Aufgabe 5 „Spalte, Fundstelle, Vorschau“ |
| E6 | Rücksicht | nur `SELECT`, eine Tabelle nach der anderen, Zeitlimit je Tabelle (Vorgabe 10 s), Tabellen über einer geschätzten Zeilenzahl (Vorgabe 1 Mio.) werden ausgelassen und genannt. Keine Parallelität | Aufgabe 6 |
| E7 | Job | `find_on_server` mit Ereignissen (`start`, `table`, `rows`, `source`, `skipped`) und `cancel_job` (Ids ab 6 · 10⁹); läuft auf der Sitzung der Verbindung. Was gemeldet ist, bleibt nach einem Abbruch stehen | Akzeptanzkriterium 2 |
| E8 | Rechte | Lehnt der Server eine Tabelle ab, wird sie mit seinem Text als „ausgelassen“ gemeldet; die übrigen werden durchsucht | Akzeptanzkriterium 3 |
| E9 | Ergebnis | **im Dialog**, nicht als Tab: Zeilen je Tabelle, Definitionen, Ausgelassenes – als Listen. „Zeilen zeigen“ öffnet die Tabelle als Tabellen-Ansicht mit der Bedingung „Spalte enthält Text“ (das Fenster nennt Spalte und Text, das Backend bindet); „Definition zeigen“ öffnet die Objekt-Details; „Treffer kopieren“ legt alles als TSV in die Zwischenablage | siehe „Nicht umgesetzt“ |
| E10 | Aufruf | `SEARCH_SERVER` (`Mod+K Mod+G`, Menü Verbindung → Schema), `SCHEMA_SEARCH` am Knoten eines Schemas oder einer Tabelle (sucht nur dort) | jede Funktion ist eine Aktion |

## Verträge

`find_on_server(jobId, id, spec, onEvent) → FindReport { tables, searched, skipped, rows, sources, cancelled, lost }`;
`FindSpec { text, mode, caseSensitive, columns, schemas, tables, data, sources, names, maxHits, tableTimeoutMs,
skipRowsOver }`. Fenster: `FindApi` (`core/find/`), `ServerSearchService`, `ServerSearchDialog`,
`server-search-logic.ts`; `TableViews.openWith`.

## Geprüft

- **Rust** (6 Tests, SQLite): Arten der Spalten; **der Text ist gebunden** und steht in keiner Anweisung (alle vier
  Dialekte, böser Text, böser Spaltenname); Maskierung; Stelle und Vorschau eines Treffers; Suche über alle
  Tabellen mit und ohne Groß/Klein, `%` und `_` als Zeichen, Zahlen, eine Tabelle, Treffergrenze; Definitionen
  (View, Trigger, Tabelle) und Namen; **300 Tabellen: Abbruch, Gefundenes bleibt**.
- **Gegen echte Server** (PostgreSQL, CockroachDB, MySQL, MariaDB, SQL Server; `a_text_is_found_on_every_server`):
  Zeilen mit und ohne Groß/Klein, `100%`, `sure_`, `%`, `[x]`, `!` als Zeichen, ein Text mit `' OR '1'='1`,
  Zahlen, Umlaute, regulärer Ausdruck (SQL Server lehnt ab), die View, die eine Spalte liest.
  `a_table_without_the_right_to_read_is_left_out`: eine Rolle ohne Leserecht auf eine Tabelle – sie wird genannt,
  die andere durchsucht.
- **Fenster**: Logik (5 Tests), Dialog (5 Tests: Suche mit Auswahl, Treffer als Text, Abbruch, „Zeilen zeigen“ als
  Bedingung, „Definition zeigen“, eine Tabelle, Fehler).
- **Im Browser** mit nachgebildetem Backend: Dialog über die Aktion, Suche, Treffer je Tabelle (ein `<img …>` im
  Treffer bleibt Text), Definition, Ausgelassenes, Bericht. **Nicht bedient:** das native Fenster.
- **Review durch einen zweiten Agenten**: siehe unten.
- `pnpm check` grün.

## Review (zweiter Agent, nur lesend)

REVIEW_PLACEHOLDER

## Nicht umgesetzt

- **Ergebnis-Tab mit GuiExpert-Baumtabelle** (Aufgabe 5): Die Treffer stehen als Listen im Dialog. Ein eigener
  Tab-Typ neben dem Abfrage-Tab wäre ein Umbau der Tab-Verwaltung; der Dialog bleibt offen, bis ein Treffer
  geöffnet wird.
- **Treffer exportieren** in eine Datei: Es gibt „Treffer kopieren“ (TSV).
- **Zeile öffnen** öffnet alle Zeilen der Tabelle, deren Spalte den Text enthält – nicht genau die eine Zeile
  (die Suche liest keine Schlüssel).
- Auswahl einzelner **Tabellen** im Dialog (nur Schemata; eine einzelne Tabelle über ihren Knoten im Baum).
- **Parallelität** als Einstellung; Rückfrage bei großen Tabellen (sie werden ausgelassen und genannt, die Grenze
  ist im Dialog änderbar).
- SQL Server und SQLite: keine regulären Ausdrücke in den Daten (in Definitionen schon). SQL Server verliert nach
  einem Zeitlimit die Sitzung – die Suche endet dann mit „Verbindung verloren“ und dem, was gefunden war.
- Schätzung der Größe: SQLite gibt keine – dort wird nichts ausgelassen.
