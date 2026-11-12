# Design 035b: Oracle

> Durchlauf von [Prompt 035](035-weitere-datenbanken.md) für **Oracle Database**. Stand: umgesetzt am
> 12.11.2026, geprüft gegen Oracle Database Free 23.26 (Container `gvenzl/oracle-free:23-slim-faststart`,
> nativ auf Apple Silicon).

## Ergebnis in einem Satz

Oracle ist eine eigene `DbKind` mit eigenem Treiber: verbinden, ausführen, Baum, Details mit DDL, Tabellen-Ansicht,
Bearbeiten, Suche und Diagramm funktionieren und sind geprüft; Import einer Datei und Kopieren zwischen Verbindungen
sind eingebaut, aber nicht gegen Oracle geprüft; Ausführungsplan, Server-Monitor, Benutzer und Rechte,
Schema-Vergleich und Struktur bearbeiten gibt es für Oracle noch nicht – die App sagt das und blendet die Aktionen aus.

## Entscheidungen

| # | Entscheidung | Warum |
|---|---|---|
| E1 | Treiber **`oracledb` 26.0.0-beta.5** (github.com/oracle/rust-oracledb): rein Rust, von Oracle gepflegt, **kein Instant Client**. Fest angepinnt | Die Alternativen `oracle` und `sibyl` brauchen die Oracle-Client-Bibliothek auf jedem Rechner (Installation, Lizenz, Build je OS) – genau das, was Prompt 035 vermeiden will. `oracle-rs` (Community) ist seit März 2026 ohne Änderung. Lizenz UPL-1.0 oder Apache-2.0 |
| E2 | Die Verbindung lebt auf **einem eigenen Thread** (`sc-oracle`); die Sitzung schickt ihm Aufträge und bekommt Zeilen über eine begrenzte Warteschlange | Der Treiber ist synchron. So kann die Sitzung auf Abbruch und Zeitlimit reagieren, während der Aufruf blockiert |
| E3 | **Abbruch kostet die Verbindung** (wie bei SQL Server, `Capabilities.cancel = false`): Die Anweisung wird samt Verbindung zurückgelassen, die Sitzung ist geschlossen; eine zweite Verbindung bittet den Server, die Sitzung zu beenden (`ALTER SYSTEM KILL SESSION … IMMEDIATE`) | Die Beta kann einen laufenden Aufruf nicht unterbrechen. `ALTER SYSTEM CANCEL SQL` brach im Versuch zwar die Anweisung ab, ließ den Treiber aber hängen; sein eigenes Zeitlimit endet mit „UnableToRecover“ und toter Verbindung. Das Beenden braucht ein Recht, das normale Benutzer nicht haben: Dann läuft die Anweisung auf dem Server zu Ende, das Fenster ist trotzdem sofort frei |
| E4 | **Auto-Commit im Treiber-Thread**: nach jeder Anweisung, die keine Abfrage ist, `COMMIT` – außer nach `SET TRANSACTION …` (das sendet `begin_statement`), dann bis `COMMIT`/`ROLLBACK` | Oracle kennt kein Auto-Commit auf dem Server. So verhält sich ein Tab wie bei den anderen Datenbanken; ob eine Transaktion offen ist, sagt weiter der Server (`dbms_transaction.local_transaction_id`) |
| E5 | Eine Anweisung verliert ihr `;` und die `/`-Zeile, **PL/SQL behält sein `;`** (`BEGIN`, `DECLARE`, `CREATE … FUNCTION/PROCEDURE/PACKAGE/TRIGGER/TYPE`) | Der Server nimmt eine Anweisung ohne Trenner; bei PL/SQL gehört das `;` zum Text |
| E6 | Skripte zerlegt das Fenster wie SQL*Plus: PL/SQL endet an einer Zeile mit nur `/`, alles andere an `;`; `q'[…]'` ist ein String | Was Nutzer von Oracle-Werkzeugen kennen; ohne das zerfiele jeder Block an seinem ersten `;` |
| E7 | Werte: `NUMBER` ganzzahlig bis 18 Stellen → Zahl, sonst exakter Text; `DATE` → Zeitstempel (hat eine Uhrzeit); `TIMESTAMP WITH TIME ZONE` → Zeitpunkt in **UTC**; `CLOB`/`BLOB` ganz; JSON als Text, Zahlen ziffernweise | Der Treiber liefert Zeitpunkte in UTC; die gespeicherte Zone steht nicht im Wert. `CLOB`/`BLOB` meldet er als `LONG`/`LONG RAW` – so steht es auch im Spaltenkopf |
| E8 | Gebunden wird positional (`:1`, `:2`); Daten als `OracleTimestamp`, Dezimalzahlen als `OracleNumber`, Wahrheitswerte als 1/0 | Ein Text würde nach dem Format der Sitzung in ein Datum gewandelt (NLS); 1/0 passt für `BOOLEAN` (23ai) und für `NUMBER(1)` davor |
| E9 | Tabellen-Ansicht: `FETCH FIRST n ROWS ONLY`, `NULLS FIRST/LAST` nativ; Filterwerte auf `DATE`/`TIMESTAMP` reisen als Datum; die lesbare Fassung schreibt `TIMESTAMP '…'` | ab Oracle 12c; siehe E8 |
| E10 | Bearbeiten: **eine Zeile je `INSERT`** | Mehrzeiliges `VALUES` gibt es erst ab 23ai; `INSERT ALL` gäbe jeder Zeile dieselbe Nummer einer Identity-Spalte. Eine Zeile nur aus Vorgaben kann Oracle nicht einfügen: Die App sagt es |
| E11 | Katalog über die `ALL_`-Sichten mit gebundenen Parametern; DDL über `DBMS_METADATA.GET_DDL` ohne Speicherangaben | zeigt, was der Benutzer sehen darf; die Lagerung gehört zum Server, nicht zur Definition |
| E12 | Schutz: Der Scanner kennt q-Quotes und nimmt für Oracle keinen Backslash als Escape; PL/SQL zählt mindestens als schreibend | sonst könnte ein q-Quote Code als String tarnen |
| E13 | TLS: `tcps://` mit Prüfung des Zertifikats (CA und Client-Zertifikat der Profile werden für die Verbindung als Wallet-Ordner mit `ewallet.pem` bereitgestellt und danach gelöscht). „TLS ohne Prüfung“ lehnt die App für Oracle ab | Der Treiber prüft immer |
| E14 | Neue Fähigkeits-Flags `plan`, `monitor`, `access`, `structure`; `db::not_yet` für die Meldung | Das Fenster blendet aus, was es nicht gibt; DuckDB und ClickHouse brauchen dasselbe |

## Was noch fehlt (bewusst)

- **Ausführungsplan** (`EXPLAIN PLAN` + `DBMS_XPLAN`), **Server-Monitor** (`v$session`), **Benutzer und Rechte**,
  **Schema-Vergleich** und **Struktur bearbeiten**: je ein eigener Schritt; bis dahin `Unsupported` mit Text.
- **Sichern** mit `expdp`/`impdp`: nicht vorgesehen; der einfache SQL-Export bleibt.
- **Warnungen** („created with compilation errors“) zeigt die App nicht; der Fehler steht in `USER_ERRORS`.
- **Kerberos, Wallets mit SSO, TNS-Namen** (`tnsnames.ora`): nicht angeboten – Host, Port, Dienstname.
- Binärwerte über 2000 Bytes lassen sich im Gitter nicht schreiben (`HEXTORAW` eines gebundenen Textes).

## Nicht getestet

- **Import einer Datei** und **Tabellen kopieren** von und nach Oracle: Typen (`load.rs`, `transfer.rs`) und
  Anweisungen sind da, ein Lauf gegen den Container fehlt noch. Geschrieben wird eine Zeile je `INSERT`, große
  Dateien dauern also.

- **TLS** (`tcps`) und **SSH-Tunnel** gegen Oracle: Der Test-Container bietet kein TCPS. Der Code folgt den
  anderen Treibern (Tunnel) bzw. der Dokumentation des Treibers (Wallet).
- Oracle vor 23ai (12c, 19c, 21c): Die Anweisungen sind für 12c geschrieben (`FETCH FIRST`, `LISTAGG`,
  `oracle_maintained`), gelaufen sind sie nur auf 23.26.
- Windows und Linux: Der Treiber ist reines Rust; gebaut wird er dort erst von der CI.

## Tests

- `src-tauri/tests/oracle_integration.rs` (11 Tests, `pnpm rust:test:db`): Typen, Unicode, NULL; Änderungen,
  Grenzen, Fehler mit Stelle (auch PL/SQL); falsches Passwort, unbekannter Dienst; Abbruch und Zeitlimit;
  Auto-Commit und Transaktion mit zwei Sitzungen; gebundene Werte; Metadaten, Namensindex, Beziehungen, Diagramm;
  Details und DDL als Rundreise; Filtern, Sortieren, Bearbeiten; Suche in Zeilen und Definitionen; was fehlt, sagt es.
- Unit-Tests: `oracle.rs` (Trenner, PL/SQL, Daten, JSON, Profil), `guard.rs` (q-Quotes, Blöcke), `details.rs`,
  `import.rs` (URL, DBeaver), `mod.rs` (Flags); im Fenster `sql-split.cases.json` (7 Fälle), Parameter, Dialog.

## Review

Ein zweiter, nur lesender Blick über den Branch. Behoben, je mit Test:

| # | Befund | Behebung |
|---|---|---|
| 1 (hoch) | Eine gestoppte Anweisung, die der Server nicht beenden durfte, lief zu Ende – und wurde dann **bestätigt**, obwohl das Fenster „abgebrochen“ gemeldet hatte | Der Thread rollt zurück, wenn die Sitzung aufgegeben hat (Container-Test `review_findings_hold`) |
| 2 (hoch) | `SET TRANSACTION READ ONLY` gilt nur für eine Transaktion (und liest darin einen alten Stand); als „Sitzung nur lesend“ taugt es nicht, der zweite Aufruf der KI-Steuerung wäre gescheitert | `read_only_statement` ist für Oracle `None`: Es zählt die Einstufung, und ein lesender Aufruf läuft – wie bei SQL Server – in einer Transaktion, die zurückgerollt wird |
| 3 | Werte von `TIMESTAMP WITH TIME ZONE` wurden als Text gebunden (NLS) – Filtern, Ändern und Löschen solcher Zeilen scheiterte | `TO_TIMESTAMP_TZ(:n, <unser Format>)`, der Wert in einer festen Schreibweise; ohne Zone gilt UTC, wie das Gitter anzeigt |
| 4 | Reservierte Wörter von Oracle (`COMMENT`, `LEVEL`, `DATE` …) galten als schlichte Namen | eigene Liste in `meta.rs` |
| 5 | Das Flag `structure` las niemand; „Neue Tabelle“ und „Duplizieren“ hätten den Erzeuger anderer Dialekte erreicht | `structure::plan` lehnt Oracle ab; der Baum bietet die fünf Struktur-Aktionen nicht an |
| 6 | Der Merker „Transaktion geöffnet“ blieb nach DDL stehen (das bei Oracle bestätigt); `COMMIT COMMENT '… TO …'` galt nicht als Ende | DDL setzt ihn zurück; `ROLLBACK TO` wird am zweiten Wort erkannt |
| 7 | Die freie Bedingung kannte keine q-Quotes und ließ `:1` durch | beides wird abgelehnt |
| 8 | Der Lexer für Parameter kannte keine q-Quotes | ergänzt |
| 9 | `seq.NEXTVAL` galt als lesend | schreibend |
| 10 | Die zweite Verbindung fand das Wallet nicht mehr | der Ordner lebt so lange wie die Sitzung |
| 11 | `select 1 from dual; -- Notiz` behielt sein `;` | der Trenner fällt auch vor Kommentaren weg |

Offen geblieben: `WITH FUNCTION …`, ein Block mit Marke (`<<l>> BEGIN …`) und `CREATE … JAVA` zerlegt die App
nicht als PL/SQL – solche Texte als Auswahl ausführen. Das Passwort bleibt für die zweite Verbindung im Speicher
der Sitzung (wie beim MySQL-Treiber).
