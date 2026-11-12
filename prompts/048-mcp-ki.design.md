# Design 048: KI-Anbindung über MCP

> **Status:** umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/mcp-ki` · Auftrag: [048-mcp-ki.md](048-mcp-ki.md) · Feature H3 · Beschreibung: `docs/mcp.md`

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Architektur | wie log-commander: Sidecar `schema-commander-mcp` (MCP über stdio) ↔ Brücke (TCP `127.0.0.1`, Token) ↔ App. Das Crate `src-tauri/mcp` (`sc-mcp`) ist von `lc-mcp` übernommen (gleicher Autor, MIT): `bridge`, `client`, `server`, `host`, `probe` – nur Standardbibliothek und serde | Aufgabe 1 |
| E2 | Wo die Werkzeuge laufen | **im Backend** (`src-tauri/src/mcp.rs`), nicht im Fenster wie bei log-commander: Der Schutz (012) wird im Backend durchgesetzt, also gehört die Freigabe der KI dorthin. Das Fenster bekommt nur, was den Nutzer braucht: Vorschläge und Text für einen Tab | Regel „Schutz im Backend“ |
| E3 | Aus heißt aus | Die Brücke entsteht erst mit `mcp_start`. Aus: kein Port, keine `mcp.json`, kein Sidecar erreicht die App. Die Einstellung `ai.enabled` ist `false` und wird von keinem Import gesetzt (`LOCAL_KEYS`) | Akzeptanzkriterium 1 |
| E4 | Freigabe | je Verbindung eine Stufe: aus / nur Struktur / lesen / Schreiben als Vorschlag. Vorgabe für ungeschützte Verbindungen: **aus**; geschützte sind aus, solange sie keine eigene Stufe haben; „nur lesen“ schreibt nie. Eine Verbindung, die aus ist, wird nicht genannt, und antwortet wie eine, die es nicht gibt | Aufgabe 3 |
| E5 | Lesend | `run_query`: eine Anweisung, die `guard::classify` als lesend einstuft, durch `admit`, auf eigener Sitzung (`sc-mcp`), die auf dem Server nur lesen darf (`guard::read_only_statement`; SQL Server: Transaktion mit Rollback), 30 s | Aufgabe 3 |
| E6 | Schreibend | nie direkt. `propose_query` reicht die Anweisung ans Fenster; der Nutzer sieht Anweisung, Verbindung, Begründung (als Text) und wählt Ausführen / nur in einen Tab / Ablehnen. Ausführen = ein Tab und `tab.run` – der Weg jeder getippten Anweisung, mit Schutz und Verlauf | Aufgabe 2, 6; Akzeptanzkriterium 2 |
| E7 | Grenzen | Zeilen (Vorgabe 200, höchstens 1 000), Zeichen je Antwort (100 000), je Wert (2 000), Antwort höchstens 1 MB; was fehlt, sagt die Antwort. Spalten nach Namensmuster als `[hidden]`; „nur Struktur“ lässt keine Anweisung laufen | Aufgabe 5, Akzeptanzkriterium 3 |
| E8 | Sichtbar | Statuszeile „KI verbunden“; Protokoll jedes Aufrufs (Werkzeug, Verbindung, Anweisung, Zeilen, Ausgang) im Dialog, nur im Speicher (500 Einträge); „Trennen“; Verbindungstest (`probe`) | Aufgabe 4 |
| E9 | Daten ≠ Anweisungen | Die App führt nichts aus, was in Daten steht. Antworten mit Zeilen tragen den Hinweis, die Einweisung (`INSTRUCTIONS`) sagt es. Die Begründung eines Vorschlags ist Text des Assistenten: Der Dialog sagt, dass die Anweisung zählt | Aufgabe 6 |
| E10 | Bündeln | `scripts/mcp-sidecar.mjs` baut das Sidecar nach `src-tauri/binaries/`; `tauri.sidecar.conf.json` nimmt es als `externalBin`; der Release-Workflow ruft beides. `pnpm tauri dev`/`build` ohne die Datei bleibt, wie es war. Workspace: `pnpm rust:*` prüfen jetzt beide Crates | Aufgabe 1 |
| E11 | Eingebaute KI-Funktionen (Aufgabe 7) | **nicht gebaut** – der Auftrag verlangt dafür eine Freigabe. Darlegung unten | Aufgabe 7 |

## Aufgabe 7: „Abfrage erklären“, „Text → SQL“ (nur dargelegt)

- **Was es wäre**: zwei Aktionen, die Text an eine Sprachmodell-API senden – die Anweisung (erklären) bzw. eine
  Frage und die Struktur der Tabellen (Text → SQL). Das Ergebnis landet als Text im Tab, nie ausgeführt.
- **Anbieter**: mit eigenem Schlüssel des Nutzers; nahe liegt die Anthropic-API (aktuelle Claude-Modelle), der
  Aufbau erlaubte auch andere. Der Schlüssel läge im Schlüsselbund wie die Passwörter.
- **Kosten**: nach Verbrauch, beim Nutzer; eine Strukturbeschreibung großer Schemata kostet bei jedem Aufruf.
- **Datenschutz**: Namen von Tabellen und Spalten und die Anweisung verlassen den Rechner – auch ohne MCP. Das
  wäre ein zweiter, eigener Weg für Daten nach außen, mit eigener Einstellung und eigenem Hinweis; die CSP
  bräuchte ein `connect-src` für den Anbieter oder der Aufruf liefe im Backend (neue Abhängigkeit: ein
  HTTP-Client).
- **Empfehlung**: nicht bauen, solange MCP reicht – ein Assistent mit MCP kann beides schon, mit den Freigaben
  dieses Prompts und ohne dass die App einen Schlüssel hält.

## Geprüft

- `pnpm check` grün (beide Crates).
- `sc-mcp`: 31 Tests – Brücke (Token, Datei `0600`, Kennung der App), Host (Token, Grenzen, Trennen), Client,
  Server (eine Sitzung wie Claude Code sie führt), Probe, Werkzeug-Schnappschuss.
- `mcp.rs`: 16 Tests gegen die Demo-Datenbank – jede Stufe, aus = nichts (und nicht zu unterscheiden von
  „gibt es nicht“), Schreibendes läuft nie direkt (auch nicht hinter `SELECT 1;`), **1 Mio. Zeilen geben die
  Grenze und den Hinweis**, lange Werte und Antworten, versteckte Spalten, „nur Struktur“, Vorschlag angenommen /
  abgelehnt / ohne Fenster, Protokoll, nicht geöffnete und geschützte Verbindung.
- `tests/mcp_bridge.rs`: der ganze Weg ohne Fenster – Zeilen eines MCP-Clients → Server des Sidecars → Brücke →
  Werkzeuge → Demo-Datenbank: Schema lesen, `SELECT` ausführen, `UPDATE` wird abgelehnt und als Vorschlag
  gereicht, die Daten sind unverändert. **Aus: keine Datei, der Port weist ab**; falsches Token: abgewiesen.
- Frontend: `mcp-logic.spec.ts` (8), `mcp-dialog.spec.ts` (10): aus beim Start, ein/aus und merken, jede Änderung
  geht ans Backend, Verbindungstest, Protokoll (Text statt Markup), Text in einen Tab ohne Lauf, **Vorschlag
  läuft erst nach dem Klick**, ablehnen / nur öffnen.
- **Browser** (Dev-Server, Backend nachgestellt): vor dem Einschalten nur `mcp_status`; einschalten →
  `mcp_subscribe`, `mcp_start`; Stufe ändern → `mcp_configure`; „KI verbunden“ in der Statuszeile; Protokoll mit
  abgelehntem Aufruf; Vorschlagsdialog mit Fokus auf „Ablehnen“, Begründung mit `<b>` als Text.
- Das gebaute Sidecar über stdio von Hand: `initialize` antwortet, ein Werkzeug ohne laufende App meldet
  `not_running`.

## Review (zweiter Agent, nur lesend)

_(wird nach dem Review eingetragen)_

## Nicht geprüft

- Das native Fenster wurde nicht bedient: Das echte Sidecar gegen die echte App (Verbindungstest, Claude Code als
  Client) ist nicht gelaufen.
- Die Werkzeuge gegen PostgreSQL, MySQL, SQL Server (die Sitzung „nur lesen“ je Server ist aus 012 getestet;
  `run_query` über MCP lief nur gegen SQLite).
- Das Bündeln mit `externalBin` und der Release-Workflow (kein Paket gebaut, kein Tag).
- Windows (Datei ohne `0600`: dort schützt der Ordner des Benutzers).

## Nicht umgesetzt

- Aufgabe 7 (siehe oben).
- Versteckte Spalten sind ein Filter über **Namen**: Alias und Ausdrücke umgehen ihn (`docs/mcp.md` sagt es).
- Ein Vorschlag gibt dem Assistenten keine Zeilen zurück, nur den Ausgang; lesen geht über `run_query`.
- `pnpm version:set` setzt die Version von `sc-mcp` nicht mit (das Sidecar nennt seine eigene).
- Protokoll über einen Neustart hinweg (bewusst: nur im Speicher).
