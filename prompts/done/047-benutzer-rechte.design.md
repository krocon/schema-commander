# Design 047: Benutzer und Rechte

> **Status:** umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/benutzer-rechte` · Auftrag: [047-benutzer-rechte.md](047-benutzer-rechte.md) · Feature H2

## Entscheidungsfragen

- **Nur lesend zuerst?** Nein: Lesen und Ändern in einem Schritt. Das Ändern ist klein gehalten (eine Liste
  von Änderungen, die das Backend zu Anweisungen macht) und teilt Schutz und Lauf mit „Struktur bearbeiten“ (043).
- **Umfang je Datenbank** – siehe E1 und „Nicht umgesetzt“.

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Lesen | `db/access.rs`. **PostgreSQL**: Rollen mit Attributen und Mitgliedschaften (`pg_roles`, `pg_auth_members`); Rechte aus den ACLs (`aclexplode`) auf Datenbank, Schema, Tabelle/View, Spalte, Sequenz, Routine, dazu Vorgabe-Rechte (`pg_default_acl`) und Besitz (`OWNER`). **MySQL/MariaDB**: `mysql.user`, Mitgliedschaften aus `role_edges` bzw. `roles_mapping`, Rechte aus `information_schema` (`USER_`/`SCHEMA_`/`TABLE_`/`COLUMN_PRIVILEGES`). **SQL Server**: Prinzipale und Rollen der Datenbank, `sys.database_permissions` (auch `DENY`). SQLite: entfällt | Aufgabe 1 |
| E2 | Herkunft | Zu jedem Recht steht, **über wen** es kommt: leer = selbst, sonst die Rolle (rekursiv über alle Mitgliedschaften), `PUBLIC` für alle | Aufgabe 2 |
| E3 | Sichten | je Benutzer/Rolle: die **Matrix** Tabellen eines Schemas × Rechte (Haken = selbst gehalten, `↑` = über eine Rolle, mit Tooltip) und die **Liste aller Rechte** mit Ebene und Herkunft. Je Objekt: der Abschnitt „Rechte“ der Objekt-Details aus 019 (unverändert) | Aufgabe 2 |
| E4 | Ändern | Das Fenster sendet **Änderungen** (`Change`: anlegen, löschen, Passwort, Attribut, Mitgliedschaft, Recht geben/nehmen), nie SQL. `access::plan` schreibt die Anweisungen: Namen gequotet im Backend, Rechte nur aus festen Listen je Datenbank und Ebene (`privileges.json`, von beiden Seiten gelesen), Attribute nur aus einer Liste | Aufgabe 3, Regel „Bezeichner quotet nur Rust“ |
| E5 | Sammeln | Änderungen warten in einer Liste; die Vorschau zeigt die Anweisungen des Backends. Das Gegenteil einer wartenden Änderung nimmt sie zurück | Aufgabe 3 |
| E6 | Schutz | `access_apply` schreibt die Anweisungen neu, lässt **jede** in ihrer gezeigten Form durch `admit` (GRANT/REVOKE/DROP sind „gefährlich“) und führt sie auf eigener Sitzung aus – in einer Transaktion, wo die Datenbank das zurückrollt (PostgreSQL, SQL Server), sonst einzeln mit Hinweis | Aufgabe 3, Regeln aus 012 |
| E7 | Passwort | kein Teil der Änderung: Es reist neben ihr (`passwords[i]`), als `Secret` (wird beim Freigeben gelöscht). In allem, was gezeigt wird, steht `'***'`; die echte Anweisung entsteht erst beim Lauf (`Zeroizing`). **PostgreSQL bekommt einen SCRAM-SHA-256-Prüfwert** (wie `psql \password`): Der Server sieht das Passwort nie und kann es nicht protokollieren. MySQL/SQL Server: als Literal des Dialekts (MySQL nach `sql_mode`, mit oder ohne Backslash-Escape) – mit Hinweis im Dialog, dass der Server die Anweisung protokollieren kann. Fehler werden bereinigt (`scrubbed`), bevor sie das Fenster erreichen | Aufgabe 4 |
| E8 | Nirgends sonst | Der Weg läuft nicht über `run_query`: kein Eintrag im Verlauf, nichts in der Sitzung, kein Log | Aufgabe 4, Akzeptanzkriterium 2 |
| E9 | Vergleichen/Kopieren | „Rechte als Skript“ (die selbst gehaltenen Rechte als `GRANT`s in einem neuen Tab) und „Rechte wie …“ (was der andere selbst hält und hier fehlt, als wartende Änderungen) | Aufgabe 5 |
| E10 | Gefahren | je Anweisung markiert: gibt jedes Recht (Superuser, `db_owner`), alle Rechte auf einmal (`ALL`, `CONTROL`), darf weitergeben, lässt sich nicht zurücknehmen (`DROP`), **kann Sie aussperren** – wenn dem Benutzer der Verbindung oder einer Rolle, in der er ist, etwas genommen wird | Aufgabe 6 |
| E11 | Ohne Rechte | `canManage` (PostgreSQL: Superuser oder `CREATEROLE`; MySQL: `CREATE USER`; SQL Server: `db_owner`, `db_securityadmin`, `sysadmin`). Ohne es – und auf einer Verbindung „nur lesen“ – ist alles sichtbar und nichts änderbar. Was nicht lesbar ist, steht mit dem Grund der Datenbank da | Akzeptanzkriterium 3 |
| E12 | Ansicht | ein Dialog, einfache Tabellen (wie 046): Die Matrix hat Kästchen in jeder Zelle – Formularelemente, die Tastatur und Screenreader von sich aus bedienen | Abweichung von „GuiExpert Table“, siehe unten |

## Was die Datenbanken zeigten

- **PostgreSQL** löscht keine Rolle, die noch ein Recht hält („some objects depend on it“): erst nehmen, dann
  löschen. Rollennamen haben die Sortierung `C` – die rekursive Abfrage brauchte `COLLATE "default"`.
- **MySQL**: Ein Recht über eine Rolle gilt erst, wenn die Rolle aktiv ist (`SET ROLE`, Vorgabe-Rolle); der
  Dialog sagt das. Ohne ein eigenes Recht in einer Datenbank lässt MySQL niemanden hinein.
- **MariaDB**: Rollen haben keinen Host (`CREATE ROLE 'r'`), MySQL-Rollen sind Konten mit Host. Wer antwortet,
  sagt die Version des Servers.
- **MySQL 8** kennt keine Rollen-Spalte: Als Rolle gilt ein gesperrtes Konto ohne Passwort, dessen Passwort
  abgelaufen ist (so legt `CREATE ROLE` sie an).

## Geprüft

- `pnpm check` grün. Rust: 16 Tests in `db/access_tests.rs` – Anweisungen je Datenbank und Ebene, böse Namen
  bleiben Namen, Abgelehntes (kein Name, kein Recht der Liste, SQL im Attribut), Gefahren, **ein Passwort steht
  in nichts Gezeigtem** und in keinem Fehler, MySQL nach `sql_mode`, PBKDF2 gegen den bekannten Vektor, die
  Rechte-Liste ist die des Fensters.
- **Container** (`pnpm rust:test:db`, 51 Tests): `rights_are_read_as_they_work` auf PostgreSQL, MySQL, MariaDB,
  SQL Server – Rolle und Benutzer mit Passwort anlegen, Recht direkt und über die Rolle; die Lesung zeigt beides
  mit Herkunft; **angemeldet als der Benutzer** (mit dem gesetzten Passwort, bei PostgreSQL also über den
  SCRAM-Prüfwert): `SELECT` und `INSERT` gehen, `DELETE` nicht; ohne Verwaltungsrechte ist `canManage` aus;
  genommenes Recht ist fort; neues Passwort gilt, das alte nicht mehr.
- Frontend: `access-logic.spec.ts` (10), `access-dialog.spec.ts` (15): Matrix mit Herkunft, sammeln und
  zurücknehmen, Rückfrage des Schutzes, Passwort in nichts Sichtbarem und nach dem Lauf fort, Gefahren,
  „Rechte wie“, Skript, ohne Verwaltungsrechte und „nur lesen“ nichts änderbar, Text statt Markup.
- **Browser** (Dev-Server, Backend nachgestellt): Liste, Matrix mit `↑` und „Besitzer“, drei Änderungen als
  Anweisungen, Passwort weder im DOM noch in `access_plan` noch in `check_statements`, nur in `access_apply`
  neben seiner Änderung; nach dem Lauf fort. `<b>` im Namen bleibt Text.
- Ein Fehler der Probe: „Neu lesen“ blieb gesperrt (ein Zähler für zwei Fragen) – roter Test, behoben.

## Review (zweiter Agent, nur lesend)

Kein Befund „hoch“; vier „mittel“, sechs „niedrig“. Sauber: der SCRAM-Prüfwert (Format, Salz), das Quoting, dass
jede Anweisung vor der ersten durch `admit` geht, kein Log/Verlauf auf dem Weg, Text statt Markup im Fenster.

| Nr. | Befund | Behoben |
|---|---|---|
| M1 | `ALTER ROLE … SUPERUSER`, `CREATE USER`, `ALTER LOGIN … PASSWORD` galten dem Schutz als DDL: auf einer freien Verbindung ohne Rückfrage, obwohl als gefährlich markiert | `guard`: `CREATE`/`ALTER` von `ROLE`/`USER`/`LOGIN` ist „gefährlich“ wie `GRANT` (Katalog erweitert) |
| M2 | Ein Fehler des Servers zitiert die Anweisung in der maskierten Schreibung (`pa''ss`): Die Suche nach dem Passwort fand das nicht | Scheitert eine Anweisung mit Passwort, bleibt vom Fehler nur der Code der Datenbank (`scrubbed`, Test mit `'` im Passwort) |
| M3 | „Der Server bekommt einen Prüfwert“ stand auch da, wenn ein PostgreSQL-Passwort (nicht ASCII) als Text ging | Der Dialog verspricht es nur, wenn jedes wartende Passwort als Prüfwert reisen kann (`travelAsVerifier`) |
| M4 | Nicht markiert: `CREATEROLE`/`REPLICATION`, Mitgliedschaft in einer Rolle, die alles darf (`pg_*`, `db_securityadmin`, Superuser-Rollen), MySQL `CREATE USER`/`RELOAD`/`PROCESS` und Rechte im Schema `mysql`, SQL Server `ALTER` auf der Datenbank | neue Gefahr „reicht weiter, als es aussieht“; die mächtigen Rollen liest `context` vom Server |
| L5 | Aussperren: eigenes Passwort, Namen in anderer Schreibung, `public` | markiert; Vergleich ohne Groß/Klein |
| L6 | `sql_mode` wurde auf einer anderen Sitzung gelesen als der, die ausführt | `access_apply` liest den Kontext auf der ausführenden Sitzung und führt nur aus, wenn die Anweisungen dieselben sind wie die gezeigten und geprüften |
| L7 | „Ausführen“ konnte eine Änderung mitnehmen, deren Anweisung noch nicht gezeigt war | es läuft nur der Plan, der für genau diese Änderungen geschrieben ist; währenddessen ist der Knopf aus |
| L8 | Passwörter blieben nach einem gescheiterten Lauf in der Liste | Änderungen mit Passwort fallen nach einem Fehler heraus, mit Hinweis |
| L10 | Ein Rollenname mit Zeilenumbruch im Kopfkommentar des Skripts | Steuerzeichen werden im Kopf zu Leerzeichen |

Nicht behoben (L9): Zwischenwerte der SCRAM-Rechnung und Kopien der Treiber werden nicht eigens gelöscht; die
Anweisung selbst und das Passwort schon. `standard_conforming_strings = off` (PostgreSQL, seit 9.1 nicht mehr
Vorgabe) wird nicht geprüft. Scheitert das Lesen der eigenen Rollen, fehlt die Markierung „kann Sie aussperren“.

## Nicht geprüft

- Das native Fenster wurde nicht bedient.
- CockroachDB und TimescaleDB gegen die Container (CockroachDB liest nur Rechte auf Tabellen und bekommt das
  Passwort als Text; gebaut, nicht gelaufen).
- SQL Server älter als 2017 (`STRING_AGG`), MySQL 5.7 (keine Rollen).

## Nicht umgesetzt

- **Matrix als GuiExpert Table** und je Objekt als eigene Matrix: einfache Tabellen; je Objekt bleibt der
  Abschnitt „Rechte“ aus 019.
- Rechte auf **Routinen** ändern (gelesen werden sie), Vorgabe-Rechte ändern, `REVOKE GRANT OPTION FOR` allein.
- **Row-Level-Security**-Richtlinien, Azure-AD-/Windows-Benutzer anlegen, Server-Logins und Server-Rollen von
  SQL Server als eigene Liste (gezeigt werden die Prinzipale der Datenbank; `CREATE LOGIN` nur zusammen mit dem
  Benutzer), Ablauf/Sperre eines Kontos, Ressourcen-Limits von MySQL.
- SASLprep: Ein PostgreSQL-Passwort mit Zeichen außerhalb von ASCII geht als Text an den Server (der es selbst
  hasht). Der Dialog verspricht den Prüfwert deshalb nur, wenn jedes wartende Passwort als Prüfwert reisen
  kann, und warnt sonst vor dem Protokoll des Servers.
