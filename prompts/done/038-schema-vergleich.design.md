# Design 038: Schema-Vergleich

> **Status:** umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/schema-vergleich` · Auftrag: [038-schema-vergleich.md](038-schema-vergleich.md) · Feature B6

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Umfang | Alle vier Datenbanken, **gleicher Typ** auf beiden Seiten (über Typgrenzen lehnt der Vergleich ab). Verglichen: Tabellen, Spalten (Typ, NULL, Default), Primärschlüssel, Indizes, Fremdschlüssel, Checks, Views, Routinen, Trigger. **Nicht verglichen:** Rechte, Partitionen, Speicherparameter, Sequenzen, Identity/`auto_increment`, Kommentare, Sortierungen, Regeln der Schlüssel (`ON DELETE`), materialisierte Views, Reihenfolge der Spalten | Entscheidungsfragen 1 und 2 |
| E2 | Schnappschuss | `schema_snapshot` liest ein Schema in wenigen Katalogfragen (die des Diagramms 037 und der Definitionen 036, dazu Indizes und Defaults) in ein serialisierbares Modell. Es ist zugleich das Dateiformat (JSON); ein Schnappschuss aus einer Datei wird vor jeder Arbeit geprüft (Grenzen; ein Typname ist nur ein Typname) | Aufgaben 1, 6 |
| E3 | Vergleich | rein (`compare`): Paare nach Namen, bei Indizes, Schlüsseln und Checks nach **Inhalt** – ihr Name ist oft vom Server vergeben. Normalisiert: Typ-Synonyme (`int4`/`integer`, `varchar`/`character varying`, MySQLs Anzeigebreite), Defaults (Klammern von SQL Server, Cast von PostgreSQL hinter einem Literal), Leerraum, der eigene Schemaname vor Namen | Aufgabe 2 |
| E4 | **Skript** | rein (`script(source, target, picks, renames)`), in fester Reihenfolge: Umbenennungen → Schlüssel und Checks, die gehen → Indizes, die gehen → neue Tabellen → Spalten → Indizes → Primärschlüssel und Checks → Fremdschlüssel → Views/Routinen/Trigger → nur im Ziel vorhandene Views/Routinen/Trigger → nur im Ziel vorhandene Spalten und Tabellen. Neue Tabellen entstehen ohne Fremdschlüssel; die kommen danach | Aufgabe 4: Abhängigkeiten |
| E5 | **Gefährliche Schritte** | stehen als Kommentar mit der Marke `-- DANGER: ` und einem Satz, warum: Tabelle oder Spalte löschen; View/Routine/Trigger löschen; Typ ändern, außer bei bekannter Erweiterung (größere Ganzzahl, längerer Text, mehr Stellen vor **und** hinter dem Komma); `NOT NULL` auf eine vorhandene Spalte; neue Spalte ohne NULL und ohne Default; in MySQL jedes `MODIFY COLUMN` (es stellt die Spalte neu hin – was der Schnappschuss nicht kennt, ginge verloren). Was sich für eine Datenbank nicht schreiben lässt (SQLite: Spalte ändern, Schlüssel nachträglich), steht als Hinweis | Akzeptanzkriterium 2 |
| E6 | Umbenennungen | erkennt die App nicht; zwei Einträge (nur links / nur rechts, beide Tabelle oder Spalten einer Tabelle) lassen sich als „eins“ kennzeichnen. Vergleich und Skript arbeiten dann auf dem umbenannten Ziel; das Skript benennt zuerst Spalten, dann Tabellen um | Aufgabe 5 |
| E7 | Ausführen | **nie durch die App.** Das Skript öffnet sich als Abfrage-Tab auf der Zielverbindung; dort gelten Zerlegen, Schutz (012) und Transaktion wie für jedes Skript | Ziel des Prompts |
| E8 | Ansicht | Dialog: zwei Seiten (Verbindung + Schema oder Schnappschuss-Datei), Liste der Objekte mit Zustand, Filter (nur Unterschiede, Art, Name), Auswahl fürs Skript, darunter beide Definitionen nebeneinander mit zeilenweisem Vergleich (eigene LCS-Logik). Bericht als Markdown | Aufgabe 3; siehe „Nicht umgesetzt“ |

## Verträge

`schema_snapshot(id, schema) → Snapshot`, `schema_compare(left, right, renames) → Item[]`,
`schema_script(source, target, picks, renames) → string`. Fenster: `CompareApi` (`core/compare/`),
`SchemaCompareDialog`, `compare-logic.ts`; Aktion `COMPARE_SCHEMAS`.

## Geprüft

- **Rust, rein** (11 Tests): Schreibweisen ohne Unterschied; Zustände; welche Typänderung Daten kosten kann;
  Reihenfolge des Skripts und **jeder zerstörende Schritt als Kommentar**; Umbenennungen in beiden Reihenfolgen;
  Namen mit Zeilenenden und ein feindlicher Schnappschuss; MySQL-`MODIFY` markiert; **Rundreise in SQLite**.
- **Rundreise gegen echte Server** (PostgreSQL, MySQL, MariaDB, SQL Server;
  `a_migration_script_applied_leaves_no_difference`): zwei gleiche Schemata, eines verändert (neue Tabelle mit
  Schlüssel, Check und eindeutigem Index; neue Spalte mit Default; breiterer Typ; Spalte, Tabelle und View weg; Index
  ersetzt; neue View). Das vorgeschlagene Skript lässt genau die markierten Schritte übrig; mit eingeschalteten
  Marken bleibt **kein Unterschied**. Das Ziel nimmt danach Zeilen an, sein Fremdschlüssel hält, Größen der Typen
  stimmen (`decimal(8,2)`, `varchar(200)`). Ganze Treiber-Suite: 45 Tests grün.
- **Fenster**: Logik (5 Tests: Schnappschuss-Datei, Filter, Umbenennungs-Paare, zeilenweiser Vergleich, Bericht),
  Dialog (6 Tests).
- **Nicht geprüft:** der Dialog im Browser und im nativen Fenster (nur über die Komponententests).
- **Review durch einen zweiten Agenten**: siehe unten.
- `pnpm check` grün.

## Review (zweiter Agent, nur lesend: Reihenfolge, Datenverlust)

Behoben, jeweils mit rotem Test zuerst:

| Befund | Behoben |
|---|---|
| **H1** SQL Server: Typen kamen ohne Länge und Stellen (`decimal`, `varchar`) – ein unkommentiertes `ALTER COLUMN price decimal` hätte jeden Wert gerundet, neue Tabellen hätten `varchar(1)` bekommen | Der Katalog liefert den vollen Typ (`decimal(10,2)`, `nvarchar(max)`); die Rundreise prüft die Größen |
| **H2** Ein `\r` in einem Namen beendete in PostgreSQL den Kommentar eines markierten Schritts | Namen mit Steuerzeichen bekommen kein Skript; die Marke steht vor jeder Zeile, was auch immer sie beendet |
| **H3** Tabelle und ihre Spalte umbenannt: Je nach Reihenfolge der Angabe scheiterte das Skript oder legte die Spalte neu an | Vergleich: erst Tabellen, dann Spalten; Skript: erst Spalten (alter Tabellenname), dann Tabellen |
| **M1** `numeric(10,2)` → `numeric(10,4)` galt als sicher (weniger Stellen vor dem Komma); `varchar(40)[]` als „ohne Grenze“ | geprüft werden auch die Stellen vor dem Komma; eine unlesbare Größe gilt als Verengung |
| **M2** MySQL: `int unsigned` galt als `int` | `unsigned` gehört zum Typ; Wechsel des Vorzeichens ist eine Verengung |
| **M3** MySQL-`MODIFY COLUMN` stand unkommentiert und hätte `auto_increment`, Kommentar, Sortierung verworfen | nur der Default allein wird ohne Neuaufstellung geändert; jedes `MODIFY` ist markiert |
| **M4** Indizes fielen vor den Schlüsseln, die sie brauchen | eigener Schritt für Indizes nach Schlüsseln und Checks |
| **M5** MySQL-Checks wurden nie verglichen (der Katalog nennt die Tabelle nicht) | die Frage verbindet sie mit ihrer Tabelle (auch für die Suche 036) |
| **M6** Der Schemaname wurde überall im Text entfernt (`boss.id` bei Schema `s`) | nur am Anfang eines Namens |
| **M7** Materialisierte Views liefen als Views mit | werden nicht verglichen |
| **M8** Schnappschuss-Datei: Typnamen und Texte ungeprüft | Grenzen für alle Texte und Listen; ein Typname darf nur wie einer aussehen; der Kopf des Skripts sagt, woher Definitionen stammen |
| Niedrig | Index auf einem Ausdruck (MySQL, SQLite): als Hinweis statt Fehler; Schlüssel auf eine gelöschte Tabelle werden nicht doppelt gelöscht; ein Cast hinter einem Ausdruck bleibt Teil des Defaults |

Offen gelassen: eindeutige **Constraints** (statt Indizes) werden als Index gelöscht – PostgreSQL und SQL Server
lehnen das ab (laut, kein Datenverlust); Regeln der Fremdschlüssel (`ON DELETE CASCADE`) werden nicht verglichen
und nicht mit angelegt; PostgreSQL-Defaults mit `nextval` zeigen im Ziel auf eine Sequenz, die das Skript nicht
anlegt; die Reihenfolge der Primärschlüsselspalten folgt den Spalten; Views, die aufeinander aufbauen, stehen in
der Reihenfolge ihrer Namen; überladene Routinen in PostgreSQL werden nach ihrer Stelle gepaart; MySQL-Defaults mit
Ausdruck (`uuid()`) können ohne Klammern ankommen; Umbenennungen stehen im Skript, auch wenn nichts sonst gewählt
ist.

## Nicht umgesetzt

- **Baumtabelle (GuiExpert)**: Die Objekte stehen als eingerückte Liste (Teile unter ihrer Tabelle).
- Bericht als **HTML** (es gibt Markdown).
- Spalten-**Reihenfolge** als Unterschied; alles unter „Nicht verglichen“ (E1).
- Für MySQL und SQL Server geben die Kataloge für manche Objekte keine ausführbare Definition (MySQL: Routinen und
  Trigger nur als Rumpf): Das Skript sagt es in einem Hinweis.
