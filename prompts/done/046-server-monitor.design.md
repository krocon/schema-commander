# Design 046: Server-Monitor

> **Status:** umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/server-monitor` · Auftrag: [046-server-monitor.md](046-server-monitor.md) · Feature H1

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Daten | `db/monitor.rs` liest je Datenbank eine **Lesung** (`Activity`): PostgreSQL `pg_stat_activity` mit `pg_blocking_pids`; MySQL die Prozessliste mit `INNODB_TRX` und `performance_schema.data_lock_waits`, MariaDB `INNODB_LOCK_WAITS`; SQL Server `sys.dm_exec_sessions`/`_requests` mit `blocking_session_id`. CockroachDB und TimescaleDB gehen den Weg von PostgreSQL. SQLite: `unsupported`, die Aktion ist dort aus | Aufgabe 1 |
| E2 | Eigene Sitzung | Der Monitor fragt auf einer eigenen Sitzung der Verbindung (`sc-monitor`, über `ask_in`); sie geht, wenn der Monitor schließt (`monitor_close`). Kein Tab wartet auf ihn | Aufgabe 1 |
| E3 | Teile | Jeder Teil (Sitzungen, Sperren, Transaktionen, Kennzahlen) wird für sich gelesen. Scheitert einer, steht er mit dem Grund der Datenbank in `missing` – der Rest wird gezeigt | Akzeptanzkriterium 3 |
| E4 | Ansicht | ein **Dialog** statt eines Tabs: Ein Tab ist hier ein `QueryTab` mit Editor, Sitzung und Sicherung; der Monitor ist nichts davon. Aufgerufen über die Aktion `SERVER_MONITOR` (Menü Schema, Palette) | Abweichung von Aufgabe 2, siehe „Nicht umgesetzt“ |
| E5 | Tabelle | eine schlichte HTML-Tabelle, Zeilen **nach der Id der Sitzung** (`track s.id`): Eine neue Lesung ändert nur, was sich geändert hat – nichts flackert, die Auswahl (ebenfalls die Id) und die Ordnung bleiben. Höchstens 1 000 Sitzungen je Lesung (`cut`). Die GuiExpert Table baut bei einem neuen Modell neu auf; für einige hundert Zeilen, die sich im Sekundentakt ändern, ist die einfache Tabelle der ruhigere Weg | Aufgabe 4, Akzeptanzkriterium 2 |
| E6 | Ordnen, Filtern | im Fenster über die Lesung (`monitor-logic.ts`): Ids als Zahlen, Dauern mit der längsten zuerst, ohne Wert zuletzt; Filter über jeden Text; „nur Sitzungen, die etwas tun“ | Aufgabe 2 |
| E7 | Blockaden | `blockTree`: oben, wer aufhält und selbst nicht wartet, darunter, wer auf ihn wartet. Ein Kreis wird dort geschnitten, wo er sich schließt. Wartende rot markiert, lange Anweisungen (≥ 1 min) und lange offene Transaktionen (≥ 5 min) markiert – auch als Text für Screenreader | Aufgabe 3 |
| E8 | Auffrischen | von Hand oder im Takt (aus, 1, 2, 5, 10, 30 s; Einstellung `monitorIntervalSec`, Vorgabe aus). Nie zwei Lesungen zugleich; keine, solange die Seite versteckt ist; eine Antwort nach dem Schließen wird verworfen | Aufgabe 4 |
| E9 | Eingreifen | „Ihre Anweisung abbrechen“ (wo der Server das kann: nicht SQL Server) und „Sitzung beenden“. Vorher die Rückfrage mit Benutzer, Dauer und Anweisung. Die Id der Sitzung wird im Backend als Zahl gelesen, bevor sie in `KILL`/`pg_terminate_backend` steht. Eine Verbindung „nur lesen“ beendet nichts – das Backend lehnt ab, das Fenster bietet es nicht an. Die Sitzung des Monitors selbst ist nicht zu beenden | Aufgabe 5 |
| E10 | Kennzahlen | Verbindungen (von Limit), Transaktionen/s (aus zwei Lesungen des Zählers; nach einem Neustart des Servers keine Zahl statt einer falschen), Größe der Datenbank, Laufzeit, Version – als Zahlen | Aufgabe 6 |
| E11 | Fremde Daten | Anweisungen anderer stehen nur auf dem Schirm, als Text (nie als Markup): nicht im Verlauf, in keinem Log, nicht in der Sitzung. Der Monitor zeichnet nichts auf | Aufgabe 7 |

## Was die Datenbanken zeigten

- **MariaDB** nennt eine Blockade noch einen Augenblick, nachdem die blockierende Sitzung beendet ist: Der Test
  fragt, bis sie fort ist.
- **SQL Server** zeigt eine Anweisung in ihrer parametrisierten Form (`@1` statt des Werts) und kann eine
  Anweisung nur zusammen mit ihrer Sitzung beenden (`canCancel: false`).
- **MySQL 8** hält die Wartenden in `performance_schema.data_lock_waits`, MariaDB in
  `information_schema.INNODB_LOCK_WAITS` – entschieden nach dem `Flavor` der Sitzung.

## Geprüft

- `pnpm check` grün; Rust: 3 Tests in `db/monitor.rs` (Anweisungen zum Beenden, Id nur als Zahl).
- **Container** (`pnpm rust:test:db`): `sessions_that_block_each_other_are_seen_and_can_be_ended` auf PostgreSQL,
  MySQL, MariaDB und SQL Server – zwei Sitzungen blockieren sich, die Lesung zeigt, wer auf wen wartet, das
  Beenden der blockierenden löst die andere.
- Frontend: `monitor-logic.spec.ts` (11), `monitor-dialog.spec.ts` (9): Ordnung und Auswahl über eine neue Lesung,
  Filter, Rückfrage vor dem Beenden, nichts bei „nur lesen“ und für die eigene Sitzung, Text statt Markup, nie
  zwei Lesungen zugleich.
- **Browser** (Dev-Server, Backend nachgestellt): Dialog mit sechs Sitzungen, Baum über drei Stufen, Takt 2 s
  – Auswahl und Anweisung bleiben, Rate 120/s aus dem Zähler, „nicht lesbar (locks)“ erscheint, `<b>`/`<img>`
  im Benutzer und in der Anweisung bleiben Text, Rückfrage vor dem Beenden, danach `monitor_kill` mit der Id.

## Nicht geprüft

- Das native Fenster wurde nicht bedient.
- 500 Sitzungen im Sekundentakt wurden nicht gemessen (die Tabelle hält ihre Zeilen über die Id; gemessen ist
  das nicht).
- Ein Benutzer mit weniger Rechten gegen die Container (der Weg `missing` ist gebaut und im Fenster geprüft,
  aber nicht mit einem echten eingeschränkten Konto).
- CockroachDB und TimescaleDB mit dem Blockade-Test.

## Nicht umgesetzt

- **Ansicht als Tab mit GuiExpert Table** (E4, E5): ein Dialog mit einfacher Tabelle.
- **Volle Anweisung im Nur-Lesen-Editor**: Sie steht als Text (`<pre>`), ohne Hervorhebung.
- **Verlaufslinien** der Kennzahlen (im Auftrag „optional“).
- `pg_locks`/`sys.dm_tran_locks` als eigene Liste der Sperren: gezeigt wird, wer auf wen wartet, nicht jede Sperre.
- Die Rückfrage zeigt ihre Zeilen (Benutzer, Dauer, Anweisung) hintereinander – der gemeinsame Dialog bricht nicht um.
