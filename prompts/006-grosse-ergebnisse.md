# Prompt 006: Große Ergebnisse

> **Slug:** `grosse-ergebnisse` · **Feature:** D1 · **Braucht:** 005 · **Umfang:** L
> Lies zuerst `prompts/000-arbeitsweise.md`, `../video/2026/guiexpert-table/mono/llms.txt` (eigenes `AreaModel`,
> Zeilenhöhen) und `log-commander/src/app/features/log-table/log-area-model.ts` (Fenster von Zeilen aus Rust),
> `log-commander/src-tauri/src/spool.rs`. Kein Vorbild unter den SQL-Tools: **das ist unser Vorteil**.

## Ziel

Ein `SELECT` über zehn Millionen Zeilen friert nichts ein: Rust liest vom Server in einen Zwischenspeicher, das
Gitter zeigt sofort die ersten Zeilen und holt beim Scrollen nur den sichtbaren Ausschnitt.

## Aufgaben

1. **Ergebnisspeicher in Rust**: Zeilen werden beim Lesen kompakt abgelegt (Speicher bis zu einer Grenze, darüber
   Datei im Cache-Ordner der App), mit Index für wahlfreien Zugriff auf Zeile *n*. Aufräumen beim Schließen des
   Ergebnisses/Tabs und beim Start (Reste eines Absturzes).
2. **Lesestrategie**: sofort die ersten *N* Zeilen, dann je nach Einstellung weiterlesen bis zum Ende oder erst bei
   Bedarf (Scrollen ans Ende, „alle laden“). Zeilenzahl in der Statuszeile: „10 000+“ solange offen.
3. **Commands**: `result_window(resultId, from, count)` liefert Zeilen-Arrays; Ereignisse über den Kanal des Jobs
   (Zeilenzahl gewachsen, fertig, Fehler). Veraltete Antworten verwerfen.
4. **Gitter**: eigenes `AreaModel` mit Seiten-Cache; während eine Seite fehlt, Platzhalter statt Sprüngen; Scrollbalken
   stimmt mit der bekannten Zeilenzahl.
5. **Grenzen**: Einstellung für Speicher und Plattenplatz je Ergebnis; sehr breite Zellen (Text/BLOB von MBs) werden
   im Fenster gekürzt übertragen, der volle Wert kommt auf Anfrage (Prompt 026).
6. **Sortieren** eines noch nicht vollständig geladenen Ergebnisses: im Design entscheiden (erst zu Ende laden, oder
   an den Server geben, s. Prompt 027).

## Entscheidungsfragen (Design)

- Format des Speichers (eigene Zeilenkodierung + Offsets, SQLite-Datei, Arrow)? Messen: Schreibrate, wahlfreier
  Zugriff, Platzbedarf.
- Hält das offene Ergebnis die Verbindung besetzt (Server-Cursor) oder wird immer zu Ende gelesen?
- Was zeigt der Tab, während die nächste Anweisung auf derselben Sitzung warten muss?

## Akzeptanzkriterien

- 10 Mio. Zeilen × 20 Spalten: erste Zeilen in unter 1 s nach der Antwort des Servers; Scrollen bleibt flüssig;
  der Speicher der WebView wächst nicht mit der Zeilenzahl; Abbruch jederzeit.
- Sprung ans Ende und zurück zeigt die richtigen Zeilen (Stichprobe gegen `ORDER BY`).
- Nach dem Schließen des Tabs ist der Plattenplatz wieder frei.

## Tests und Review

Rust: Speicher mit Unicode, NULL, riesigen Zellen, Abbruch beim Schreiben, volle Platte (bedingt). Frontend:
Seiten-Cache und überholte Antworten mit Fake. Messwerte ins Design-Dokument. Review: Aufräumen, Grenzen, keine
Blockade des Async-Runtime-Threads.
