# Design 012: Schutz für Produktion

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/produktionsschutz` · Auftrag: [012-produktionsschutz.md](012-produktionsschutz.md) · Feature A4

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Parser oder eigener Scanner? | **eigener Scanner** (`db/guard.rs`, rein) mit der Regel „im Zweifel schreibend“: er muss nur in einer Richtung stimmen | kein Parser deckt vier Dialekte samt ihrer Eigenheiten ab; ein Parser, der eine Anweisung nicht versteht, hilft nicht. Lesend ist nur, was mit einem Lese-Wort beginnt **und** kein Schreib-, DDL- oder Zerstör-Wort enthält, keine verdächtige Funktion ruft und eindeutig zu lesen ist |
| E2 | Stufen | `read` < `write` < `ddl` < `dangerous` (`UPDATE`/`DELETE` ohne eigenes `WHERE` – auch in einer CTE –, `TRUNCATE`, `DROP`, `ALTER … DROP`, `GRANT`, `REVOKE`, `DENY`, und Text, den `EXEC`/`DO`/`PREPARE` ausführen und der so etwas enthält). Ein Text mit mehreren Anweisungen hat die Stufe seiner schlimmsten | Auftrag |
| E3 | Mehrdeutiges | Ein Backslash vor einem Anführungszeichen, `U&'…'`, in MySQL ein `"…"` mit `;` darin: der Text ist je nach Einstellung des Servers verschieden zu lesen (`standard_conforming_strings`, `NO_BACKSLASH_ESCAPES`, `ANSI_QUOTES`) → **nie lesend** | die Einstellung kennen wir nicht; der Prüfer kam genau damit durch |
| E4 | Schutz je Profil | `protection`: `free` (nur Zerstörendes fragt), `ask` (alles außer Lesen fragt; Zerstörendes verlangt den getippten Namen der Verbindung), `readonly` (nichts außer Lesen läuft); dazu `label` (bis 12 Zeichen, z. B. `PROD`) | Auftrag |
| E5 | Durchsetzen | `run_query` ruft `ConnectionManager::admit`: ohne passendes **Token** kommt `confirmation_required`, auf `readonly` `permission_denied`. Ein Token gibt nur `confirm_statements` aus – gebunden an genau diese Anweisung auf genau dieser Verbindung, einmal gültig, 10 Minuten; für Zerstörendes auf geschützten Verbindungen nur, wenn der Name stimmt. `export_query` führt nur Lesendes aus | der Schutz sitzt im Backend; ein Fenster, das die Rückfrage überspringt, bekommt kein Token (Tests auf Manager-Ebene) |
| E6 | Nur lesen auf dem Server | beim Öffnen: `SET default_transaction_read_only = on` (PostgreSQL), `SET SESSION TRANSACTION READ ONLY` (MySQL/MariaDB), `PRAGMA query_only = ON` (SQLite). Scheitert das, wird die Verbindung nicht geöffnet. **SQL Server kennt das nicht** | zweite Verteidigungslinie; was sie abschalten könnte (`SET`, `PRAGMA … =`, `BEGIN READ WRITE`, `set_config`), stuft der Scanner als schreibend ein |
| E7 | Wie lange gilt ein Ja? | **je Lauf**: vor einem Skript fragt ein Dialog einmal und nennt alle betroffenen Anweisungen; jede bekommt ihr eigenes Token | eine Zeitspanne wäre ein offenes Fenster |
| E8 | Gefährliches überall | auch auf freien Verbindungen fragt Zerstörendes nach; abschaltbar (`confirmDangerous`, Aktion `TOGGLE_CONFIRM_DANGEROUS`) – das lockert nie eine geschützte Verbindung | Auftrag |
| E9 | Sichtbarkeit | Kennzeichen (`--badge-danger-*`) in Toolbar, Statuszeile und Tab; der Dialog hat einen roten Rahmen, nennt Verbindung, Datenbank und Anweisungen; der Fokus liegt auf „Abbrechen“ bzw. dem Namensfeld, nie auf „Ausführen“ | ein gewohnheitsmäßiges Enter führt nichts aus |
| E10 | Abbrechen während der Prüfung | ein Lauf, der noch geprüft oder bestätigt wird, lässt sich abbrechen, bevor etwas gesendet wurde | sonst ginge `Mod+.` in dieser Phase verloren |

## Review durch einen zweiten Agenten

Auftrag: die Einstufung umgehen. Er fand in der ersten Fassung über 70 Texte, die als lesend galten und schrieben
oder den Schutz abschalteten – unter anderem: `LIKE'\'` (das `E` von `LIKE` wurde für einen E-String gehalten),
verschachtelte Kommentare in T-SQL, `--` ohne Leerzeichen und `#` in MySQL, `/*M! … */` in MariaDB, Funktionen in
Anführungszeichen (`"set_config"(…)`), `BEGIN READ WRITE`, `COMMIT PREPARED`, `PRAGMA query_only = integrity_check`,
`\r` als Zeilenende eines Kommentars, T-SQL-Anweisungen hinter einem `SELECT` ohne `;`, eine Reihe `pg_*`-Funktionen.
Der Scanner wurde daraufhin neu geschrieben (Token für Namen in Anführungszeichen und Strings, Regel E3,
Transaktionsanweisungen nur aus einer Wortliste, `pg_`/`lo_`/`dblink`/`sys_`/`xp_`/`sp_` als Präfixe mit einer kleinen
Liste lesender Ausnahmen); alle seine Fälle stehen als Test `the_bypasses_of_the_review_are_closed` im Katalog.
**Die neue Fassung wurde nicht noch einmal angegriffen.**

## Was bleibt (ehrlich)

- **Eigene Funktionen**: `SELECT meine_funktion()` gilt als lesend. Auf `readonly` hält PostgreSQL/MySQL sie auf dem
  Server auf; auf `ask` läuft sie ohne Rückfrage; auf **SQL Server** gibt es keine zweite Linie.
- **SQL Server**: Ein Batch braucht kein `;`. Hinter einer lesenden Anweisung erkennt der Scanner eine zweite nur an
  bekannten Wörtern; die Liste kann nicht vollständig sein. Wer dort sicher sein will, nimmt einen Login, der nur
  lesen darf. `DELETE FROM t SELECT 1 WHERE …` gilt als begrenzt (das `WHERE` gehört der nächsten Anweisung).
- `DELETE … WHERE true` und Ähnliches gilt als begrenzt.
- Zu streng ist erlaubt und kommt vor: `SELECT … FOR UPDATE`, `SELECT REPLACE(a, …)`, eine Spalte namens `set` ohne
  Anführungszeichen, ein Backslash vor einem Anführungszeichen in einem String gelten als schreibend.
- Auto-Commit aus, Zeitlimit und geschätzte Zeilenzahl je Profil (Aufgabe 6, optional): Prompt 013.
- „Bearbeiten im Gitter“ gibt es noch nicht; es muss durch denselben `admit` (Prompt 019).

## Geprüft

- Rust: Katalog je Dialekt (über 200 Texte), die Regel je Schutzstufe, Tokens (falsches, fremdes, verbrauchtes,
  falscher Name), eine SQLite-Datei als `readonly`-Verbindung (der Server lehnt Schreiben ab).
- Frontend: Lauf mit Rückfrage (ein Dialog je Skript, Token je Anweisung, Nein führt nichts aus, falscher Name
  scheitert am Backend), Dialog als Komponententest.
- Im Browser mit nachgebildetem Backend: Dialog, Kennzeichen in Toolbar, Statuszeile, Tab.

## Nicht geprüft

- `readonly` gegen PostgreSQL und MySQL (die Container liefen nicht); das native Fenster.
- Im Browser-Versuch schloss der Dialog nach getipptem Namen und Enter nicht; der Komponententest desselben Wegs
  ist grün. Ich habe nicht geklärt, ob meine Eingabe im Versuch überhaupt im Feld ankam.
