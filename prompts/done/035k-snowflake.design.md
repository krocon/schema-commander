# Design 035k: Snowflake

> Durchlauf von [Prompt 035](035-weitere-datenbanken.md) für **Snowflake**. Stand: umgesetzt am 12.11.2026 (ohne
> Freigabe-Halt; Marc am 12.11.2026: „Ja, ungeprüft“) – **nach Snowflakes Dokumentation geschrieben, nicht gegen
> Snowflake gelaufen**: Es gibt weder einen Container noch einen Emulator, nur ein Konto. Die Tests sprechen mit
> einem eigenen Server, der antwortet, wie die Dokumentation es beschreibt.

## Ergebnis in einem Satz

Snowflake ist eine eigene `DbKind` zum **Lesen und Ausführen**: verbinden mit Token oder Schlüsselpaar, Anweisungen
ausführen und abbrechen, Baum, Details mit DDL, Tabellen-Ansicht mit Filter, Suche. Zeilen im Gitter ändern, Import
und Kopieren gibt es dort nicht.

## Entscheidungen

| # | Entscheidung | Warum |
|---|---|---|
| E1 | **SQL-API** (`/api/v2/statements`) mit `ureq`, kein fremder Client | Snowflakes eigenes Protokoll der Treiber ist nicht dokumentiert; die SQL-API ist es. Die Rust-Crates dafür sind asynchron und ziehen `reqwest` nach |
| E2 | Das Profil: **Host = `<account>.snowflakecomputing.com`**, Benutzer, **Datenbank** (Pflicht: ihre Schemata zeigt der Baum), **Passwort = Programmatic Access Token** – oder **Client-Schlüssel = Datei des privaten Schlüssels** (PKCS#8, ohne Passphrase) für ein Schlüsselpaar | kein neues Feld; das Token liegt im Schlüsselbund, der Schlüssel bleibt eine Datei |
| E3 | Schlüsselpaar: Der Treiber signiert eine Zusicherung (JWT, RS256, mit `ring`); `iss` trägt den Fingerabdruck des öffentlichen Schlüssels (SHA-256 über dessen `SubjectPublicKeyInfo`, das der Treiber aus dem bloßen RSA-Schlüssel bildet) | so beschreibt es Snowflake; gegen `openssl` geprüft |
| E4 | Token und Zusicherung gehen nur an `*.snowflakecomputing.com` (bzw. `.cn`) über geprüftes TLS mit den Zertifikaten des Systems, nie durch einen SSH-Tunnel | sie öffnen ein Konto |
| E5 | Eine Anweisung wird **asynchron** eingereicht; der Treiber fragt nach ihrem Stand, sieht dazwischen auf Stopp und Uhr und bricht sie mit `…/cancel` ab. Große Ergebnisse kommen in **Partitionen** (gepackt) | nichts läuft unbemerkt weiter |
| E6 | **Werte** über `bindings` (`FIXED`, `TEXT`, `BOOLEAN`); ein Datum reist als Text | so verlangt es die Dokumentation |
| E7 | Datum und Zeit lässt sich der Treiber **als lesbaren Text** geben (`parameters` der Anfrage: `…_OUTPUT_FORMAT`) statt als Tage und Sekunden seit 1970 | keine Rechnung mit Zeitzonen im Treiber; jede Ziffer bleibt |
| E8 | **Keine Sitzung**: Jede Anweisung gilt für sich, mit Lager (Warehouse) und Rolle, die der Benutzer als Vorgabe hat. `USE WAREHOUSE …` wirkt nicht über die Anweisung hinaus. `edits_rows` falsch; ein Assistent bekommt keine Abfrage ausgeführt | die SQL-API hält keinen Zustand |
| E9 | Namen: unquotiert nur, was groß geschrieben ist; alles andere in `"…"`. „Enthält“ über `CONTAINS`. DDL über `GET_DDL` mit dem Namen als gebundenem Wert | Dialekt |
| E10 | Der Schutz kennt `//`-Kommentare und Zeichenketten zwischen `$$`; die freie Bedingung lehnt beide ab | sonst läse er einen Text anders als Snowflake (wie bei BigQuery, 035j Review 2) |

## Was noch fehlt (bewusst)

- Bearbeiten, Import, Testdaten, Kopieren; Plan, Monitor, Rechte, Struktur.
- Lager, Rolle und Schema je Verbindung wählen (sie kommen aus den Vorgaben des Benutzers); Anmeldung über den
  Browser (SSO), OAuth, Passwort mit zweitem Faktor; Schlüssel mit Passphrase.
- Mehrere Anweisungen in einem Text (die API will dafür ihre Zahl wissen) – und damit alles, was eine Sitzung
  meint: Transaktionen, `USE`, `ALTER SESSION`, Sitzungsvariablen lehnt der Treiber mit Worten ab; temporäre
  Tabellen leben nur in ihrer einen Anweisung.
- Der Name der Datenbank geht, wie getippt, an die API (dort zählt Groß und Klein). Ein Kontoname mit `_` steht
  im Host mit `-`: Ob Snowflake ihn so in der Zusicherung des Schlüsselpaars annimmt, ist offen.
- Fremdschlüssel (dort ein Versprechen, das niemand prüft), Routinen, Stages, Streams, Tasks im Baum.

## Nicht getestet

- **Alles gegen Snowflake**: ob die Antworten wirklich so aussehen, die Anmeldung mit Token und Schlüsselpaar, die
  Formate für Datum und Zeit, Partitionen, Fehler mit Stelle, die Katalogabfragen (`INFORMATION_SCHEMA`, `GET_DDL`).
  Der erste Lauf gegen ein echtes Konto ist der eigentliche Test.
- Das native Fenster.

## Tests

- `src-tauri/src/db/snowflake_tests.rs` (5 Tests, bei jedem `cargo test`): Einreichen, Warten, Partitionen, Typen
  und gebundene Werte; Abbruch; Fehler mit Stelle, ohne das Login zu nennen; dass ein Login nur zu Snowflake geht;
  Token und Schlüsselpaar (Fingerabdruck gegen `openssl`, wo es da ist).
- `filter.rs` (Tabellen-Ansicht, freie Bedingung), `guard.rs` (Kommentare, `$$`), `mod.rs` (Flags); im Fenster
  Zerlegen.

## Review

Ein zweiter Agent hat den Stand gegen Snowflakes Dokumentation gelesen (nur lesend): 13 Befunde, keiner ein Weg
für Token oder Schlüssel nach außen. Behoben, jeder mit Test:

| # | Befund | Behoben durch |
|---|---|---|
| 1 | `SELECT SYSTEM$CANCEL_ALL_QUERIES(…)`, `SYSTEM$SEND_EMAIL` und `seq.NEXTVAL` galten als lesend | `SYSTEM$…(` ist schreibend bis auf wenige, die nur Auskunft geben; `NEXTVAL` ebenso |
| 2 | `BEGIN; UPDATE …; ROLLBACK` ging als drei Anfragen hinaus: Das `UPDATE` wäre geblieben | `needs_a_session`: Transaktion, `USE`, `ALTER SESSION`, `SET`/`UNSET` werden abgelehnt, nichts wird gesendet |
| 3 | Ohne Vorgabe-Lager scheitert alles nach dem Verbinden, ohne dass man erfährt, was zu tun ist | Hinweis am Fehler („no active warehouse“ → `ALTER USER … SET DEFAULT_WAREHOUSE`); Lager und Rolle am Profil bleiben offen (oben) |
| 4 | Ein Block von Snowflake Scripting ohne `$$` wurde an seinen `;` zerlegt, die Teile einzeln ausgeführt | Der Zerleger hält `[DECLARE …] BEGIN … END` zusammen (auch als Rumpf hinter `AS`), mit `IF`/`FOR`/`WHILE`/`LOOP`/`CASE` |
| 5 | Ein Teil des Ergebnisses, der kein JSON oder leer war, fehlte still | unlesbare Antwort, Teil ohne Zeilen und andere Zeilenzahl als angekündigt sind Fehler |
| 6 | Ein Stolpern beim Warten ließ die Anweisung unbemerkt weiterlaufen | Nachfragen (nie die Anweisung) wird bis zu dreimal wiederholt, danach abgebrochen; `timeout` geht mit |
| 7 | `START`, `SAMPLE`, `QUALIFY` … standen ungequotet im SQL | `SNOWFLAKE_RESERVED` |
| 8 | Der Namensindex fragte die ganze Datenbank auf einmal („returned too much data“) | Schema für Schema, der Name gebunden |
| 9 | Ein Token ging auch an `localhost` | nur noch in den Tests |
| 10 | Backslash galt auch in `"…"` als Escape: Die freie Bedingung las einen Namen anders als Snowflake | nur in `'…'` – im Schutz, in der freien Bedingung, im Zerleger |
| 11 | Jede abgelehnte Anmeldung hieß nur „login failed“ | Grund nach der Nummer (Uhr, Kontoname, Schlüssel; 403: API nicht offen) – nie in den Worten des Servers |
| 12 | Benutzername nur in ASCII groß geschrieben | `to_uppercase` |
| 13 | `INSERT OVERWRITE`, `CREATE OR REPLACE TABLE` nicht als gefährlich eingestuft; Zahl mit Exponent abgelehnt | gefährlich (auch für BigQuery); als `REAL` gebunden |

Offen geblieben: Lager, Rolle und Schema am Profil (3); die Schreibung des Kontos in der Zusicherung (12); das
Zeitlimit von 60 s für das Laden eines Teils; ob ein `SELECT` je `stats` trägt.
