# Prompt 020: Springen zu allem

> **Slug:** `springen-zu-allem` · **Feature:** B2 · **Braucht:** 002, 008 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DataGrip (Navigate → Table/Routine), TablePlus (`Cmd+P`),
> fnf Prompt 043 (universelle Palette mit Namensindex in Rust, `palette_query`).

## Ziel

Ein Feld (`Mod+P`), ein paar Buchstaben, Enter: Tabelle, View, Routine, Spalte, gespeicherte Abfrage, offener Tab
oder Verbindung – gefunden über alle Schemata, unscharf und sofort.

## Aufgaben

1. **Namensindex in Rust** je Verbindung (aus den Metadaten von Prompt 008, im Hintergrund vervollständigt und nach
   DDL aufgefrischt): Art, Schema, Name, Elternobjekt. Suche in Rust (Teilwort, Anfangsbuchstaben `ord_it` →
   `order_items`, CamelCase), Rangfolge (Treffergüte, zuletzt benutzt, aktuelles Schema zuerst).
2. **Abfragesprache** klein halten: Präfixe für die Art (`t:` Tabelle, `c:` Spalte, `f:` Funktion, `q:` Abfrage,
   `@` Verbindung), `schema.name`.
3. **Liste**: Icon, Name mit hervorgehobenen Treffern, Schema/Verbindung, Art; virtuell; Vorschau (Spalten) rechts
   oder als zweite Zeile.
4. **Aktionen am Treffer**: Enter = Daten öffnen (Tabelle) bzw. Definition (Routine) bzw. Tab aktivieren;
   Varianten mit Modifier: im Baum zeigen, Details öffnen (019), Name in den Editor einfügen, `SELECT`-Vorlage.
5. Zusammenspiel mit der Befehlspalette (`Mod+Shift+P`, Prompt 002): gemeinsame Komponente, `>` wechselt zu Befehlen.

## Entscheidungsfragen (Design)

- Index über alle verbundenen Datenbanken oder nur die des aktiven Tabs?
- Spalten in den Index aufnehmen (groß) oder erst auf `c:` nachladen?

## Akzeptanzkriterien

- 200 000 Objekte: Ergebnis nach jedem Tastendruck ohne spürbare Verzögerung; überholte Antworten erscheinen nicht.
- Tippfehlertoleranz und Anfangsbuchstaben finden die erwarteten Objekte (Rangfolge-Katalog als Test).
- Vollständig per Tastatur; Screenreader bekommt Anzahl und aktiven Treffer angesagt.

## Tests

Rust: Such- und Rangfolge-Katalog, Auffrischen. Komponente: Tastatur, überholte Antworten.
