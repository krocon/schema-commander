# Design 025: Parameter in Abfragen

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/parameter` · Auftrag: [025-parameter.md](025-parameter.md) · Feature C8

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Wo wird erkannt und umgeschrieben? | Im Fenster, als reine Funktion (`features/params/param-logic.ts`, auf dem Tokenizer aus 021): Der Dialog braucht die Namen, bevor irgendetwas gesendet wird. Das Backend bekommt die Anweisung mit den Platzhaltern des Treibers und die Werte getrennt | eine Stelle, ein Katalog |
| E2 | Formen | `:name`, `${name}`, `?`, `$1`, `$name`, `@name`. **Vorgaben je Datenbank** – ausgelassen, wo das Zeichen dort etwas anderes heißt: PostgreSQL ohne `?` (JSON-Operator), `@name`, `$name`; MySQL und SQL Server ohne `@name` (Variablen) und `$…`; SQLite alles außer `$1`. **Je Verbindung einstellbar** im Dialog selbst (Einstellung `paramForms`, nach Verbindungs-Id); global abschaltbar (`paramsEnabled`) | „einstellbar je Profil“ ohne das Profil-Format im Backend zu ändern |
| E3 | Was ist keiner? | Alles in Strings, Kommentaren, gequoteten Namen, Dollar-Quotes; `::typ`, `:=`, `arr[1:n]`, Uhrzeiten, `@@global`, `?|` `?&` `??`, ein Zeichen ohne Namen direkt dahinter; mit eingeschaltetem `@name` nicht, was die Anweisung selbst deklariert (`DECLARE @x`) oder zuweist (`SET @x`, `@x :=`). Katalog mit 21 Fällen je Dialekt | Akzeptanzkriterium 2 |
| E4 | **Typ raten oder wählen?** (Entscheidungsfrage) | Beides, sichtbar: Vorgabe „Automatisch“ liest den Typ am Text ab – aber nur, was eindeutig so geschrieben ist (`42`, `3.14`, `true`, `2026-11-11`); `0123` bleibt Text (Postleitzahl), `1` eine Zahl, `11.11.2026` Text. Unter dem Feld steht, als was der Wert gelesen wird. Wählbar: Text, Zahl, Datum (auch `11.11.2026 12:30`), Ja/nein, Liste, NULL. In `IN (:ids)` ist „Automatisch“ eine Liste. Kein `PREPARE`/Describe: vier verschiedene Verhalten und ein Eingriff in die Sitzung | kein unsichtbares Raten |
| E5 | Binden | Neue Methode `Session::execute_bound(sql, &[Bind], …)` in allen vier Treibern; `execute` ist sie ohne Werte. `Bind`: `text`, `int`, `decimal`, `bool`, `date`, `datetime` – Zahlen und Daten reisen als Text. **PostgreSQL** (`$n`, erweitertes Protokoll): ganze Zahlen als `int8`, Dezimalzahlen und Daten als Text mit `CAST($n AS numeric/date/timestamp)` im Text – exakt, ohne Fließkomma. **MySQL/MariaDB** (`?`): `CAST(? AS DECIMAL(65,30))`, `CAST(? AS DATE/DATETIME(6))`. **SQL Server** (`@Pn`, `sp_executesql`): Dezimalzahlen als exaktes `numeric`, Daten mit `CAST`. **SQLite** (`?n`): Zahlen als INTEGER/REAL, der Rest Text | gegen echte Server geprüft |
| E6 | `NULL` und Listen | `NULL` wird als Wort in den Text geschrieben (eine Konstante, kein Wert des Nutzers; ein gebundenes NULL bräuchte in PostgreSQL einen Typ). Eine Liste wird zu so vielen Platzhaltern, wie sie Einträge hat; eine leere zu `NULL` (trifft nichts). Ein Name, der zweimal vorkommt, wird zweimal gebunden | |
| E7 | **„Nur ersetzen“-Modus?** (Entscheidungsfrage) | **Nein.** Tabellennamen einzusetzen wäre genau das Zusammenbauen von SQL aus Eingaben, das dieses Feature vermeidet; dafür gibt es Snippets (024) und `$TABLE` | nie stillschweigend – also gar nicht |
| E8 | Eingabe | Dialog (modal) statt Leiste: ein Feld je Parameter in der Reihenfolge des Vorkommens, letzter Wert des Tabs vorbelegt, Typ daneben, `Enter` führt aus, `Esc` bricht den Lauf ab. Ein Skript fragt einmal für alle Anweisungen. Ein Wert, der nicht zu seinem Typ passt, hält den Dialog offen und wird benannt | vollständig per Tastatur |
| E9 | Merken | je Tab und Name, **nur im Speicher**: Werte sind Daten des Nutzers – sie stehen weder in der Sitzung noch im Verlauf noch in einem Log | Aufgabe 5 |
| E10 | Verlauf, Schutz, Anzeige | Verlauf und Ergebnis-Reiter zeigen die Anweisung, wie sie geschrieben ist (`:kunde`); Schutzprüfung (012) und Treiber bekommen die mit Platzhaltern. Die Meldungen zeigen die Werte (`mit kunde = 42 · ids = (1, 2, 3)`) | |
| E11 | Erneut ausführen | `RUN_AGAIN` (`Mod+Alt+Enter`): die Anweisungen des letzten Laufs mit Parametern, dieselben Werte, keine Frage | Aufgabe 4 |
| E12 | Fehlerstelle | Die Datenbank zählt in der gesendeten Anweisung; die Position wird auf die geschriebene zurückgerechnet (`writtenPosition`), eine Stelle in einem Platzhalter ist der Parameter | sonst läge die Markierung aus 022 daneben |
| E13 | Was die App selbst schreibt | (Tabelle öffnen, „Springen zu“) wird nie nach Parametern durchsucht | |

## Verträge

`run_query(…, params?: Bind[])`; `Bind = { kind: 'text'|'int'|'decimal'|'date'|'datetime', value: string } |
{ kind: 'bool', value: boolean }`; höchstens 2000 Werte. Fassade: `RunGuard.params`.

## Geprüft

- **Gegen echte Server** (`every_server_binds_values`: PostgreSQL, MySQL, MariaDB, SQL Server): Text, ganze Zahl,
  Dezimalzahl mit 16 Stellen (kommt Ziffer für Ziffer zurück), Bool, Datum, Datum mit Zeit, `IN`-Liste;
  `'; DROP TABLE sc_bind; --` als Wert richtet nichts an und wird als Text gefunden. Die ganze Treiber-Suite
  (29 Tests) läuft weiter grün – `execute` geht jetzt durch `execute_bound`.
- **SQLite** (Unit-Test): dasselbe, dazu Zahl der Platzhalter ≠ Zahl der Werte, eine „Zahl“, die keine ist.
- **Rein**: Erkennungs-Katalog, Typen, Listen, Umschreiben je Dialekt, Position zurückrechnen, Beschreibung.
- **Lauf eines Tabs** (`param-run.spec.ts`): einmal fragen, gebunden senden, nichts im Verlauf, Werte merken,
  erneut ausführen, Abbruch, Skripte, abgeschaltet, Fehlerstelle. **Dialog**: Felder, Fokus, Enter, Fehler,
  Formen je Verbindung.
- **Im Browser** (Backend nachgestellt): `Cmd+Enter`, vier Werte nur mit Tastatur, `Enter` – an der Brücke kommt
  `… customer_id = ?1 … IN (?4, ?5, ?6)` mit sechs getrennten Werten an, der Fokus ist wieder im Editor;
  `Cmd+Alt+Enter` führt ohne Dialog erneut aus; die Meldungen zeigen die Werte.

## Nicht umgesetzt, nicht geprüft

- **Das native Fenster** wurde nicht bedient; die Kette Fenster → `run_query` → Treiber ist an der Brücke
  (nachgestellt) und in den Treibern (echte Server) geprüft, nicht in einem Stück.
- Mit Werten ist eine Anweisung **eine** Anweisung (erweitertes Protokoll): mehrere durch `;` getrennte in einem
  Stück lehnt PostgreSQL dann ab – der Lauf zerlegt Skripte ohnehin vorher.
- **SQL Server**: ein Batch mit eigenen `DECLARE`s und gebundenen Werten läuft über `sp_executesql`; temporäre
  Tabellen, die er anlegt, leben nur dort.
- **PostgreSQL `E'…'`-Strings**: der Tokenizer aus 021 kennt deren Backslash nicht – ein `:name` hinter `E'it\'s'`
  kann als im String liegend gelten (dann wird nicht gefragt und die Datenbank meldet den Fehler).
- Leere Liste als `IN (NULL)`: trifft nichts – auch bei `NOT IN` (dort ist das Ergebnis leer, nicht „alles“).
- Datum mit Zeitzone; Binärwerte; Typ aus dem Katalog.
- Werte überleben einen Neustart nicht (E9, Absicht).

## Fortschritt

- [x] Treiber + Tests gegen Container · [x] Logik · [x] Dialog, Lauf · [x] Browser · [x] Doku · [x] `pnpm check`
