# Prompt 036: Suche auf dem Server

> **Slug:** `server-suche` · **Feature:** B4 · **Braucht:** 008, 011 (Job-Engine) · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: HeidiSQL („Text auf dem Server suchen“), DataGrip (Full-text
> Search), fnf Prompt 009 (Suche als Job mit Ergebnis-Tab).

## Ziel

„Wo steht `max.mustermann@example.com`?“ und „Welche Funktion benutzt `old_price`?“ – eine Suche über **Daten** aller
Tabellen und über **Quelltexte** von Views, Routinen und Triggern.

## Aufgaben

1. **Bereich wählen**: Verbindung/Datenbank/Schemata/Tabellen (Auswahl aus dem Baum), Spaltenarten (nur Text, auch
   Zahlen, alles als Text), Groß-/Kleinschreibung, exakt/enthält/Regex (wo die Datenbank es kann).
2. **Datensuche** als Job: je Tabelle eine Anweisung mit gebundenem Suchwert über die passenden Spalten
   (`LIKE`/`ILIKE`/`CAST … AS text`), Treffer begrenzt je Tabelle, Zeitlimit je Tabelle, Fortschritt (Tabelle x von
   y), Abbruch; große Tabellen zuerst nachfragen oder überspringen (Schätzung aus der Statistik).
3. **Quelltextsuche**: in Definitionen aus dem Katalog (Views, Funktionen, Prozeduren, Trigger, Check-Constraints,
   Defaults, Kommentare).
4. **Objektnamen** sind schon über „Springen zu allem“ (020) abgedeckt – hier nur als Option mitsuchen.
5. **Ergebnis-Tab**: Treffer gruppiert nach Tabelle/Objekt (GuiExpert-Baumtabelle), mit Spalte, Fundstelle und
   Vorschau; Aktionen: Zeile öffnen (gefilterte Tabellen-Ansicht, 027), Definition öffnen (019), Treffer exportieren.
6. **Rücksicht auf den Server**: nur lesend, eine Tabelle nach der anderen (oder kleine Parallelität als
   Einstellung), Hinweis auf geschützten Verbindungen (012).

## Akzeptanzkriterien

- Der Suchwert wird immer gebunden; `%` und `_` im Suchtext werden maskiert, wenn „exakt/enthält“ gewählt ist.
- Schema mit 2 000 Tabellen: Fortschritt sichtbar, Abbruch in unter einer Sekunde, bereits gefundene Treffer bleiben.
- Tabellen ohne Leserecht werden übersprungen und im Bericht genannt.

## Tests

Rust gegen Container: SQL-Erzeugung je Dialekt/Typ, Maskierung, Rechte, Abbruch. Frontend: Ergebnis-Tab mit Fake.
