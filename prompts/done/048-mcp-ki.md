# Prompt 048: KI-Anbindung über MCP

> **Slug:** `mcp-ki` · **Feature:** H3 · **Braucht:** 005, 008, 012 · **Umfang:** M–L
> Lies zuerst `prompts/000-arbeitsweise.md`, `docs/best-practices.md` §6. Vorbild und Quelle:
> `log-commander/docs/mcp.md`, `log-commander/src-tauri/mcp/` (Sidecar + Brücke), `src-tauri/src/mcp.rs`,
> `src/app/features/mcp/` (Vorschlagsdialog, Verlauf), `scripts/mcp-sidecar.mjs`; `editlicious/docs/mcp.md`; fnf Prompt 071.

## Ziel

Ein KI-Assistent (Claude Code u. a.) kann Schema Commander über das **Model Context Protocol** benutzen: Schema lesen,
Abfragen vorschlagen und – nur mit Freigabe – ausführen. **Standardmäßig aus**; der Nutzer sieht und steuert alles.

## Aufgaben

1. **Architektur wie log-commander**: Sidecar-Programm spricht MCP über stdio mit dem Assistenten und über eine
   lokale Brücke (nur `127.0.0.1`, Token) mit der laufenden App. Einstellung „KI-Steuerung“ mit Verbindungstest und
   Kopiervorlage für die Konfiguration des Assistenten.
2. **Werkzeuge (Tools)**, klein und klar: Verbindungen auflisten (ohne Geheimnisse), Schema lesen (Tabellen, Spalten,
   Schlüssel, DDL), Abfrage ausführen (lesend, mit Zeilen- und Zeitgrenze), Plan holen, Text in einen Tab schreiben,
   Abfrage **vorschlagen** (landet als Vorschlag beim Nutzer).
3. **Freigabemodell je Verbindung**: aus / nur Schema / lesende Abfragen / schreibende nur mit Bestätigung je
   Anweisung. Die Einstufung und Durchsetzung kommen aus Prompt 012 (Backend); geschützte Verbindungen sind für die
   KI standardmäßig gesperrt. Lesende Abfragen laufen in einer Nur-Lesen-Transaktion.
4. **Sichtbarkeit**: Anzeige, dass ein Assistent verbunden ist; Protokoll aller Aufrufe (Werkzeug, Anweisung, Zeilen)
   zum Nachlesen; „Trennen“ jederzeit; Vorschlagsdialog mit Anweisung und Verbindung.
5. **Datenabfluss begrenzen**: Zeilen-/Zeichenlimit je Antwort, Spalten ausschließen (Muster wie `password`,
   `token`, eigene Liste), Option „nur Struktur, nie Daten“. Klarer Hinweis, dass Ergebnisse an den Assistenten und
   damit an dessen Anbieter gehen.
6. **Daten sind keine Anweisungen**: Inhalte aus der Datenbank können Text enthalten, der den Assistenten lenken
   soll – die App selbst führt nie etwas aus, das in Daten steht; Schreibendes braucht immer die Bestätigung des
   Nutzers in der App.
7. Optional (eigener Abschnitt im Design, erst nach Freigabe): eingebaute Funktionen „Abfrage erklären“,
   „Text → SQL“ mit eigenem API-Schlüssel des Nutzers (im Schlüsselbund) – Anbieter, Kosten, Datenschutz darlegen.

## Akzeptanzkriterien

- Ohne eingeschaltete KI-Steuerung lauscht kein Port und läuft kein Sidecar.
- Ein Assistent kann das Schema lesen und ein `SELECT` ausführen; ein `UPDATE` erscheint als Vorschlag und läuft
  erst nach Klick; auf einer gesperrten Verbindung geht nichts.
- Das Limit greift (Test: Abfrage mit 1 Mio. Zeilen liefert die Grenze und einen Hinweis).

## Tests und Review

Rust: Brücke (Token, nur lokal), Werkzeuge mit Fake-Treiber, Grenzen. **Sicherheitsreview durch einen zweiten
Agenten**: Umgehen der Freigaben, Abfluss von Geheimnissen, Port/Token, Eingaben aus Daten.
