# Prompt 010: Abfrage-Verlauf

> **Slug:** `verlauf` · **Feature:** C6 · **Braucht:** 005 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DBeaver (Query Manager), Beekeeper Studio, DataGrip.

## Ziel

Jede ausgeführte Anweisung ist wiederzufinden: wann, auf welcher Verbindung, wie lange, wie viele Zeilen, mit welchem
Ausgang – durchsuchbar und mit einem Griff zurück im Editor.

## Aufgaben

1. **Speicher in Rust**: lokale SQLite-Datei im Datenordner der App (rusqlite ist da). Eintrag: Zeit, Verbindung
   (Id + Name zum Zeitpunkt), Datenbank/Schema, Text, Dauer, Zeilen, Ausgang, Fehlermeldung, Tab.
2. **Aufbewahrung**: Grenzen nach Alter und Anzahl (Einstellung), sehr lange Anweisungen gekürzt mit Hash,
   wiederholte gleiche Anweisungen zusammengefasst (Zähler).
3. **Datenschutz**: Verlauf je Verbindung abschaltbar; „Verlauf löschen“ (alles, eine Verbindung, ein Eintrag);
   keine Parameterwerte und keine Ergebnisse speichern; der Verlauf ist die **einzige** Stelle, an der
   Anweisungstexte dauerhaft liegen (Best Practices §6 entsprechend ergänzen).
4. **Ansicht**: Reiter/Seitenfeld mit GuiExpert Table (Zeit, Verbindung, Dauer, Zeilen, Anfang des Textes),
   Volltextsuche, Filter (Verbindung, nur Fehler, Zeitraum), Vorschau des ganzen Textes in einem Nur-Lesen-Editor.
5. **Aktionen**: in den aktuellen Tab einfügen, in neuem Tab öffnen, erneut ausführen, kopieren, als gespeicherte
   Abfrage ablegen (Prompt 024). Im Editor: vorige/nächste Anweisung aus dem Verlauf (`Mod+Alt+↑/↓` o. ä.).

## Entscheidungsfragen (Design)

- Volltextsuche mit SQLite FTS5 oder einfaches `LIKE`?
- Gilt der Verlauf auch für Anweisungen, die die App selbst erzeugt (Tabelle öffnen, Bearbeiten)? Empfehlung:
  ja, als eigene Art, ausblendbar.

## Akzeptanzkriterien

- Nach 100 000 Einträgen öffnet und durchsucht sich der Verlauf ohne spürbare Wartezeit.
- Eine fehlgeschlagene Anweisung steht mit ihrer Fehlermeldung im Verlauf.
- „Verlauf löschen“ entfernt die Daten wirklich aus der Datei (`VACUUM` bzw. `secure_delete`).

## Tests

Rust: Schreiben/Lesen, Aufbewahrung, Zusammenfassen, Löschen, defekte Datei (neu anlegen, alte beiseitelegen).
Frontend: Suche und Filter mit Fake.
