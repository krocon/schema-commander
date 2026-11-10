# Prompt 033: Import aus CSV und JSON

> **Slug:** `import` · **Feature:** F2 · **Braucht:** 008, 011 · **Umfang:** M–L
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DataGrip (Import mit Zuordnung), Navicat (Assistent),
> DBeaver.

## Ziel

Eine Datei in eine Tabelle laden: Vorschau, Spalten zuordnen, Typen erkennen, Zieltabelle bei Bedarf anlegen,
Fehlerzeilen protokollieren – als Job mit Fortschritt (Engine aus Prompt 011).

## Aufgaben

1. **Lesen in Rust** als Strom: CSV/TSV (Trenner, Anführungszeichen, Kodierung, BOM, Kopfzeile, Zeilenende
   automatisch erkennen und einstellbar; Zeilenumbrüche in Feldern), JSON (Array von Objekten), NDJSON, optional
   `.xlsx` (erstes Blatt) und gzip. Große Dateien (GB) ohne sie ganz zu laden.
2. **Vorschau** der ersten Zeilen im Gitter, live bei geänderten Optionen.
3. **Ziel**: vorhandene Tabelle oder **neue Tabelle** mit erkannten Typen (Stichprobe: Ganzzahl, Dezimal, Bool,
   Datum/Zeit, Text mit Länge; `NULL`-Zeichenfolgen einstellbar) – das `CREATE TABLE` wird angezeigt und ist
   änderbar.
4. **Zuordnung**: Quellspalte → Zielspalte (automatisch nach Namen, von Hand änderbar), Spalte überspringen, fester
   Wert/Ausdruck, Umwandlung (Datumsformat, Dezimaltrenner, Leerraum entfernen).
5. **Modus**: anhängen, vorher leeren (Schutzregeln aus Prompt 012), Upsert über Schlüssel (je Dialekt).
6. **Schreiben**: schnellster Weg je Treiber (PostgreSQL `COPY`, sonst Stapel-`INSERT`s gebunden), in einer
   Transaktion oder in Blöcken (Einstellung); Abbruch räumt auf.
7. **Fehler**: bei Fehler abbrechen oder Zeile überspringen und in eine Fehlerdatei schreiben (Zeilennummer, Grund,
   Originalzeile); Abschlussbericht mit Zahlen.

## Entscheidungsfragen (Design)

- `COPY`/`LOAD DATA` gegenüber `INSERT`-Stapeln: Tempo, Fehlermeldung je Zeile, Rechte, Sicherheit (`LOCAL INFILE`
  bleibt aus).
- Typ-Erkennung: Stichprobengröße, Verhalten bei späterem Widerspruch.

## Akzeptanzkriterien

- CSV mit 5 Mio. Zeilen: konstanter Speicher, Fortschritt, Abbruch; Ergebnis stimmt mit der Datei überein
  (Rundreise mit Prompt 011).
- Datei mit kaputten Zeilen: der Bericht nennt sie, die übrigen sind importiert (im Modus „überspringen“).
- Spaltennamen und Werte aus der Datei können kein SQL einschleusen (Katalog).

## Tests und Review

Rust: Leser-Katalog (Kodierungen, Sonderfälle), Typ-Erkennung, Schreiben gegen Container. Review: Datei ist
feindlich; Bezeichner gequotet, Werte gebunden.
