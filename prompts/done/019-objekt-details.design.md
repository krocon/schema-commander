# Design 019: Objekt-Details und DDL

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/objekt-details` · Auftrag: [019-objekt-details.md](019-objekt-details.md) · Feature B3

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Tab je Objekt oder Detailbereich? | **Ein Dialog**, der ein Objekt zeigt (Aktion `SCHEMA_DETAILS`, `Mod+I`, im Menü des Baumknotens). Eine Beziehung führt im selben Dialog zum Zielobjekt, „←“ zurück | Ein Tab ist heute ein `QueryTab` (Editor, Ergebnis, Sitzung, Sicherung): eine zweite Tab-Art hätte Tab-Leiste, Sitzung und Wiederherstellung umgebaut. Abweichung vom Auftrag („als Tab“) – das DDL lässt sich mit einem Klick in einen Tab holen |
| E2 | Form der Daten | `db/details.rs` liefert **Listen** (`Section { id, columns, rows }`: Schlüssel und Text) und das DDL. Das Fenster benennt Listen und Spalten aus dem Katalog der Texte und zeichnet jede Liste mit demselben Gitter | eine Liste mehr (oder eine Datenbank mehr) braucht keinen neuen DTO; unbekannte Listen werden trotzdem gezeigt |
| E3 | Verweigerte Listen | Eine Liste, die der Server ablehnt (Rechte, ältere Version, anderes Produkt), fehlt und steht in `notes`; der Dialog sagt, welche. Abbruch und getrennte Verbindung beenden alles | Statistik und Rechte sind oft nicht lesbar – der Rest soll trotzdem kommen |
| E4 | DDL: woher | SQLite `sqlite_schema.sql` (Tabelle, dann Indizes, Trigger); MySQL/MariaDB `SHOW CREATE TABLE/VIEW/PROCEDURE/FUNCTION/TRIGGER`; PostgreSQL `pg_get_viewdef`, `pg_get_functiondef`, `pg_get_indexdef`, `pg_get_triggerdef`, `pg_get_constraintdef`; SQL Server `sys.sql_modules`. **Tabellen** von PostgreSQL und SQL Server werden aus dem Katalog zusammengesetzt | Auftrag |
| E5 | Umfang des PostgreSQL-Tabellen-DDL | Spalten (Typ, Kollation, Vorgabe, NOT NULL, Identity, generiert), Partitionierung (`PARTITION BY`, `PARTITION OF … FOR VALUES`), Primär-/Unique-/Check-/Exclusion-Constraints, Fremdschlüssel als `ALTER TABLE` dahinter (die Reihenfolge der Tabellen spielt so keine Rolle), Sequenzen serieller Spalten (`CREATE SEQUENCE IF NOT EXISTS` davor, `OWNED BY` danach), Indizes ohne Constraint, Trigger, Kommentare, `UNLOGGED`. **Nicht:** Besitzer, Rechte, Tablespace, Speicherparameter, Row-Level-Security, Statistik-Objekte, Vererbung außer Partitionen | Rechte und Besitzer gehören zur Umgebung, nicht zur Struktur |
| E6 | Umfang des SQL-Server-Tabellen-DDL | Spalten (Typ, `IDENTITY(seed, schritt)`, berechnet/`PERSISTED`, NULL, benannte Vorgaben), Primär-/Unique-Schlüssel mit `CLUSTERED`/`NONCLUSTERED`, Checks, Fremdschlüssel mit Regeln, weitere Indizes (absteigend, `INCLUDE`, Filter), Trigger als eigene Batches (`GO`). **Nicht:** Kollation je Spalte, Dateigruppen, Partitionierung, Kompression, Columnstore, Rechte | – |
| E7 | Namen im DDL | PostgreSQL und SQL Server quoten auf dem Server (`quote_ident`, `QUOTENAME`); für `SHOW CREATE` und `sqlite_schema` – wo sich ein Name nicht binden lässt – quotet `meta::quote_always`. Alles andere sind gebundene Parameter | Regel aus 008 |
| E8 | Überladene Routinen (PostgreSQL) | Die Argumente, die der Baum zeigt, gehen als `detail` mit und wählen die Überladung | – |
| E9 | Gitter | Die Listen nutzen `ResultGrid` mit Zeilen im Speicher (`local`): filterbar über ein Feld, kopierbar als TSV (`Mod+C` auf der Auswahl). Leere und fehlende Werte sind dort schlicht leer | „durchsuch- und kopierbar“; kein zweites Gitter |
| E10 | Beziehungen | Listen „Verweist auf“, „Wird referenziert von“, „Benutzt“, „Benutzt von“, „Partitionen“ tragen `refSchema`/`refName`; darüber stehen die Ziele als Knöpfe | Sprung per Tastatur und Maus, ohne dem Gitter ein Ereignis abzuringen |
| E11 | Schnellinfo | Der Tooltip eines Tabellen- oder View-Knotens zeigt seine Spalten mit Typ und Schlüssel (höchstens 30), sobald sie ohnehin geladen sind – ohne Abfrage | Am Bezeichner im Editor kommt sie mit der Vervollständigung (021) |
| E12 | Abhängigkeiten | PostgreSQL über `pg_depend`/`pg_rewrite` (Views), SQL Server über `sys.sql_expression_dependencies`, MySQL 8 über `VIEW_TABLE_USAGE`; MariaDB und SQLite haben dafür nichts (die Liste fehlt bzw. ist vermerkt) | „wo der Katalog sie hergibt“ |

## Geprüft

- **Rundreise gegen echte Server** (`pnpm rust:test:db`, 26 Tests grün): Für PostgreSQL, MySQL, MariaDB und
  SQL Server legt je ein Test ein Testschema an (Fremdschlüssel mit Regeln, Check, Vorgabe, Identity/Serial/
  Auto-Increment, generierte bzw. berechnete Spalte, Kommentar, Index mit Ausdruck/Filter/INCLUDE, Trigger, View,
  Funktion/Prozedur, Sequenz; PostgreSQL zusätzlich Enum, Domain, partitionierte Tabelle, materialisierte View,
  Namen mit Leerzeichen und Umlaut), liest die Details, **löscht alles, führt das angezeigte DDL aus und vergleicht
  die Listen** (ohne Größen und Zeitstempel) sowie das DDL selbst. SQLite dasselbe als Unit-Test.
- Frontend: `details-logic.spec.ts`, `details-dialog.spec.ts` (mit Fake; Gitter und Editor als Platzhalter, weil
  sie in jsdom nicht rendern), `copy-logic.spec.ts` (lokale Kopie), `cell-format.spec.ts`.
- Im Browser mit nachgestelltem Backend: Tabelle mit **1 500 Spalten** – die Liste erscheint sofort, Filter und
  Rollen bleiben flüssig (das Gitter ist virtuell); DDL im Nur-Lesen-Editor mit Hervorhebung; Deutsch/Englisch.

## Dabei gefunden und behoben

- **SQL Server, seit Prompt 003/005:** Der Treiber hängt an jede Anweisung `;SELECT @@ROWCOUNT …`, um die Zahl
  der Zeilen zu erfahren. Bei `CREATE TRIGGER` und `CREATE PROCEDURE` reicht der Rumpf bis zum Ende des Batches –
  **der Zusatz wurde Teil des gespeicherten Triggers bzw. der Prozedur** und lief bei jedem Aufruf mit. Aufgefallen,
  weil das DDL nach der Rundreise eine Zeile länger war. Roter Test, dann: hinter `CREATE …`/`ALTER …` wird nichts
  angehängt. Wer mit einer früheren Version Trigger oder Prozeduren auf SQL Server angelegt hat, findet die Zeile
  in deren Text.
- PostgreSQL 18 führt `NOT NULL` als Constraint (`contype = 'n'`): aus Liste und DDL herausgenommen, sonst stünde
  es doppelt.
- `ObjectKind` war als Command-Argument nicht lesbar (ein Commit übersetzte nicht; im nächsten behoben).

## Nicht umgesetzt, nicht geprüft

- **Kein Vergleich mit `pg_dump --schema-only`** (Entscheidungsfrage des Auftrags): geprüft ist die Rundreise über
  den Katalog, nicht die Gleichheit mit dem Text von `pg_dump`.
- Nicht im DDL: siehe E5/E6. Auf SQL Server gibt es für **Typen** weder Liste noch DDL; MySQL kennt weder
  Sequenzen noch Typen (MariaDBs Sequenzen erscheinen als Tabellen).
- Aggregatfunktionen (PostgreSQL) haben kein DDL (`pg_get_functiondef` lehnt ab; vermerkt).
- Die Akzeptanz „1 500 Spalten **und 300 Indizes**“ lief im Browser mit nachgestellten Daten, nicht gegen eine
  echte Tabelle dieser Größe; wie lange die Katalogabfragen dafür brauchen, ist nicht gemessen.
- Eine Beziehung wird als Tabelle angesprungen, auch wenn das Ziel eine View ist (die Listen sagen die Art nicht);
  die Listen stimmen, das DDL einer View fehlt in diesem Fall.
- Schnellinfo am Bezeichner im Editor (Auftrag: „später“).
- Das native Fenster wurde nicht bedient; `Mod+C` im Gitter des Dialogs ist nur als Logik getestet.
