# Prompt 025: Parameter in Abfragen

> **Slug:** `parameter` · **Feature:** C8 · **Braucht:** 005 · **Umfang:** S–M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DbVisualizer, DataGrip, DBeaver.

## Ziel

`SELECT * FROM orders WHERE customer_id = :kunde AND ordered_at >= :ab` – beim Ausführen fragt die App die Werte ab,
merkt sie sich und sendet sie **gebunden**, nicht in den Text eingesetzt.

## Aufgaben

1. **Erkennen** (reine Funktion, je Dialekt, außerhalb von Strings/Kommentaren): benannte (`:name`, `@name`,
   `$name`, `${name}`), nummerierte (`$1`), anonyme (`?`). Abgrenzung zu `::typ` (PostgreSQL-Cast), `@variable`
   (MySQL/SQL Server-Variablen), `:=`, JSON-Operatoren (`?`, `?|`) – Katalog; welche Formen aktiv sind, ist
   einstellbar je Profil.
2. **Eingabe**: Feld je Parameter (Leiste über dem Ergebnis oder Dialog), Typ wählbar (Text, Zahl, Datum, Bool,
   `NULL`, Liste für `IN`), letzter Wert vorbelegt; `Enter` führt aus. Werte je Tab und Parametername gemerkt.
3. **Binden**: über die Parameter-Schnittstelle des Treibers; Umschreiben auf dessen Platzhalterform; Listen für
   `IN (:ids)` sauber expandieren (als einzelne gebundene Werte).
4. **Erneut ausführen** mit denselben Werten ohne Rückfrage (eigene Aktion); Werte im Meldungsbereich anzeigen.
5. Datenschutz: Parameterwerte kommen nicht in den Verlauf (Prompt 010) – oder nur auf ausdrückliche Einstellung.

## Entscheidungsfragen (Design)

- Typ raten (aus Eingabe, aus Katalog über `PREPARE`/Describe) oder immer wählen lassen?
- „Nur ersetzen“-Modus für Stellen, an denen nicht gebunden werden kann (Tabellennamen)? Wenn ja: klar getrennt,
  mit Quoting-Funktion, nie stillschweigend.

## Akzeptanzkriterien

- Ein Wert `'; DROP TABLE x; --` als Parameter richtet nichts an und wird als Text gefunden/gespeichert.
- `::date`, `@@version`, `jsonb ? 'key'` und `:name` in einem String lösen keine Abfrage aus.
- Parameter-Leiste vollständig per Tastatur.

## Tests

Rein: Erkennungs-Katalog je Dialekt, Umschreiben. Rust gegen Container: Binden aller Typen, `IN`-Listen, `NULL`.
