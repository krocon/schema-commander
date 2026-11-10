# Prompt 013: Transaktionen sichtbar machen

> **Slug:** `transaktionen` · **Feature:** C10 · **Braucht:** 005 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DataGrip (Tx-Modus je Konsole), Oracle SQL Developer.

## Ziel

Man weiß immer, ob eine Transaktion offen ist, und beendet sie bewusst: Auto-Commit je Tab umschaltbar, Knöpfe
**Commit** und **Rollback**, deutliche Anzeige, Warnung beim Schließen.

## Aufgaben

1. **Sitzung je Tab**: Ein Tab im manuellen Modus braucht eine eigene, feste Verbindung (Entscheidung aus Prompt 003
   prüfen). Zustand der Sitzung verfolgen: ruhend / in Transaktion / in fehlgeschlagener Transaktion (PostgreSQL) –
   aus dem Protokoll des Treibers, nicht geraten.
2. **Modi**: Auto-Commit (Vorgabe) und manuell; Vorgabe je Profil; Isolationsstufe wählbar.
3. **Erkennen** von `BEGIN`/`COMMIT`/`ROLLBACK`/Savepoints, die der Nutzer selbst tippt, und von impliziten Commits
   (MySQL-DDL).
4. **Anzeige**: Zustand am Reiter und in der Statuszeile (Dauer der offenen Transaktion, Zahl der Anweisungen);
   Aktionen `COMMIT`, `ROLLBACK` mit Kürzeln; nach einem Fehler in PostgreSQL klarer Hinweis „nur Rollback möglich“.
5. **Schutz vor Vergessen**: Warnung beim Schließen von Tab/Fenster/Verbindung mit offener Transaktion (Commit,
   Rollback, Abbrechen); Hinweis, wenn eine Transaktion länger als *n* Minuten offen ist (hält Sperren).
6. Verbindungsabbruch mitten in der Transaktion: klar melden, dass der Stand unbekannt bzw. zurückgerollt ist.

## Entscheidungsfragen (Design)

- Was tut „Ausführen“ im manuellen Modus bei einem Skript mit eigenem `COMMIT`?
- Bekommt jede Hintergrundabfrage der App (Baum, Vervollständigung) eine eigene Verbindung, damit sie die
  Transaktion des Tabs nicht berührt? (Empfehlung: ja.)

## Akzeptanzkriterien

- `UPDATE` im manuellen Modus ist in einem zweiten Tab nicht sichtbar, nach Commit schon; nach Rollback nie.
- Fenster schließen mit offener Transaktion fragt nach; die gewählte Antwort wird ausgeführt.
- Der angezeigte Zustand stimmt nach jedem der Fälle: Fehler in der Transaktion, selbst getipptes `COMMIT`,
  Savepoint, DDL in MySQL.

## Tests

Rust gegen Container: Zustandsautomat je Treiber. Frontend: Anzeige und Warnungen mit Fake.
