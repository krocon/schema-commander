# Design 035g: libSQL und Turso

> Durchlauf von [Prompt 035](035-weitere-datenbanken.md) für **libSQL** (ein `sqld`-Server oder eine
> Turso-Datenbank). Stand: umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026), geprüft
> gegen `sqld` 0.24.33 (Container `ghcr.io/tursodatabase/libsql-server`, SQLite 3.47).

## Ergebnis in einem Satz

libSQL ist eine eigene `DbKind` mit dem **Dialekt von SQLite**: Alles, was die App für eine SQLite-Datei kann
(ausführen, Baum, Details mit DDL, Tabellen-Ansicht, Zeilen bearbeiten, Import, Suche, Plan, Struktur, Vergleich),
geht dort über das Netz – nur der Weg ist ein anderer, und was eine Datei voraussetzt (Kopie als Sicherung,
`ATTACH`), gibt es nicht.

## Entscheidungen

| # | Entscheidung | Warum |
|---|---|---|
| E1 | **Hrana über HTTP** (v3) mit `ureq`, kein fremder Client | Das Crate `libsql` bringt eine eigene SQLite-Bibliothek, `tokio`-Dienste und Replikation mit – für einen Client, der nur fragt, ein Vielfaches an Code und Bauzeit. Das Protokoll ist klein und dokumentiert |
| E2 | Eine Anweisung ist eine Anfrage an **`/v3/cursor`**: Zeilen kommen als Zeilen JSON und gehen so in den Speicher | kein Ergebnis muss als Ganzes in den Speicher des Servers oder der App; die Grenze der Pipeline (Antwortgröße) gilt nicht |
| E3 | Werte werden vom Protokoll **gebunden** (`args`): Ganzzahlen als Text, damit keine Ziffer verloren geht; Dezimalzahlen als Gleitkomma, Datum als Text – wie beim Treiber für die Datei | SQLite kennt weder Dezimalzahlen noch Daten |
| E4 | **Sitzung** = ein *Stream* des Servers, benannt durch ein `baton`, das mit jeder Antwort wechselt. Der Server verwirft einen Stream nach etwa zehn Sekunden ohne Anfrage – **und mit ihm eine offene Transaktion** (geprüft). Darum fragt ein **Herzschlag** alle drei Sekunden nach, solange eine Transaktion offen ist | Sonst wäre eine Transaktion weg, während jemand über sein `COMMIT` nachdenkt. Ohne Transaktion wird ein verfallener Stream stillschweigend neu geöffnet |
| E5 | Ob eine Transaktion offen ist, sagt der Server (`get_autocommit`) nach jeder Anweisung | keine Annahme; der Herzschlag richtet sich danach |
| E6 | Eine Anweisung, die der Server nicht lesen kann, kostet am Cursor den Stream (HTTP 500, geprüft). **In einer Transaktion** zeigt der Treiber sie dem Server darum erst mit `describe` | ein Tippfehler darf keine Transaktion kosten |
| E7 | Das Protokoll kann eine Anweisung **nicht abbrechen**. Gestoppt oder über der Zeit wird die Anfrage zurückgelassen (eigener Thread), die Sitzung nimmt einen neuen Stream; Flag `cancel` = aus | ehrlich: Die Anweisung läuft auf dem Server zu Ende. Eine Transaktion, die offen war, ist damit weg |
| E8 | **Dialekt**: `DbKind::is_sqlite()` – jede Stelle, die SQLite als Dialekt behandelt (Quoting, Katalog über `pragma_…`-Funktionen, Einstufung, Literale, Zerlegen), gilt für beide; was eine Datei meint (`is_file`, Sicherung als Kopie, Demo-Datenbank), bleibt bei SQLite. Im Fenster macht `dialectOf` aus `libsql` den Dialekt `sqlite` | ein Dialekt, zwei Wege – keine zweite Kopie von hundert Fallunterscheidungen |
| E9 | **Anmeldung**: Benutzer leer = das Passwort ist ein Token (`Bearer`, so bei Turso); mit Benutzer `Basic`. Ein Token geht nur über TLS oder an diesen Rechner | der Schlüsselbund hält es wie jedes Passwort |
| E10 | **Nur lesen**: Der Server nimmt `PRAGMA query_only` nicht an (geprüft). Es bleibt die Einstufung; ein Assistent liest in einer Transaktion, die zurückgerollt wird (wie bei SQL Server) | Turso kennt Token nur zum Lesen – wer das will, nimmt ein solches |
| E11 | `libsql://…?authToken=…` wird als Verbindung gelesen (HTTPS, 443, Token als Passwort) | die Adresse, die Turso ausgibt |
| E12 | Von einer `base_url`, die der Server nennt, nimmt der Treiber nichts: Gefragt wird der Server des Profils | wie bei Trino (035f E3) |

## Was noch fehlt (bewusst)

- **Abbruch** auf dem Server (E7). **Nur lesen** auf dem Server (E10).
- Sichern als Dateikopie, `ATTACH`, Erweiterungen: gibt es dort nicht. Der einfache SQL-Export geht.
- Namensräume von `sqld` (mehrere Datenbanken hinter einem Server über den Hostnamen) kennt die App nicht eigens:
  ein Profil je Datenbank.
- Eingebettete Repliken, Vektor-Funktionen, das Protokoll über WebSocket.
- Temporäre Tabellen leben nur, solange der Stream lebt – ohne Transaktion also etwa zehn Sekunden.

## Nicht getestet

- **Turso** selbst, **TLS**, **Token** und **Basic-Anmeldung** gegen einen Server (der Container hat keine
  Anmeldung; wie die Kopfzeile entsteht, prüft ein Unit-Test), **SSH-Tunnel**.
- Import einer Datei, Tabellen kopieren, Struktur bearbeiten, Testdaten und Schema-Vergleich als ganzer Lauf: Sie
  nutzen dieselben Anweisungen wie für eine SQLite-Datei (dort getestet) über denselben Weg wie das Bearbeiten
  (hier getestet) – gelaufen sind sie gegen libSQL nicht.
- Das native Fenster (`pnpm tauri dev`) wurde nicht bedient.

## Tests

- `src-tauri/tests/libsql_integration.rs` (6 Tests, `pnpm rust:test:db`): Typen, Unicode, NULL, gebundene Werte
  (auch böse), 50 000 Zeilen als Strom, Grenze, Fehler mit Stelle; Transaktion über die Leerlaufzeit des Servers
  hinweg (Herzschlag), verfallener Stream ohne Transaktion, Fehler und Tippfehler in einer Transaktion, Sitzung, die
  geht; Stopp und Zeitlimit mit weiterlebender Sitzung; was der Server ablehnt; Metadaten, Namensindex, Details mit
  DDL, Fremdschlüssel, Diagramm, Schnappschuss, Plan, Suche; Filtern, Sortieren und ein Schreibplan (ändern mit
  Sperre, einfügen mit Rückgabe) in einer Transaktion.
- Unit-Tests: `libsql.rs` (Fehler, Werte, Anmeldung), `import.rs` (Turso-Adresse), `guard.rs`, `mod.rs` (Flags).

## Review

Ein zweiter, nur lesender Blick über den Branch, gegen den laufenden Server geprüft. Kein Weg des Tokens nach
außen, keine Injektion gefunden; die Befunde betreffen Transaktionen, die verloren gingen, ohne dass es jemand
erfuhr. Behoben, mit Tests (`review_a_lost_transaction_is_said_and_a_cut_result_does_not_hang`, `libsql.rs`):

| # | Befund | Behebung |
|---|---|---|
| 1 (hoch) | Nach einem abgeschnittenen Ergebnis wirkten Stopp und Zeitlimit nicht mehr; ein Ergebnis ohne Ende wurde endlos gelesen | Ohne Transaktion wird die Anfrage zurückgelassen und ein neuer Stream genommen; in einer Transaktion wird der Rest gelesen und verworfen, Stopp und Zeitlimit gelten |
| 2 (hoch) | `describe` nimmt an, was der Cursor ablehnt (`VACUUM`, `ATTACH`, mehrere Anweisungen): Die Transaktion war weg, gemeldet wurde nur „unsupported statement“ | Eine Regel: Kostet ein Fehler den Stream, während eine Transaktion offen ist, sagt die Meldung, dass sie zurückgerollt ist. Mehrere Anweisungen in einem Text sind ein Fehler der Anweisung |
| 3 (hoch) | Die Frage nach dem Zustand verschluckte den Hinweis „Transaktion verloren“; im manuellen Modus lief das nächste Schreiben danach ohne Transaktion | Den Hinweis gibt nur die nächste Anweisung (einmal); der Zustand ist bis dahin „keine“ |
| 4 | Stopp, Zeitlimit und Netzfehler in einer Transaktion gaben den Stream auf, ohne es zu sagen | dieselbe Regel wie in 2; ein Stopp ist dann ein Fehler, der sagt, was er gekostet hat |
| 5 | „Abgebrochen“ heißt dort: Die Anweisung läuft auf dem Server zu Ende | steht in der Meldung zum Zeitlimit und im Design (E7). **Bleibt so** – das Protokoll kann es nicht |
| 6 | Durch einen SSH-Tunnel ging ein Token ohne TLS weiter (der Treiber sah nur `127.0.0.1`) | geprüft wird vor dem Umschreiben der Adresse; ohne TLS nur, wenn der Server der Sprung-Host selbst ist |
| 7 | Herzschlag: eine Antwort ohne `baton` oder ohne lesbaren Zustand galt als „keine Transaktion“ | gilt als verlorene Transaktion |
| 8 | Der Herzschlag einer geschlossenen Sitzung konnte weiterlaufen; das Schließen wartete auf das Netz | Marke „geschlossen“; das Schließen des Streams läuft auf einem eigenen Thread |
| 9 | Eine Zeile mit falscher Zellenzahl wurde still verworfen; ±Unendlich kommt als `null` | ist ein Fehler; Unendlich wird als nicht lesbar gezeigt (welches es war, sagt der Server nicht) |
| 10 | Die Stelle eines Fehlers zählte Zeichen, der Server Bytes; in einer Transaktion fehlte sie | umgerechnet; auch `(at offset N)` wird gelesen |
| 11, 12 | drei Vergleiche nur mit `Sqlite`; Sicherungsdialog zeigte ein Schema-Feld; der Verbindungsdialog nannte das Token „Passwort“ | behoben |

Offen geblieben:

- Der Cursor hat kein Lese-Zeitlimit: Eine zurückgelassene Anfrage auf einer toten Verbindung lebt, bis das
  Betriebssystem sie aufgibt.
- Ein zurückgelassener Stream hält in einer Transaktion die Schreibsperre von SQLite, bis der Server ihn verwirft
  (etwa zehn Sekunden nach dem Ende der Anweisung): Das nächste Schreiben kann so lange `SQLITE_BUSY` bekommen.
- Das Feld „Datenbank“ im Verbindungsdialog wird für libSQL gezeigt und nicht gebraucht.
