# Design 015: Verbindung aus URL und Import aus anderen Werkzeugen

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/verbindungs-import` · Auftrag: [015-verbindungs-import.md](015-verbindungs-import.md) · Feature A5

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Wo wird gelesen? | alles in Rust (`db/import.rs`, rein): URL-Parser und je Quelle ein Leser, der `Candidate { profile, password, problem }` liefert | fremde Dateien sind feindlich: Größe begrenzt (8 MB, 500 Einträge), nichts wird ausgeführt, fremder Text ohne Steuerzeichen und gekürzt |
| E2 | URL-Formen | `postgres://`, `postgresql://`, `mysql://`, `mariadb://`, `sqlserver://`/`mssql://`, je mit `jdbc:` davor; `jdbc:sqlserver://host:port;key=value`; ADO (`Server=…;Database=…;User Id=…`); `sqlite:`, `file:` und ein nackter Pfad auf `.db`/`.sqlite`/`.sqlite3`/`.db3`. Prozent-Kodierung, IPv6 in Klammern, `sslmode`/`ssl-mode`, Zertifikatsdateien, `Encrypt`/`TrustServerCertificate` | Katalog im Test |
| E3 | Passwort einer URL | kommt für das **Passwortfeld des Dialogs** zurück und geht mit „Speichern“ in den Schlüsselbund – nie ins Profil, nie in eine Datei | so tippt es der Nutzer auch selbst ein |
| E4 | Passwörter beim Import | bleiben im Backend: die Vorschau sagt nur `hasPassword`. Übernommen wird eines nur, wenn sein Häkchen gesetzt ist (Vorgabe: aus) – dann von der Datei direkt in den Schlüsselbund. Nur Klartext-Quellen: `.pgpass`, `pg_service.conf`, `.my.cnf`, Umgebung | Auftrag; die verschlüsselten Ablagen von DBeaver und JetBrains werden nicht angefasst |
| E5 | XML ohne Parser | `dataSources.xml` wird nach `<data-source>`, `<jdbc-url>`, `<user-name>` **abgesucht**, nicht geparst; nur die fünf festen Entitäten; eine Datei mit `<!DOCTYPE` oder `<!ENTITY` wird abgelehnt | keine neue Abhängigkeit, keine externen Entitäten möglich |
| E6 | Unvollständiges | Ein Fund, dem etwas fehlt (meist der Benutzer: DBeaver hält ihn verschlüsselt), steht in der Vorschau mit Grund und ist nicht ankreuzbar | ein Profil ohne Benutzer ließe sich nicht speichern |
| E7 | Doppelte Namen | werden in der Vorschau gemeldet; beim Import bekommt der Name eine Nummer (`Shop (2)`) | nichts wird überschrieben |
| E8 | Umgebungsvariablen | werden **beim Start gemerkt**, bevor `PG*` entfernt wird (Design 014 L1): `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`, `MYSQL_HOST`, `MYSQL_TCP_PORT`, `MYSQL_USER`, `MYSQL_PWD`, `MYSQL_DATABASE` | sonst gäbe es sie nach dem Start nicht mehr; im Speicher, nie in einer Datei |
| E9 | Eigener Export | JSON `{ format, version, profiles }` ohne Ids und ohne Geheimnisse (Profile halten keine); Import darüber wie jede andere Quelle | Umzug auf einen anderen Rechner |
| E10 | Bedienung | URL-Feld oben im Dialog „Neue Verbindung“ (Einfügen füllt sofort); Aktion `IMPORT_CONNECTIONS` öffnet den Import mit Vorschau und dem Export; eine fallengelassene `.db`/`.sqlite`-Datei öffnet den Dialog vorausgefüllt | – |

## Formate – woher sie stammen

Auf diesem Rechner gab es **keine Beispieldateien** von DBeaver, DataGrip oder TablePlus. Die Formate von
`data-sources.json` und `dataSources.xml` / `.local.xml` sind aus meiner Kenntnis nachgebaut (die Testdateien in
`import.rs` zeigen, was erwartet wird), **nicht an echten Dateien belegt**, wie es der Auftrag verlangt. `.pgpass`,
`pg_service.conf`, `.my.cnf` und die URL-Formen folgen der Dokumentation der Datenbanken.

## Nicht umgesetzt, nicht geprüft

- **TablePlus**: das Format der Export-Datei kenne ich nicht sicher genug, um es ohne Beispiel zu lesen.
- **Erkennen aus der Zwischenablage** („Verbindung aus Zwischenablage anlegen?“): Die App liest die Zwischenablage
  nicht ungefragt; das URL-Feld nimmt Eingefügtes.
- DBeaver-Benutzer (`credentials-config.json`, verschlüsselt) werden nicht gelesen.
- Der SSH-Tunnel wird nur aus DBeaver übernommen; `ProxyJump` gibt es nicht (014).
- Import und Dialog liefen nur in Komponententests mit Fake, nicht im Browser und nicht im nativen Fenster; der
  Datei-Drop einer Datenbankdatei ist ungeprüft.
