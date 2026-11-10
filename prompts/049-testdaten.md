# Prompt 049: Testdaten erzeugen

> **Slug:** `testdaten` · **Feature:** H4 · **Braucht:** 008, 012, 033 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DBeaver (Mock Data), DataGrip (Data Generator).

## Ziel

Eine leere Tabelle – oder ein ganzes Schema – mit **plausiblen, wiederholbaren** Testdaten füllen.

## Aufgaben

1. **Generatoren je Spalte** (reine Logik in Rust, mit Startwert reproduzierbar): Ganzzahl/Dezimal (Bereich,
   Verteilung), Folge, Bool, Datum/Zeit (Bereich), UUID, Text (Länge, Muster/Regex), Auswahl aus Liste (gewichtet),
   Namen, E-Mail, Telefon, Adresse, Firma, Lorem, JSON nach Vorlage, `NULL`-Anteil; eindeutig, wo ein
   Unique-/Primärschlüssel es verlangt.
2. **Vorschlag aus dem Schema**: Typ, Länge, NOT NULL, Check/Enum, Spaltenname (`email`, `first_name`, `created_at`,
   `price` …) → passender Generator; alles änderbar.
3. **Fremdschlüssel**: Werte aus vorhandenen bzw. gerade erzeugten Zeilen der Zieltabelle; mehrere Tabellen in
   Abhängigkeitsreihenfolge mit Mengenverhältnis („je Kunde 0–20 Bestellungen“).
4. **Dialog**: Tabelle(n), Zeilenzahl, Generator je Spalte, **Vorschau** der ersten Zeilen im Gitter, Startwert.
5. **Schreiben** als Job über den Stapelweg aus Prompt 033 (schnell, abbrechbar, Transaktion/Blöcke).
   Schutzregeln aus Prompt 012: auf geschützten Verbindungen gesperrt.
6. **Vorlage speichern** je Tabelle; Export statt Schreiben: dieselben Daten als CSV/`INSERT`-Skript (Prompt 011).
7. Eingebaute Wortlisten klein und frei lizenziert (Herkunft in `docs/architecture.md`); Sprache/Region wählbar
   (mindestens de, en).

## Akzeptanzkriterien

- 1 Mio. Zeilen in eine Tabelle mit Unique-Spalte und Fremdschlüssel: keine Constraint-Verletzung, konstanter
  Speicher, Abbruch möglich.
- Gleicher Startwert → gleiche Daten.
- Die erzeugten Daten sehen in der Vorschau plausibel aus (Namen passen zu E-Mails, Datumsfolgen stimmen:
  `created_at ≤ updated_at`, wenn so eingestellt).

## Tests

Rein: Generator-Katalog (Eindeutigkeit, Bereiche, Reproduzierbarkeit, Regex-Muster), Vorschlag aus Spaltennamen.
Rust gegen Container: Schreiben mit Constraints.
