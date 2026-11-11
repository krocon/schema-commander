# Design 003: Verbindungen und Schlüsselbund

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/verbindungen` · Auftrag: [003-verbindungen.md](003-verbindungen.md) · Features A1, A2

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Treiber | `sqlx-postgres`, `sqlx-mysql` (=0.9.0, Unterkrates), `tiberius` 0.13, `rusqlite` 0.41 – wie log-commander | dort gegen echte Server erprobt; reines Rust, rustls mit `ring`; die `sqlx`-Fassade zöge ein zweites SQLite mit |
| E2 | Protokoll | Anweisungen laufen über das **einfache Protokoll** (`raw_sql` bzw. `simple_query`) | alles, was ein Nutzer tippen kann, läuft (`USE`, `SET`, mehrere Anweisungen, `BEGIN … ROLLBACK`); das erweiterte Protokoll lehnt manches ab |
| E3 | Kopfzeile leerer Ergebnisse | liefert das einfache Protokoll nicht → danach ein `prepare` (nur beschreiben, nichts läuft) | ein `SELECT` ohne Zeilen zeigt trotzdem seine Spalten |
| E4 | Verbindungen | **eine Sitzung je Profil**, hinter einer eigenen Sperre; kein Pool | Transaktionen brauchen eine feste Sitzung; „je Tab eine Sitzung“ kommt mit den Tabs (004) bzw. Transaktionen (013) |
| E5 | Abbruch | Der laufende Aufruf endet sofort (Stop-Flag, 50 ms Takt), die **Verbindung wird verworfen**; die nächste Anweisung verbindet neu. SQLite wird über `interrupt` gestoppt und bleibt offen | einfach und auf allen vier Servern in < 1 s (Test); der serverseitige Abbruch mit erhaltener Sitzung ist Sache von Prompt 005 |
| E6 | Werte über die Brücke | `Cell` als JSON ohne Verlust: `null`, Bool, Zahl (Ganzzahlen nur bis ±2^53), sonst Text; die Spalte trägt `kind` und `typeName` | 64-Bit-Zahlen, Dezimalzahlen, Datum/Zeit, UUID, JSON kommen als Text und werden anhand der Spaltenart gelesen; Binärdaten als Länge + erste 16 Bytes |
| E7 | Profile | `connections.json` im Konfigurationsordner, **ohne Geheimnisse** (`Profile` hat kein Feld dafür); Grenzen und Prüfung in Rust, defekte Datei wird beiseitegelegt | wie die Farbschemata (001) |
| E8 | Passwörter | nur im Schlüsselbund (`keyring-core` + Store je OS), Kontoname = Hash aus Art, Benutzer, Host, Port; im Speicher `Secret` (`zeroize`, kein `Serialize`, `Debug` = `***`). Gespeichert wird nur, wenn das Profil es will, und erst nach gelungener Anmeldung | Umbenennen behält das Passwort; in den Metadaten des Schlüsselbunds stehen weder Host noch Benutzer |
| E9 | Passwort unbekannt | Backend antwortet `secret_required`, das Frontend fragt (auch nach `auth_failed` noch einmal) | kein stilles Ablegen in einer Datei, auch nicht ohne Schlüsselbund |
| E10 | TLS in diesem Prompt | zwei Modi: `off` (Vorgabe nur für `localhost`) und `verify` (Zertifikat **und** Hostname gegen die Wurzeln des Systems). Der Dialog schlägt `verify` vor, sobald der Host nicht dieser Rechner ist, und warnt bei `off` | eigene CA, Client-Zertifikat und „nicht prüfen“ als sichtbare Wahl bringt Prompt 014 |
| E11 | Demo | Die Demo-Datenbank ist ein festes Profil (`demo`, SQLite im Speicher): immer da, nicht änderbar, wird beim Start geöffnet | die App ist ohne Server benutzbar; sonst verbindet nichts ohne Zutun des Nutzers |
| E12 | SQLite-Dateien | müssen existieren (ein Tippfehler legt keine leere Datenbank an); Erweiterungen laden ist herausgebaut (`.cargo/config.toml`) | Sicherheit und Erwartung |
| E13 | Aktive Verbindung | eine für das Fenster (`settings.activeConnection`); Ausführen öffnet sie bei Bedarf | „je Tab“ folgt mit Prompt 004 |

## Typabbildung (Auszug; vollständig in den Treibern `kind()`/`cell()`)

| Art | PostgreSQL | MySQL/MariaDB | SQL Server | SQLite |
|---|---|---|---|---|
| int | INT2/4/8, OID | TINYINT…BIGINT (auch UNSIGNED), YEAR | Int1…Int8 | deklariert `…INT…` |
| float | FLOAT4/8 | FLOAT, DOUBLE | Float4/8 | REAL, FLOAT, DOUBLE |
| decimal (Text) | NUMERIC | DECIMAL | Decimal, Numeric, Money | NUMERIC, DECIMAL |
| bool | BOOL | BOOLEAN | Bit | BOOL |
| bytes | BYTEA | BINARY, BLOB-Familie, BIT, GEOMETRY | VarBinary, Image | BLOB |
| timestamp / timestampTz | TIMESTAMP / TIMESTAMPTZ (als UTC) | DATETIME / TIMESTAMP (wie der Server sie gibt) | DateTime(2) / DateTimeOffset | DATETIME, TIMESTAMP |
| json, uuid | JSON(B), UUID | JSON | – , Guid | JSON |
| other (Text) | Arrays, Enums, Intervalle … | – | – | Ausdrücke ohne deklarierten Typ |

In SQLite ist die **Zelle**, was gespeichert ist (dynamische Typen), unabhängig von der deklarierten Spaltenart.

## Befunde aus den Tests gegen echte Server

- **MySQL 8 ohne TLS** meldet sich mit `caching_sha2_password` an und braucht dafür RSA: Feature `rsa` von
  `sqlx-mysql` (log-commander testete nur mit TLS).
- **MariaDB `JSON`** und jede Textspalte mit binärer Kollation (`utf8mb4_bin`) nennt der Treiber `BLOB`. Deshalb
  wird ein Wert der BLOB-Familie, der lesbarer Text ist, als Text gezeigt (`blob_or_text`). Folge: echte Binärdaten,
  die zufällig druckbarer Text sind, erscheinen als Text.
- **SQL Server** gibt über `tiberius` keine Zeilenzahlen weiter: Die App hängt `SELECT @@ROWCOUNT` an. Anweisungen,
  die allein im Batch stehen müssen (`CREATE VIEW` …), scheitern damit beim Übersetzen (Fehler 102/111/156 – nichts
  lief) und werden ohne den Zusatz noch einmal gesendet; dann gibt es keine Zeilenzahl.
- SQLite: ein `interrupt` vor Beginn der Anweisung geht verloren – der Wächter wiederholt ihn, bis die Anweisung
  endet.

## Verträge

Commands (alle `async`): `list_connections`, `save_connection(profile, password?)`, `delete_connection(id)`,
`test_connection(profile, password?)`, `open_connection(id, password?)`, `close_connection(id)`,
`run_query(id, sql)`, `cancel_query(id)`. Neue Fehlercodes: `connection_failed`, `auth_failed`, `tls_failed`,
`timeout`, `cancelled`, `permission_denied`, `secret_required`, `keychain_unavailable`, `invalid_profile`,
`unknown_connection`, `not_connected`. TS: `ConnectionsApi`, `QueryApi` (`run`, `cancel`), `ConnectionsStore` (Root).

Aktionen: `NEW_CONNECTION` (`Mod+Shift+N`), `EDIT_CONNECTION`, `CONNECT`, `DISCONNECT`, `CANCEL_QUERY` (`Mod+.`).

## Tests

- Rust (48 + 1 ignoriert): `value.rs` (verlustfreie Zahlen, `NULL` ≠ Text, ISO-Datum, NUMERIC binär), `profiles.rs`
  (Prüfung, Ids, kein Geheimnis in der Datei, defekte Datei), `manager.rs` (Schlüsselbund-Regeln mit
  Speicher-Store, `secret_required`, Abbruch aus anderem Thread, Fehlertext ohne Passwort), `sqlite.rs`, Treiber.
- **Gegen echte Server** (`sh scripts/db-test-servers.sh up`, `pnpm rust:test:db`, 8 Tests): PostgreSQL 17,
  MySQL 8.4, MariaDB 11.4, SQL Server 2022 – Typen, Unicode, `NULL`, leere Ergebnisse mit Kopf, Zeilenzahlen,
  Grenze bei 2 Mio. Zeilen, falsches Passwort, unbekannte Datenbank, kein Server, Abbruch in < 1 s. Am 11.11.2026
  alle grün. Nicht in CI (braucht Docker).
- Frontend: `connections.store.spec.ts`, `query-session.spec.ts`, `connection-dialog.spec.ts`,
  `connection-logic.spec.ts`, `result-model.spec.ts`.

## Ende-zu-Ende und was offen ist

- Oberfläche im Browser mit nachgestelltem Backend angesehen (Liste mit Ordnern, Zuständen und Fehlermeldung,
  Dialog, Ergebnis mit 64-Bit-Zahl, Dezimalzahl, Binärdaten).
- **Nicht geprüft:** das native Fenster gegen einen echten Server (Rust und Frontend sind je für sich getestet,
  ihr Zusammenspiel über die Tauri-Brücke nicht von Hand); der **echte Schlüsselbund** (der Test `real_keychain`
  ist ignoriert, weil macOS dabei nachfragen kann – getestet ist die Logik mit einem Speicher-Store); TLS gegen
  einen Server mit Zertifikat (kommt mit 014 samt Testzertifikaten); Windows und Linux.
- Kein Review durch einen zweiten Agenten in diesem Durchlauf (der Prompt sah eines vor: Geheimnisse, TLS,
  Eingaben aus dem Profil). Offen für 014, wo TLS und SSH dazukommen.
- Bekannte Grenzen bis zu den Folge-Prompts: ganzes Ergebnis über die Brücke bis 100 000 Zeilen / 256 MB (006),
  Text je Zelle bis 32 768 Zeichen (026), eine Anweisung je Ausführung im Editor (005), `NULL` leer dargestellt
  (007).
