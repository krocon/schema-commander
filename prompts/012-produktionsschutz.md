# Prompt 012: Schutz für Produktion

> **Slug:** `produktionsschutz` · **Feature:** A4 · **Braucht:** 003, 005 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`, `docs/best-practices.md` §6. Vorbild: TablePlus (Safe Mode, farbige
> Verbindung), DataGrip (Read-only, Warnung bei `DELETE` ohne `WHERE`).

## Ziel

Niemand ändert aus Versehen Produktionsdaten: Eine Verbindung lässt sich als **geschützt** markieren; das Fenster
zeigt es unübersehbar, und schreibende oder zerstörende Anweisungen brauchen eine Bestätigung – durchgesetzt im
Backend.

## Aufgaben

1. **Schutzstufen je Profil**: `frei`, `nachfragen` (jede schreibende Anweisung bestätigen), `nur lesen`. Dazu ein
   Kennzeichen (Text wie „PROD“) und die Farbe.
2. **Einstufen von Anweisungen** in Rust (reine Funktion, Katalog je Dialekt): lesend / schreibend / DDL / gefährlich
   (`UPDATE`/`DELETE` ohne `WHERE`, `TRUNCATE`, `DROP`, `ALTER … DROP`, `GRANT`/`REVOKE`), unbekannt = schreibend.
   CTEs mit `INSERT … RETURNING`, `SELECT … INTO`, Funktionsaufrufe, `EXPLAIN ANALYZE` einer schreibenden Anweisung
   richtig behandeln.
3. **Durchsetzen**: Der Ausführ-Command lehnt ohne Bestätigungs-Token ab (`confirmation_required` mit Einstufung und
   betroffenen Anweisungen). `nur lesen` zusätzlich auf dem Server (`SET default_transaction_read_only`,
   `START TRANSACTION READ ONLY` bzw. Entsprechung), wo es geht.
4. **Gefährliches überall** (auch auf freien Verbindungen, abschaltbar): `UPDATE`/`DELETE` ohne `WHERE` fragt nach.
5. **Sichtbarkeit**: farbiger Rahmen bzw. Leiste des Tabs, Badge in Toolbar und Statuszeile
   (`--badge-danger-*`); der Bestätigungsdialog nennt Verbindung, Datenbank und die Anweisung; bei „gefährlich“ muss
   der Name der Verbindung getippt werden.
6. Optional je Profil: Auto-Commit aus, Zeitlimit, maximale Zeilenzahl für `UPDATE`/`DELETE` vorab schätzen
   (Zusammenspiel mit Prompt 013).

## Entscheidungsfragen (Design)

- Einstufen über einen echten SQL-Parser (crate, Dialektabdeckung) oder eigenen Tokenizer mit „im Zweifel
  schreibend“? Fehlklassifikation „schreibend als lesend“ darf es nicht geben.
- Gilt die Bestätigung je Anweisung, je Skriptlauf oder für eine kurze Zeitspanne?

## Akzeptanzkriterien

- Auf einer „nur lesen“-Verbindung scheitert jeder Schreibversuch, auch über Umwege (CTE, Funktion, Skript mit
  mehreren Anweisungen, Bearbeiten im Gitter).
- `DELETE FROM kunde` ohne `WHERE` fragt nach; mit `WHERE` auf einer freien Verbindung nicht.
- Der Schutz ist nicht durch Aufrufe am Frontend vorbei auszuhebeln (Test auf Command-Ebene).

## Tests und Review

Rein: Einstufungs-Katalog je Dialekt mit Tricks (Kommentare, Groß-/Kleinschreibung, `WITH`, mehrere Anweisungen in
einer Zeile). **Review durch einen zweiten Agenten** mit dem Auftrag, den Schutz zu umgehen.
