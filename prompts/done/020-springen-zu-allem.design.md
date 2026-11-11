# Design 020: Springen zu allem

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/springen-zu-allem` · Auftrag: [020-springen-zu-allem.md](020-springen-zu-allem.md) · Feature B2

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Index über alle Datenbanken oder nur die des aktiven Tabs? | **Je Verbindung ein Index**, gesucht wird in dem der Verbindung des Tabs vorn. Verbindungen selbst und offene Tabs sind eigene Treffer (`@` nur Verbindungen) | Ein Treffer wird auf einer Verbindung geöffnet – Namen fremder Verbindungen wären Treffer, die erst verbinden müssten |
| E2 | Spalten im Index? | **Erst auf `c:`**: die erste Spaltensuche liest alle Spalten nach (eine Abfrage), danach liegen sie im Index bis zum nächsten Auffrischen | Spalten sind 10–50-mal so viele wie Objekte; die meisten Sprünge gelten Tabellen |
| E3 | Wann wird gelesen? | Objekte bei der ersten Suche auf einer Verbindung (`names_query` liest, wenn nichts da ist); neu nach DDL (`SchemaStore.ran` → `names_refresh`) und nach dem Trennen (Index wird verworfen) | kein Hintergrundlauf, der eine Verbindung belegt, die niemand durchsucht |
| E4 | Suche | in Rust (`db/names.rs`, rein): Rang **gleich > Anfang > Wortanfänge** (`ord_it`, `ordit`, `oi` → `order_items`/`OrderItems`; Wörter an `_ - . $`, Groß nach Klein, Ziffer nach Buchstabe) **> Teil > Tippfehler** (ein Fehler ab 4, zwei ab 8 Zeichen: falsch, fehlend, zu viel, vertauscht; gegen Namen, Anfang und Wörter) **> Buchstaben in Reihenfolge**. Bei Gleichstand: kurzer Name, aktuelles Schema (+30), zuletzt gewählt (bis +45), Tabellen vor Views vor Routinen, dann alphabetisch | Katalog als Test |
| E5 | Schnell genug? | Je Eintrag vorab: Name klein, Wortanfänge, Bitmaske der Zeichen. Fehlen der Anfrage Zeichen, die der Name nicht hat, bleibt nur der Tippfehler-Weg; der prüft nur Teile, die ähnlich anfangen. Höchstens 200 Treffer gehen ans Fenster, die Gesamtzahl wird genannt | gemessen: **200 000 Namen, 2–69 ms je Anfrage** im optimierten Build (Test im Debug-Build: bis 0,7 s) |
| E6 | Abfragesprache | `t:` Tabellen und Views, `v:` Views, `c:` Spalten, `f:` Routinen, `s:` Sequenzen, `@` Verbindungen, `>` Befehle; `schema.name` (bei Spalten `tabelle.spalte`) grenzt ein. `q:` (gespeicherte Abfragen) sagt, dass es sie noch nicht gibt | gespeicherte Abfragen sind ein späterer Prompt |
| E7 | Gemeinsame Komponente | `CommandPalette` hat zwei Arten: Befehle (`Mod+Shift+P`) und Springen (`Mod+P`). `>` am Anfang wechselt zu den Befehlen, Rücktaste im leeren Feld zurück | Auftrag |
| E8 | Reihenfolge der Quellen | offene Tabs und Verbindungen zuerst (je höchstens 5, solange es Namen gibt), dann die Namen in der Rangfolge des Backends | wenige, nahe Ziele; zwei Bewertungsskalen zu mischen wäre Willkür |
| E9 | Am Treffer | Enter: Daten öffnen (Tabelle/View), Details (Routine, Sequenz – dort steht die Definition), Name einfügen (Spalte), Tab bzw. Verbindung aktivieren. `Umschalt+Enter` Details, `Alt+Enter` Name einfügen, `Strg/⌘+Enter` `SELECT`-Vorlage einfügen, `Strg/⌘+Umschalt+Enter` im Baum zeigen (der Baum filtert auf den Namen) | Auftrag; die Zeile unter der Liste nennt die Tasten |
| E10 | Vorschau | Unter der Liste stehen die Spalten der Tabelle unter dem Cursor (nach 180 ms, höchstens 12) | zweite Zeile statt Seitenbereich: die Liste bleibt breit |
| E11 | Liste | nicht virtuell: höchstens 200 Treffer plus ein paar lokale. „4 von 1240 Treffern – mehr tippen grenzt ein“ | 200 Zeilen kosten nichts; wer mehr braucht, tippt |
| E12 | Überholte Antworten | Jede Anfrage trägt eine Nummer; nur die Antwort auf die letzte wird gezeigt (Test mit verzögerter Antwort) | Akzeptanzkriterium |

## Geprüft

- Rust: Abfragesprache, **Rangfolge-Katalog** (13 Anfragen mit erwarteter Reihenfolge), markierte Zeichen (auch
  Umlaute), aktuelles Schema und zuletzt Gewähltes, Arten und Eingrenzung, begrenzte Liste, 200 000 Namen, Lesen
  aus SQLite.
- Gegen echte Server (`names_of_every_server`): PostgreSQL, MySQL, MariaDB, SQL Server – Objekte lesen, Tabelle,
  View und Routine finden, Systemobjekte fehlen, Spalten erst nach `c:`.
- Frontend: `goto-logic.spec.ts`, `command-palette.spec.ts` (beide Arten, Tastatur, `>`, Spalten, überholte
  Antwort, Enter und Umschalt+Enter).
- Im Browser mit nachgestelltem Backend: Treffer mit Hervorhebung, Art und Schema, Vorschau der Spalten, Zahl
  der Treffer.

## Nicht umgesetzt, nicht geprüft

- **Gespeicherte Abfragen** (`q:`) – es gibt sie noch nicht.
- **„Im Baum zeigen“** setzt den Filter des Baums auf den Namen, statt den Knoten aufzuklappen und anzuspringen.
- Der Index wird nicht im Hintergrund vorab gelesen: die erste Suche auf einer Verbindung wartet auf den Katalog
  (bei 200 000 Objekten eine spürbare Abfrage – nicht gemessen).
- Die 200 000 Namen des Tests sind erzeugt; eine echte Datenbank dieser Größe stand nicht zur Verfügung.
- Tippfehler werden nicht hervorgehoben (es gibt keine Zeichen, die „passen“).
- Ein Index bleibt im Speicher, bis die Verbindung getrennt wird; bei 1 Mio. Einträgen ist Schluss (`cut`).
- Lokale Treffer (Tabs, Verbindungen) nutzen die einfachere Suche der Befehlspalette, ohne Tippfehlertoleranz.
- Das native Fenster wurde nicht bedient.
