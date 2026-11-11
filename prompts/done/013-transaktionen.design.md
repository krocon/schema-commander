# Design 013: Transaktionen sichtbar machen

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/transaktionen` · Auftrag: [013-transaktionen.md](013-transaktionen.md) · Feature C10

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Sitzung je Tab | **Jeder Tab hat seine eigene Sitzung** (Schlüssel `Verbindung#Tab`), geöffnet beim ersten Lauf. Die Sitzung der Verbindung selbst bleibt für die Fragen der App (Baum, Export). Ändert A15 aus Design 003 („eine Sitzung je Profil“) | eine Transaktion gehört genau einem Tab; der Baum wartet nicht mehr hinter einer laufenden Anweisung und berührt keine Transaktion (Empfehlung des Auftrags) |
| E2 | Passwort für weitere Sitzungen | bleibt, solange die Verbindung offen ist, als `Secret` im Speicher des `ConnectionManager`; beim Trennen gelöscht (zeroize) | sonst fragte jeder neue Tab nach dem Passwort; nie in einer Datei, nie im Frontend |
| E3 | Demo-Datenbank | hat **eine** Sitzung für alle Tabs | sie lebt im Speicher: jede weitere Sitzung wäre eine andere Datenbank |
| E4 | Zustand: woher? | **vom Server**, nach jedem Lauf gefragt (`Session::transaction_state`): `idle`, `active`, `failed`, `unknown`. Die Treiber geben den Zustand aus dem Protokoll nicht heraus (`sqlx` hält ihn privat), also fragt eine winzige Anweisung: PostgreSQL `now() <> statement_timestamp()` über das einfache Protokoll, im Fehlerfall 25P02 = `failed`; MariaDB `@@in_transaction`; MySQL `performance_schema.events_transactions_current`; SQL Server `@@TRANCOUNT`, `XACT_STATE()`; SQLite `is_autocommit()` | nicht geraten: selbst getipptes `BEGIN`/`COMMIT`, Savepoints, ein Fehler in PostgreSQL und das stille Commit einer MySQL-DDL stimmen damit von selbst (Tests gegen alle vier Server). Kostet einen Umlauf je Anweisung |
| E5 | Manueller Modus | je Tab umschaltbar (`Tx: auto` / `Tx: manuell`). Manuell: ist keine Transaktion offen, schickt das Backend vor der Anweisung `BEGIN` / `START TRANSACTION` / `BEGIN TRANSACTION` – außer die Anweisung ist selbst Transaktionssteuerung | ein Weg für alle vier Datenbanken, ohne Server-Einstellungen (`autocommit`, `IMPLICIT_TRANSACTIONS`) zu verstellen |
| E6 | Skript mit eigenem `COMMIT` im manuellen Modus | läuft, wie es dasteht: das `COMMIT` beendet die Transaktion, die nächste Anweisung öffnet eine neue | der Text des Nutzers gilt; die Anzeige folgt dem Server |
| E7 | Anzeige | „TX“ am Reiter; Statuszeile „Transaktion offen seit 2 min · 3 Anweisungen“, nach `txWarnMinutes` (5) „– sie hält Sperren“; fehlgeschlagen: rot, „nur Rollback möglich“, Commit gesperrt; Knöpfe Commit/Rollback in der Toolbar, solange etwas offen ist | Auftrag |
| E8 | Schließen | Tab und Fenster fragen bei offener Transaktion: **Commit / Rollback / Abbrechen** (bei fehlgeschlagener nur Rollback); die Antwort wird ausgeführt, scheitert sie, bleibt alles offen. Das Fenster über `onCloseRequested` (Capability `core:window:allow-destroy`) | Auftrag |
| E9 | Verbindung wechseln | Ein Tab mit offener Transaktion bleibt auf seiner Verbindung, bis sie beendet ist; sonst schließt der Wechsel seine alte Sitzung | die Transaktion läge sonst unsichtbar auf der alten Verbindung |
| E10 | Verbindung verloren | war eine Transaktion offen, sagt eine Meldung, dass sie zurückgerollt oder ihr Stand unbekannt ist | Auftrag |

Aktionen: `TX_COMMIT` (`Mod+Alt+C`), `TX_ROLLBACK` (`Mod+Alt+R`), `TOGGLE_AUTOCOMMIT`.

## Geprüft

- Rust mit SQLite-Dateien: eine Änderung im manuellen Modus sieht ein zweiter Tab nicht, nach Commit schon, nach
  Rollback nie; Zustand nach getipptem `BEGIN`, Savepoint, `COMMIT`; Schließen von Sitzung und Verbindung.
- Rust gegen die Container (`pnpm rust:test:db`, 21 Tests): Zustand nach jedem Schritt auf PostgreSQL (auch `failed`
  und zurück über einen Savepoint), MySQL und MariaDB (auch stilles Commit durch DDL, `autocommit = 0`), SQL Server.
  Dazu, aus 012 nachgeholt: `nur lesen` lehnt auf PostgreSQL, MySQL und MariaDB Schreiben auf dem Server ab.
- Frontend: Zustand, Commit/Rollback, Fragen beim Schließen (alle drei Antworten), verlorene Verbindung, Wechsel der
  Verbindung – mit Fake. Im Browser mit nachgebildetem Backend: Knöpfe, Reiter, Statuszeile.

## Nicht umgesetzt, nicht geprüft

- **Isolationsstufe** wählen und **Vorgabe je Profil** für den Modus; der Modus eines Tabs überlebt keinen Neustart.
- **Verbindung trennen** mit offenen Transaktionen fragt nicht (Tab und Fenster fragen).
- MySQL ohne Zugriff auf das `performance_schema` meldet `unknown`; die Anzeige sagt das.
- Je Tab eine Verbindung zum Server: bei vielen Tabs viele Verbindungen (keine Obergrenze).
- Der Zustand kostet einen Umlauf je Anweisung; bei Skripten mit sehr vielen kleinen Anweisungen ungemessen.
- Das Fragen beim Schließen des **Fensters** (`onCloseRequested`, `destroy`) lief nie im nativen Fenster.
