# Design 027: Sortieren und Filtern

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/sortieren-filtern` · Auftrag: [027-sortieren-filtern.md](027-sortieren-filtern.md) · Feature D5

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Tabellen-Ansicht | „Daten öffnen“ im Baum und in „Springen zu allem“ öffnet einen Tab, dessen `SELECT` die App schreibt (`QueryTab.tableView`). Das `SELECT` steht lesbar im Editor (Werte als Literale) – wer es dort ändert und ausführt, hat wieder einen gewöhnlichen Abfrage-Tab: das ist die Übergabe. Nach einem Neustart ist der Tab ein Abfrage-Tab mit diesem Text | kein zweites Tab-Format in der Sitzung |
| E2 | Wer baut das SQL? | **Das Backend** (`db/filter.rs`, rein): Bezeichner nur über `meta::quote`, jeder Wert ein Platzhalter. Das Fenster bekommt `{ sql, params, display }` und führt `sql` + `params` über `run_query` aus (Schutz, Strom, Abbruch wie jede Anweisung). `display` wird nur gezeigt | Architekturregel „Bezeichner quotet nur Rust“; Akzeptanzkriterium 1 |
| E3 | Typen der Werte | **PostgreSQL** vergleicht streng: jeder Wert wird als Text gebunden und im Text auf den Typ der Spalte gecastet (`CAST($1 AS uuid)`; der Typname stammt aus dem Ergebnis und wird nur geschrieben, wenn er wie einer aussieht). **MySQL, SQL Server, SQLite** wandeln selbst: Zahlen als Zahlen, sonst Text. `LIKE`/„enthält“ auf Nicht-Text-Spalten über `CAST(spalte AS text)` | sonst „operator does not exist: uuid = text“ |
| E4 | Operatoren | `=`, `≠`, `<`, `≤`, `>`, `≥`, enthält (Wildcards im Wert sind Zeichen: `ESCAPE '!'`), `LIKE`, `NOT LIKE`, `IN` (Liste), zwischen, `IS NULL`, `IS NOT NULL`; verknüpft mit UND oder ODER | |
| E5 | Freies `WHERE` | ein Feld für eine Bedingung als SQL – der eigene Text des Nutzers wie im Editor, mit `AND` angehängt und geklammert. Muss **ein** Ausdruck sein: `;` und Kommentare lehnt das Backend ab. Ohne Vervollständigung | siehe „Nicht umgesetzt“ |
| E6 | `NULLS FIRST/LAST` | wo es das gibt (PostgreSQL, SQLite) wörtlich, sonst als Sortierschlüssel davor (`CASE WHEN c IS NULL THEN …`). Der Klick auf den Kopf lässt es beim Verhalten der Datenbank | |
| E7 | Grenze | Zeilen höchstens: 200 / 1000 (Vorgabe) / 10 000 / 100 000 / alle; `LIMIT`, in SQL Server `TOP (n)`. Gelesen wird im Strom wie jede Abfrage: die ersten Zeilen sofort, Abbruch jederzeit | Akzeptanzkriterium 2 |
| E8 | Sortieren | Klick auf den Kopf: auf, ab, aus; mit Umschalt/Strg/Cmd kommt die Spalte zu den anderen. Marke im Kopf (`▲`, bei mehreren mit Rang). Tabellen-Ansicht: `ORDER BY` auf dem Server. Jedes andere Ergebnis: im Ergebnisspeicher (E9) | |
| E9 | **Lokal sortieren und filtern** | eine **Sicht** im Speicher (`ResultStore::derive`): eine Liste von Zeilennummern, keine Kopie. Sie hat eine Id wie ein Ergebnis – Fenster, Kopieren, Export und Wert-Ansicht lesen sie unverändert. Textfilter über alle oder eine Spalte, ohne Groß/Klein. Ein Job mit Abbruch | |
| E10 | **10 Mio. Zeilen lokal sortieren?** (Entscheidungsfrage) | **Grenze mit Hinweis**: sortiert wird bis 5 Mio. Zeilen (die Schlüssel liegen im Speicher), darüber `too_large` – „auf dem Server sortieren“. Filtern bis 50 Mio. Kein externes Sortieren | wer 10 Mio. Zeilen ordnen will, hat eine Datenbank dafür |
| E11 | **Vergleich lokal gegenüber Server** (Entscheidungsfrage) | Lokal: Zahlen nach Wert, Text nach seinen Zeichen ohne Groß/Klein (keine Kollation – `Ä` hinter `z`), NULL immer zuletzt. Kenntlich: Die lokale Zeile sagt „hier sortiert“ und trägt den Hinweis (ⓘ) mit genau diesem Satz; die Statuszeile zählt weiter die Zeilen der Abfrage, die Filterzeile „2 von 3 400“ | lokal ist nie „wie die Datenbank“ – also sagen |
| E12 | Schnellfilter aus der Zelle | `FILTER_CELL_EQ` (`Mod+K Mod+E`), `…_NE`, `…_GT`, `…_LT`, `…_NULL`, im Kontextmenü „Nach dieser Zelle filtern“. NULL-Zelle: „nur dieser“ = `IS NULL`. Nur in Tabellen-Ansichten; ein Wert über 4 KB oder binär ist keiner zum Filtern | |
| E13 | Merken | Filter und Sortierung je Tabelle (`connection|schema.tabelle`, die letzten 200) in den Einstellungen; beim Öffnen wieder da, mit Marke „gefiltert“ und „Zurücksetzen“ (`FILTER_RESET`, `Mod+K Mod+R`). Passt ein gemerkter Filter nicht mehr zur Tabelle, öffnet sie ungefiltert | |
| E14 | Filterzeile | über dem Ergebnis: Bedingungen als Spalte/Operator/Wert, alles Formularfelder mit Namen, `Enter` wendet an. Die lokale Zeile erscheint mit `TOGGLE_FILTER_BAR` (`Mod+Alt+F`) oder sobald lokal sortiert wird | vollständig per Tastatur |

## Verträge

`table_query(id, query) → { sql, params, display }`; `result_view(job_id, result_id, { text, column?, sort[] }) →
{ resultId, rows }` (abbrechbar mit `cancel_job`, Ids ab 2 000 000 000); eine Sicht wird mit `free_results`
freigegeben und geht mit ihrem Ergebnis.

## Geprüft

- **Rust, Erzeuger** (13 Tests, drei davon aus dem Review): Katalog je Dialekt (Platzhalter, Casts, `TOP`/`LIMIT`, NULLS), ODER und freie
  Bedingung, **Katalog böser Werte** (13 Werte × 10 Operatoren × 3 Arten × 4 Datenbanken: in der Anweisung steht
  nie etwas vom Wert, der Wert steht ganz in den gebundenen Parametern), Namen mit Anführungszeichen und `;`,
  Typnamen, die keine sind, unvollständige Bedingungen.
- **Rust, Sichten**: filtern, sortieren (Zahlen, Text, NULL, mehrere Schlüssel, stabil), Sicht einer Sicht,
  Abbruch, Freigabe, 200 000 Zeilen.
- **Fenster**: reine Logik; Tab (gebaute Anweisung mit gebundenen Werten, Ende der Tabellen-Ansicht, abgelehnte
  Bedingung, Schnellfilter, lokale Sicht und ihre Freigabe, zu großes Ergebnis); Filterzeile.
- **Im Browser** (Backend nachgestellt): Tabelle als Tabellen-Ansicht, Klick auf `total`, Umschalt-Klick auf `name`
  (Marken `▲1`, `▲2`, `ORDER BY total, name`), Zelle wählen und `Cmd+K Cmd+E`: Bedingung `city = …` erscheint in der
  Zeile, „gefiltert“, an der Brücke ein Platzhalter und der Wert getrennt; `Cmd+Alt+F` und Tippen: lokale Sicht,
  „2 von 4“.
- **Review** durch einen zweiten Agenten, der den Code nicht geschrieben hat: siehe unten.

## Nicht umgesetzt, nicht geprüft

- **Das native Fenster** wurde nicht bedient; **100 Mio. Zeilen** auf einem Server nicht gemessen – die
  Tabellen-Ansicht läuft über denselben Strom wie jede Abfrage (006, dort gemessen), `WHERE`/`ORDER BY` macht der
  Server.
- **Gegen echte Server** lief der Erzeuger nicht (nur der Katalog); die Platzhalter und Casts sind dieselben, die
  025 gegen alle vier Server geprüft hat, bis auf `CAST($n AS <typ der spalte>)` für beliebige Typen.
- Freies `WHERE` ohne Vervollständigung; **benannte Filter**; Spaltenauswahl im `SELECT` (immer `*`).
- Schnellfilter in freien Abfrage-Ergebnissen (dort gibt es den lokalen Filter).
- Lokale Sicht: kein Sortieren über 5 Mio. Zeilen, keine Kollation, Vergleich über die in der Zeile gekürzten Werte
  (lange Texte ab 32 768 Zeichen nur bis dorthin).
- Die Tabellen-Ansicht übersteht einen Neustart nicht als solche (E1).

## Review (zweiter Agent, nur lesend)

| Befund | Schwere | Was getan wurde |
|---|---|---|
| **Typname im `CAST`**: `castable` prüfte nur Zeichen. Ein Typ namens `int4) or exists(select pg_reload_conf()` – den jeder mit `CREATE TYPE "…"` anlegen oder ein gemerkter Filter mitbringen kann – wäre als SQL gelaufen | mittel | **behoben**: geprüft wird die Form (Name, bis zu drei weitere Wörter, Größe `(12,2)`, `[]`); alles andere wird nicht geschrieben. Roter Test zuerst (12 böse, 8 gute Namen) |
| **Freie Bedingung** konnte ihre Klammer schließen (`1=1) UNION SELECT … WHERE (1=1`), in MySQL mit `#` den Rest verstecken, und mit `?`/`$1` einen gebundenen Wert greifen | niedrig (dieselbe Macht wie im Editor – aber nicht „ein Ausdruck“) | **behoben**: ein Durchlauf, der Strings und gequotete Namen überspringt: Klammern müssen aufgehen, kein `;`, kein Kommentar (auch `#`), kein Platzhalter. `;` und `--` **in** einem String sind jetzt erlaubt |
| **Lesbare Form** (`display`): ein Wert mit `\` konnte auf einem PostgreSQL mit `standard_conforming_strings = off` sein Literal verlassen, wenn man den Text von Hand ausführt | niedrig | **behoben**: solche Werte als `E'…'` mit verdoppeltem Backslash. Was läuft, war nie betroffen (gebunden) |
| Werte, Namen, `limit`, Operatoren; `display` wird nie ausgeführt; der Schutz (012) sieht die gebaute Anweisung | kein Befund | – |
| `LIKE` mit eigenem Muster hat kein `ESCAPE`: der Backslash wirkt je Datenbank verschieden | niedrig, kein Einschleusen | so gelassen: das Muster ist das des Nutzers; „enthält“ ist überall gleich |
| Filterwerte stehen als Literale in der gezeigten Anweisung und damit im Verlauf | Hinweis | so gelassen und hier genannt: der Verlauf notiert Anweisungen, wie sie gezeigt werden (Parameterwerte aus 025 dagegen nicht) |
