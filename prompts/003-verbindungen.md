# Prompt 003: Verbindungen und Schlüsselbund

> **Slug:** `verbindungen` · **Features:** A1, A2 · **Braucht:** 002 · **Umfang:** L
> Lies zuerst `prompts/000-arbeitsweise.md`, `docs/architecture.md` („Offene Architekturfragen“). Vorbild: TablePlus
> (Verbindungsliste, Farben), DBeaver (Treibervielfalt). Erprobter Code: `log-commander/src-tauri/Cargo.toml`
> (sqlx-postgres, sqlx-mysql, tiberius, rusqlite, keyring-core + Stores je OS, zeroize) und
> `log-commander/prompts/done/019-datenbank-logs.design.md` (Spike zu den Treibern), `scripts/db-test-servers.sh`.

## Ziel

Echte Datenbanken statt der Demo: Verbindungsprofile anlegen, testen, gruppieren, mit Farbmarke; verbinden und
trennen; Passwörter nur im Schlüsselbund. Treiber: **PostgreSQL, SQLite, MySQL/MariaDB, SQL Server**.

## Aufgaben

1. **Treiberschicht in Rust**: ein Trait (Arbeitsname `Driver`/`Session`) mit gleicher Signatur je Datenbank:
   verbinden, pingen, Anweisung ausführen (Spalten + Zeilenstrom), abbrechen, Serverversion, schließen. Reines Rust,
   TLS über rustls mit den Wurzelzertifikaten des Systems, kein OpenSSL. `demo_db.rs` wird der SQLite-Treiber bzw.
   bleibt als eingebaute Demo-Verbindung.
2. **Typen**: ein gemeinsames `Cell`-Modell für alle Treiber (NULL, Ganzzahl inkl. 64 Bit ohne Verlust, Dezimal als
   Text, Gleitkomma, Text, Bool, Datum/Zeit/Zeitzone, UUID, JSON, Binär, Array, unbekannt als Text). Tabelle
   „Datenbanktyp → Cell“ je Treiber im Design.
3. **Verbindungsverwaltung**: `ConnectionManager` (State) mit Sitzungen je Id; Zeitlimits für Verbinden; saubere
   Fehlercodes (`connection_failed`, `auth_failed`, `tls_failed`, `timeout`, `unknown_connection` …) in `error.rs` und
   `app-error.ts`.
4. **Profile**: Name, Treiber, Host, Port, Datenbank, Benutzer, Optionen, Ordner, Farbe (`conn-1…8`); gespeichert als
   Datei im Konfigurationsordner – **ohne Geheimnisse**.
5. **Schlüsselbund**: Passwort speichern nur auf Wunsch; sonst bei jedem Verbinden fragen. Kein Schlüsselbund
   verfügbar (Linux ohne Secret Service) → klare Meldung, kein stilles Ablegen in einer Datei.
6. **Frontend**: Verbindungsliste in der Seitenleiste (Ordner, Farbe, Zustand), Dialog „Verbindung“ mit
   „Testen“, Passwortabfrage, Aktionen Verbinden/Trennen/Bearbeiten/Duplizieren/Löschen. Die Toolbar zeigt die aktive
   Verbindung mit ihrer Farbe.
7. **Testserver**: Skript mit Containern für PostgreSQL, MySQL, MariaDB, SQL Server und Testdaten (Unicode, alle
   Typen, große Tabelle).

## Entscheidungsfragen (Design)

- `sqlx`-Unterkrates wie log-commander oder `tokio-postgres`/`mysql_async` direkt? (Abbruch von Abfragen, Streaming,
  Typabdeckung, Konflikt zweier `links = "sqlite3"`.)
- Eine Verbindung je Tab oder ein kleiner Pool je Profil? (Wichtig für Transaktionen, Prompt 013.)
- Wie werden 64-Bit-Zahlen und Dezimalzahlen ohne Verlust über die JSON-Brücke geschickt?
- Format und Ort der Profildatei; Migration späterer Versionen.

## Akzeptanzkriterien

- Zu jeder der vier Datenbanken verbinden, `SELECT` mit allen Typen der Testtabelle ausführen, trennen.
- Falsches Passwort, falscher Host, abgelaufenes Zertifikat, Zeitüberschreitung: je eine verständliche Meldung, das
  Fenster bleibt bedienbar.
- In keiner Datei, keinem Log und keinem Event steht ein Passwort (Test, der Profile und Fehlertexte durchsucht).

## Tests und Review

Rust: Typabbildung je Treiber gegen die Container, Fehlerfälle, Abbruch beim Verbinden. Frontend: Liste und Dialog
mit Fake-Fassade. **Review durch einen zweiten Agenten**: Geheimnisse (Speicher, Logs, Fehlertexte), TLS-Prüfung,
Eingaben aus dem Profil (Host, Optionen) werden nie zu Shell- oder SQL-Text.
