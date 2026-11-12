# Prompt 046: Server-Monitor

> **Slug:** `server-monitor` · **Feature:** H1 · **Braucht:** 003, 012 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: HeidiSQL (Prozessliste), pgAdmin (Dashboard), DBeaver (Session
> Manager, Lock Manager), SSMS (Aktivitätsmonitor).

## Ziel

Sehen, was auf dem Server gerade passiert: **Sitzungen und laufende Abfragen, Sperren, wer blockiert wen** – und eine
Abfrage oder Sitzung beenden können.

## Aufgaben

1. **Daten je Datenbank**: PostgreSQL (`pg_stat_activity`, `pg_locks`, `pg_blocking_pids`), MySQL/MariaDB
   (`information_schema.processlist`/`performance_schema`, InnoDB-Sperren), SQL Server (`sys.dm_exec_requests`,
   `sys.dm_exec_sessions`, `sys.dm_tran_locks`), SQLite: entfällt (Ansicht ausgeblendet). Eigene Verbindung für den
   Monitor, damit er die Tabs nicht stört.
2. **Ansicht als Tab**: GuiExpert Table der Sitzungen (Id, Benutzer, Datenbank, Anwendung, Client, Zustand, Dauer
   der Abfrage/Transaktion, Warte-Ereignis, Anfang der Anweisung), sortier- und filterbar; eigene Sitzungen der App
   gekennzeichnet; volle Anweisung im Nur-Lesen-Editor.
3. **Sperren**: Baum „blockiert ← wird blockiert von“, lange wartende und lange offene Transaktionen hervorgehoben.
4. **Auffrischen**: von Hand und im Takt (Einstellung, Vorgabe aus; Pause bei verstecktem Tab); Zeilen behalten ihre
   Position/Auswahl über das Auffrischen.
5. **Eingreifen**: Abfrage abbrechen, Sitzung beenden – mit Bestätigung, die Benutzer, Dauer und Anweisung zeigt;
   Schutzregeln aus Prompt 012; fehlende Rechte verständlich melden.
6. **Kennzahlen** klein halten: Verbindungen (aktiv/gesamt/Limit), Transaktionen/s, Datenbankgröße, Version, Laufzeit
   – als Zahlen, optional kleine Verlaufslinien (Prompt 042).
7. Anweisungen anderer Nutzer sind fremde Daten: nicht in Verlauf oder Logs schreiben.

## Akzeptanzkriterien

- Zwei Test-Sitzungen, die sich blockieren, erscheinen als Blockade; Beenden der blockierenden löst die andere.
- Auffrischen im Sekundentakt bei 500 Sitzungen flackert nicht und verliert die Auswahl nicht.
- Ohne die nötigen Rechte zeigt die Ansicht, was sichtbar ist, und sagt, was fehlt.

## Tests

Rust gegen Container: Abfragen je Datenbank/Version, Blockade-Baum, Abbrechen/Beenden. Frontend: Auffrischen mit Fake.
