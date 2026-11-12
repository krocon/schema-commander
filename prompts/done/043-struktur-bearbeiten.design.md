# Design 043: Struktur bearbeiten

> **Status:** umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/struktur-bearbeiten` · Auftrag: [043-struktur-bearbeiten.md](043-struktur-bearbeiten.md) · Feature E3

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Wer schreibt das DDL | Das Fenster sendet die Tabelle, **wie sie gelesen wurde** und **wie sie bearbeitet ist**, dazu die Umbenennungen der Spalten – nie SQL. `db/structure.rs` lässt daraus den Migrations-Erzeuger des Schema-Vergleichs (038, `compare::script_steps`) die Anweisungen schreiben: ein Erzeuger für beide Stellen, mit derselben Reihenfolge und denselben Gefahren-Prüfungen | Aufgabe 2 und 3; kein zweiter DDL-Schreiber, der anders irrt |
| E2 | Änderungsmodell | rein im Fenster (`structure-logic.ts`): Formular ⇄ Tabelle, Liste der Operationen (neu, gelöscht, umbenannt, geändert – je Spalte, Index, Schlüssel, Check), Prüfung. Was nicht angefasst wurde, geht **unverändert** zurück (ein Index von PostgreSQL mit seiner Anweisung) – so ändert sich nur, was der Nutzer änderte | Aufgabe 2 |
| E3 | Umbenennen | Eine Spalte weiß, wie sie beim Lesen hieß: daraus wird `RENAME COLUMN`, nie „löschen und neu“. Indizes und Schlüssel, die die Spalte nennen, folgen dem neuen Namen und bleiben dieselben | Datenverlust vermeiden |
| E4 | Schritte | Jeder Schritt ist **eine** Anweisung (`structure::single`); was Daten kosten kann (Spalte löschen, Typ verengen, NOT NULL auf Bestandsdaten, Tabelle löschen/leeren), trägt seinen Grund. Typen, Vorgaben und Checks müssen in einer Zeile stehen – sonst lehnt das Backend ab | Aufgabe 4 |
| E5 | Vorschau | Der Dialog zeigt erst die Änderungen in Worten, dann die Anweisungen; gefährliche sind markiert, und „Ausführen“ ist gesperrt, bis der Nutzer bestätigt, sie gelesen zu haben. „Als Skript öffnen“ legt die Anweisungen in einen neuen Tab – gefährliche dort als Kommentar (`-- DANGER: `), wie beim Schema-Vergleich | Aufgabe 4 („DDL im Editor, bearbeitbar“) |
| E6 | Ausführen | `struct_apply` schreibt die Anweisungen **noch einmal** aus der Anfrage, lässt jede durch `ConnectionManager::admit` (Schutzstufen und Bestätigungen aus 012 – der Dialog fragt wie bei jedem Lauf) und führt sie auf eigener Sitzung aus: in **einer Transaktion** bei PostgreSQL, SQL Server und SQLite; MySQL/MariaDB schreiben DDL einzeln fest – das sagt der Dialog vorher, und nach einem Fehler, was bleibt | Aufgabe 4, Akzeptanzkriterium 2 |
| E7 | Nur lesen | Auf einer Verbindung der Stufe „nur lesen“ ist der Dialog gesperrt (und das Backend lehnt ohnehin ab) | Akzeptanzkriterium 2 |
| E8 | Umfang je Datenbank | Spalten (Name, Typ, NULL, Vorgabe), Primärschlüssel, Indizes (Spalten, eindeutig), Fremdschlüssel (Spalten, Ziel), Checks, Tabellenname – für PostgreSQL, MySQL, MariaDB, SQL Server. Ein Index, der mehr ist als eine Spaltenliste (Ausdruck, Reihenfolge, Bedingung), wird gezeigt und nicht bearbeitet. Alles andere: handgeschriebenes DDL („Nicht umgesetzt“) | Entscheidungsfrage 1 |
| E9 | SQLite | Was SQLite mit `ALTER TABLE` kann (Spalte hinzufügen, umbenennen, löschen; Tabelle umbenennen; Indizes), läuft; was nur über „neue Tabelle, kopieren, umbenennen“ geht (Typ, NULL, Vorgabe, Schlüssel, Checks einer bestehenden Tabelle), steht in der Vorschau als **Hinweis** – der Neuaufbau wird nicht automatisch angeboten | Entscheidungsfrage 2; ein automatischer Neuaufbau müsste Trigger, Views und Fremdschlüssel anderer Tabellen mittragen |
| E10 | Tabellen-Operationen | Neu, Duplizieren (Struktur, auf Wunsch die Zeilen; Indizes und Constraints bekommen eigene Namen), Leeren, Löschen – derselbe Dialog, immer mit Vorschau; Leeren und Löschen sind als gefährlich markiert. Umbenennen: der Name im Editor | Aufgabe 5 |
| E11 | Danach | Baum, Namensindex und Vervollständigung lesen neu (`SchemaStore.ran`, wie nach jedem DDL eines Tabs) – auch nach einem Lauf, der bei MySQL halb durchging | Aufgabe 6 |
| E12 | Views und Routinen | „Definition bearbeiten“ öffnet das DDL aus den Objekt-Details (019) in einem Tab – als `CREATE OR REPLACE` (PostgreSQL, Views in MySQL) bzw. `CREATE OR ALTER` (SQL Server); wo der Dialekt nicht ersetzen kann, sagt ein Kommentar das. Gespeichert wird durch Ausführen, unter dem normalen Schutz | Aufgabe 7 |
| E13 | Lesen | `struct_load` liest über den Schnappschuss des Schemas (038) und nimmt die Tabelle heraus; die Spalten eines PostgreSQL-Index kommen aus seiner Anweisung, wenn sie eine reine Spaltenliste ist | ein Leser für Vergleich und Editor |

## Was die Datenbanken zeigten

Die Rundreise gegen die echten Server hat am Erzeuger aus 038 zwei Dinge gefunden, die jetzt behoben sind:

- **Checks ohne Namen** in `CREATE TABLE`: Die Datenbank vergab einen eigenen – beim nächsten Lesen ein „anderer“
  Check. Jetzt `CONSTRAINT name CHECK (…)`.
- **MariaDB kennt kein `DROP CHECK`**: jetzt `DROP CONSTRAINT` (versteht auch MySQL ab 8.0.19).

Und zwei, die keine Fehler sind, aber im Editor sichtbar: MySQL legt zu jedem Fremdschlüssel selbst einen Index
an (und lässt ihn nicht löschen, solange der Schlüssel besteht); MariaDB nennt `NULL` als Vorgabe jeder Spalte,
die NULL erlaubt.

## Geprüft

- **Rust** (23 Tests in `structure_tests.rs`, zehn davon aus dem Review): neue Tabelle mit Schlüsseln, Indizes, Checks; Änderungen als
  `ALTER` in tragfähiger Reihenfolge mit Gefahren; Tabelle und Spalten umbenennen (drei Dialekte); nichts geändert
  = nichts zu tun; Namen gequotet, feindliche abgelehnt; 14 unsinnige Tabellen abgelehnt (auch Zeilenumbruch in
  Typ, Vorgabe, Check); Löschen und Leeren gefährlich; Kopie mit eigenen Namen und den Zeilen vor ihren
  Schlüsseln; jeder Schritt eine Anweisung; Spalten aus einer Index-Anweisung (11 Fälle); **Rundreise in SQLite**;
  ein Fehler rollt alles zurück und lässt die Sitzung frei; Kopieren, Leeren, Löschen in SQLite.
- **Gegen die Container** (`a_structure_edited_and_written_reads_as_edited`, PostgreSQL, MySQL, MariaDB,
  SQL Server): Tabelle aus dem Editor anlegen (Vorgabe mit `'`) → gelesen wie bearbeitet; Spalte umbenennen →
  **eine** Anweisung, der Index bleibt derselbe; Tabelle umbenennen, Spalten hinzufügen (Name mit Leerzeichen,
  Vorgabe mit `'`), Typ erweitern, Spalte löschen, Check löschen, Index tauschen → gelesen wie bearbeitet, die
  Zeile ist noch da; ein Fehler mitten im Lauf → zurückgerollt (MySQL/MariaDB: die Anweisung davor bleibt, und
  das wird gemeldet); Kopie mit Zeilen, Leeren, Löschen.
- **Fenster** (29 Tests): Logik (Namenslisten, unberührte Tabelle = dieselbe Tabelle, Operationen, Umbenennen
  mit folgenden Indizes und Schlüsseln, bearbeiteter Index verliert seine Anweisung, Schlüsselspalten nie NULL,
  neue Tabelle, 11 Prüfungen, Anfrage, Skript, Typ-Vorschläge, Definition als ersetzende Anweisung); Dialog
  (lesen, senden, Vorschau, Ausführen; gefährlicher Schritt sperrt bis zur Bestätigung; Rückfrage des Schutzes,
  ein Nein führt nichts aus; Fehler mit Anweisung und „zurückgerollt“; nur lesen; neue Tabelle; Löschen;
  Kopieren; Skript im neuen Tab; Texte der Datenbank bleiben Text; Lesefehler).
- **Im Browser** mit nachgebildetem Backend: Struktur einer Tabelle, Spalte umbenannt (der Index folgt), Spalte
  hinzugefügt, Spalte gelöscht, deren Fremdschlüssel noch da ist → Meldung; Schlüssel entfernt → Vorschau mit
  Änderungen in Worten, drei Anweisungen, die gefährliche markiert, „Ausführen“ gesperrt bis zum Haken; Ausführen
  → `struct_apply`, der Baum liest neu; Löschen einer Tabelle mit Vorschau; „Als Skript öffnen“. **Nicht
  bedient:** das native Fenster.
- `pnpm check` grün; `pnpm rust:test:db` grün (47 Tests).

## Review

Ein zweiter Agent hat die Erzeugung und den Lauf gelesen (Datenverlust, Reihenfolge, Transaktionen, Einschleusen,
Fenster-Logik). Nichts gefunden bei: gleiche Anweisungen geprüft wie ausgeführt, Transaktionen je Dialekt, Namen
(bis auf `sp_rename`), Markierung von Löschen/Leeren/Duplizieren. Behoben – jeweils zuerst mit rotem Test:

| Nr. | Befund | Behebung |
|---|---|---|
| H1 | Ein Fremdschlüssel der Tabelle **auf sich selbst** galt nach dem Umbenennen der Tabelle (oder der Zielspalte) als geändert: `DROP` + `ADD … REFERENCES alter_name` – in MySQL blieb der Schlüssel dann gelöscht | `structure::settle`: Der Schlüssel folgt dem neuen Namen der Tabelle und ihrer Spalten |
| H2 | Typ **ohne Größe** galt als „weiter“ (`decimal(12,4)` → `decimal` ist in SQL Server `decimal(18,0)` und rundet still) | `compare::narrows`: Größe weglassen ist gefährlich – hier weiß niemand, welche Datenbank es ist |
| M3, M7 | Stand für einen Teil der Änderung nur ein Hinweis (Primärschlüssel ändern; Vorgabe in SQL Server), lief der Rest trotzdem | `Plan.incomplete`: Ein solcher Plan wird gezeigt und lässt sich als Skript öffnen, aber nicht ausführen (auch `struct_apply` lehnt ab) |
| M4 | MySQL und SQL Server verweigern das Umbenennen einer Spalte, die ein Check benutzt | wird vorher gesagt (Hinweis → unvollständig) |
| M5 | SQLite: neue Tabelle oder Kopie mit Fremdschlüssel scheiterte (`ALTER TABLE … ADD FOREIGN KEY` gibt es dort nicht) | Schlüssel stehen in SQLite im `CREATE TABLE` |
| M6 | `sp_rename` mit ungequoteten Namen: ein Punkt im Namen traf ein anderes Objekt oder keines | jeder Teil in eckigen Klammern |
| M8 | Umbenennungen, die sich kreuzen (tauschen, Kette, „b löschen und a zu b“), fielen zusammen | abgelehnt: „in zwei Schritten umbenennen“ |
| M9 | Eine `definition` vom Fenster wäre als Anweisung geschrieben worden | Die Anweisung einer Tabelle oder eines Index zählt nur, wenn die gelesene Tabelle genau sie hat |
| M10 | `enum('in-progress',…)` wurde als Typ abgelehnt | zwischen einfachen Anführungszeichen darf ein Typ beliebigen Text einer Zeile tragen |
| M11 | Index, Schlüssel oder Check **nur umbenannt**: keine Anweisung, obwohl die Vorschau eine Änderung nannte; neue ohne Namen scheiterten erst im Backend | Hinweis (→ unvollständig); das Formular verlangt Namen |
| L12 | Eine unberührte SQLite-Tabelle mit `INTEGER PRIMARY KEY` ergab eine Änderung | Schlüsselspalten bleiben, wie sie gelesen wurden |

Offen gelassen (unter „Nicht umgesetzt“): Vorgaben in SQL Server (benannte Default-Constraints), Indizes hinter
einem `UNIQUE`-Constraint, Namen mit `"` oder Leerraum am Rand, Reihenfolge eines zusammengesetzten Schlüssels,
eine Vorgabe, die auf `;` endet, „zurückgerollt“ nach einem gescheiterten `COMMIT`, zwei Läufe zugleich.

## Nicht umgesetzt

- **Identity/Auto-Increment, generierte Spalten, Kommentare** (Spalte und Tabelle), **Reihenfolge der Spalten**
  einer bestehenden Tabelle, **`ON DELETE`/`ON UPDATE`** eines Fremdschlüssels, Art und Bedingung eines Index,
  Sortierung/Kollation: Der Schnappschuss aus 038 kennt sie nicht; dafür handgeschriebenes DDL (das Skript ist
  der Ausgangspunkt).
- **`USING` beim Typwechsel** in PostgreSQL: Der Typwechsel wird als `ALTER COLUMN … TYPE` geschrieben; verlangt
  PostgreSQL einen Ausdruck, schlägt die Anweisung fehl (und alles wird zurückgerollt) – dann das Skript öffnen
  und `USING …` ergänzen.
- **SQLite-Neuaufbau** einer Tabelle (E9).
- **Auswahl** der Zieltabelle und ihrer Spalten beim Fremdschlüssel: Es sind Textfelder.
- **Lange Sperren** werden nicht eigens gewarnt (nur was Daten kosten kann).
- Offene Tabellen-Ansichten der geänderten Tabelle lesen nicht von selbst neu (der Baum und die Vervollständigung
  tun es).
- Routinen in MySQL lassen sich nicht in einer Anweisung ersetzen: Der Kommentar im Tab sagt es.
- **Aus dem Review, nicht behoben:** SQL Server – eine Vorgabe ändern oder eine Spalte mit Vorgabe löschen
  scheitert am benannten Default-Constraint (Hinweis bzw. Fehler der Datenbank, alles wird zurückgerollt);
  ein Index, der einen `UNIQUE`-Constraint trägt, erscheint als Index, und `DROP INDEX` verweigert die Datenbank;
  Namen mit `"` in einer Spaltenliste und Namen mit Leerraum am Rand; die Reihenfolge eines zusammengesetzten
  Primärschlüssels wird in Spaltenreihenfolge gelesen; eine Vorgabe, die auf `;` endet, zerschneidet ihre
  Anweisung (Fehler der Datenbank, nichts läuft); scheitert `COMMIT` selbst (Verbindung weg), sagt der Bericht
  „zurückgerollt“, obwohl es niemand weiß; der Dialog ist modal – zwei Läufe zugleich auf der Sitzung `sc-ddl`
  sind nicht vorgesehen.
- **Primärschlüssel ändern** an einer bestehenden Tabelle: Hinweis statt Anweisung (der Plan ist dann
  unvollständig).
