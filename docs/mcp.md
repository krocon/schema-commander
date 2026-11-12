# KI-Steuerung über MCP

Ein KI-Assistent auf demselben Rechner (Claude Code u. a.) kann Schema Commander über das
[Model Context Protocol](https://modelcontextprotocol.io) benutzen: Struktur lesen, lesende Abfragen ausführen,
Anweisungen **vorschlagen**. Standardmäßig **aus**. Prompt 048, Design `prompts/done/048-mcp-ki.design.md`.

## Aufbau

```
Assistent ──stdio (MCP)──▶ schema-commander-mcp ──TCP 127.0.0.1 + Token──▶ App (Brücke) ──▶ Werkzeuge im Backend
                           (Sidecar, neben der App)                         src-tauri/src/mcp.rs
```

- Das **Sidecar** (`src-tauri/mcp`, Crate `sc-mcp`, nur Standardbibliothek und serde) spricht MCP über stdio und
  reicht jeden Aufruf über die Brücke an die laufende App. Es kennt keine Datenbank und schreibt nichts mit.
- Die **Brücke** lauscht nur, solange die KI-Steuerung an ist, nur auf `127.0.0.1`, auf einem zufälligen Port.
  Port und ein frisches Token (256 Bit) stehen in `mcp.json` im Konfigurationsordner der App, lesbar nur für den
  Benutzer (Unix: `0600`). Aus: kein Port, keine Datei.
- Die **Werkzeuge** laufen im Backend (`mcp.rs`). Dort – und nur dort – wird entschieden, was eine Verbindung
  erlaubt.

## Einrichten

1. Menü **Schema → KI-Steuerung (MCP) …**, einschalten.
2. Je Verbindung festlegen, was ein Assistent darf.
3. „Befehl für Claude Code kopieren“ und im Terminal ausführen
   (`claude mcp add schema-commander -- <Pfad>/schema-commander-mcp`), oder den Eintrag für die
   Konfigurationsdatei eines anderen Assistenten kopieren.
4. „Verbindung testen“ startet das Sidecar wie ein Assistent und fragt die App durch es hindurch.

In der Entwicklung liegt das Sidecar nach `pnpm mcp:dev` in `src-tauri/target/debug`. Für ein Paket baut
`node scripts/mcp-sidecar.mjs [Ziel]` es nach `src-tauri/binaries/`; gebündelt wird es mit
`--config src-tauri/tauri.sidecar.conf.json` (so macht es der Release-Workflow).

## Freigabe je Verbindung

| Stufe | erlaubt |
|---|---|
| aus | nichts – die Verbindung wird nicht einmal genannt |
| nur Struktur | Schemata, Tabellen, Spalten, Schlüssel, DDL |
| lesende Abfragen | dazu `run_query` und `explain_query` |
| Schreiben als Vorschlag | dazu Vorschläge, die schreiben – jeder einzeln vom Nutzer bestätigt |

- Eine Verbindung mit Schutzstufe (Rückfrage, nur lesen) ist **aus**, solange der Nutzer ihr keine eigene Stufe
  gibt; die Vorgabe gilt nur für Verbindungen ohne Schutz – und ist selbst „aus“.
- Eine Verbindung „nur lesen“ schreibt nie, auch nicht als Vorschlag.
- Der Assistent öffnet keine Verbindung: Er arbeitet nur auf denen, die der Nutzer geöffnet hat.

## Werkzeuge

| Werkzeug | Stufe | was es tut |
|---|---|---|
| `status` | – | Version und Grenzen |
| `list_connections` | – | Id, Name, Art, offen, Stufe – ohne Host, Benutzer, Passwort |
| `get_schema` | Struktur | Schemata bzw. Objekte eines Schemas |
| `describe_table` | Struktur | Spalten, Schlüssel, Beziehungen, DDL |
| `run_query` | lesen | **eine** lesende Anweisung, begrenzt |
| `explain_query` | lesen | geschätzter Plan, ohne Ausführung |
| `write_to_tab` | Struktur (mit Verbindung) | Text in einen neuen Tab – nichts läuft |
| `propose_query` | lesen / schreiben | Vorschlag an den Nutzer; läuft erst nach Klick |

`tools.snapshot.json` hält die Beschreibungen fest; eine Änderung ist eine Entscheidung
(`UPDATE_SNAPSHOT=1 cargo test -p sc-mcp`).

## Was lesend heißt

`run_query` nimmt nur, was der Schutz (`guard::classify`, Prompt 012) als lesend einstuft, und führt es auf einer
eigenen Sitzung aus, die **auf dem Server** nur lesen darf (PostgreSQL `default_transaction_read_only`, MySQL
`SET SESSION TRANSACTION READ ONLY`, SQLite `query_only`; SQL Server kennt das nicht: dort läuft die Anweisung in
einer Transaktion, die zurückgerollt wird). Höchstens 30 Sekunden.

## Was hinaus darf

- Zeilen je Antwort (Vorgabe 200, höchstens 1 000), Zeichen je Antwort (Vorgabe 100 000), Zeichen je Wert (2 000).
  Was abgeschnitten wurde, sagt die Antwort (`truncated`, Hinweise).
- Spalten, deren **Name** `password`, `passwd`, `pwd`, `secret`, `token`, `api_key`, `private_key`, `credential`
  oder ein Muster des Nutzers enthält, kommen als `[hidden]`. Das ist ein Filter über Namen: Ein Alias
  (`SELECT password AS x`) oder ein Ausdruck umgeht ihn. Wer sicher sein will, gibt der Verbindung „nur Struktur“
  oder legt dem Assistenten einen eigenen Datenbankbenutzer ohne Recht auf diese Spalten an.
- „Nur Struktur, nie Daten“: Keine Anweisung des Assistenten läuft.
- Was ein Assistent liest, geht an den Assistenten und damit an dessen Anbieter.

## Vorschläge

Was schreibt, läuft nie direkt. `propose_query` zeigt dem Nutzer Anweisung, Verbindung und die Begründung des
Assistenten (als Text). „Ausführen“ öffnet einen Tab und führt die Anweisung aus wie eine getippte – mit dem
Schutz der Verbindung, im Verlauf des Nutzers. Der Assistent erfährt: angenommen oder nicht, betroffene Zeilen
oder der Fehler.

## Sichtbarkeit

- Statuszeile: „KI verbunden“, solange ein Assistent verbunden ist.
- Protokoll im Dialog: jeder Aufruf mit Werkzeug, Verbindung, Anweisung, Zeilen, Ausgang – nur im Speicher.
- „Trennen“ kappt alle Assistenten; ausschalten schließt Port und Datei.

## Daten sind keine Anweisungen

Text aus einer Datenbank – Werte, Namen, Kommentare – kann so tun, als wäre er eine Anweisung an den Assistenten.
Die App führt nichts aus, was in Daten steht; die Antworten und die Einweisung des Assistenten sagen ihm, dass
Werte Daten sind. Ob er sich daran hält, liegt nicht bei der App: Darum braucht alles Schreibende den Klick des
Nutzers auf eine Anweisung, die er selbst lesen kann.
