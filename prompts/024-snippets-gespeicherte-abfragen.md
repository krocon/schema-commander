# Prompt 024: Gespeicherte Abfragen und Snippets

> **Slug:** `snippets-gespeicherte-abfragen` · **Feature:** C7 · **Braucht:** 004, E5 (editlicious: Snippets) ·
> **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`, `prompts/editlicious/E5-snippets.md`. Vorbild: TablePlus (Favoriten mit
> Kürzel), SSMS (Snippets), Beekeeper Studio (Saved Queries).

## Ziel

Abfragen, die man wieder braucht, haben einen Platz; kurze Bausteine fallen beim Tippen in den Text.

## Aufgaben

1. **Gespeicherte Abfragen**: Name, Ordner, Beschreibung, Text, optional gebunden an Verbindung/Treiber, Schlagworte.
   Abgelegt als **einzelne `.sql`-Dateien** in einem Ordner (mit Kopfkommentar für die Metadaten), damit man sie mit
   Git teilen und außerhalb bearbeiten kann; der Ordner ist einstellbar, Änderungen von außen werden erkannt.
2. **Seitenleisten-Ansicht**: Baum der Ordner, Suche über Name und Text, Vorschau; Aktionen: in neuem Tab öffnen,
   in den Editor einfügen, ausführen, umbenennen, verschieben, löschen (Papierkorb des Systems).
3. **Speichern**: aus Tab, Auswahl oder Verlauf (Prompt 010) „Als gespeicherte Abfrage ablegen“.
4. **Snippets**: Kürzel + Rumpf mit Platzhaltern (`sel` → `SELECT ${1:*} FROM ${2:table}$0`), Editor für eigene,
   ein mitgelieferter Satz je Dialekt; erscheinen in der Vervollständigung (E3/E5) und expandieren mit `Tab`.
   Variablen: aktuelle Tabelle/Schema aus dem Baum, Datum, Auswahl, Zwischenablage.
5. Erreichbar über „Springen zu allem“ (`q:`), Palette und ein eigenes Kürzel für die zuletzt benutzten.
6. Import: SQL-Dateien eines Ordners, Snippets aus VS Code (JSON) – optional.

## Entscheidungsfragen (Design)

- Format der Metadaten im Kopfkommentar (lesbar, robust gegen Handbearbeitung).
- Überschneidung mit Tabs, die als Datei gespeichert sind (Prompt 004): eine gemeinsame Mechanik?

## Akzeptanzkriterien

- Abfrage speichern, App neu starten, per Suche finden, ausführen.
- Datei im Ordner außerhalb ändern/hinzufügen/löschen: die Ansicht folgt.
- Snippet mit drei Platzhaltern nur mit `Tab` und Tippen ausfüllen.

## Tests

Rust: Dateiablage (Unicode-Namen, Konflikte, defekte Köpfe), Überwachung. Rein: Snippet-Variablen. Frontend: Ansicht
mit Fake.
