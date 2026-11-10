# Prompt 011: Export

> **Slug:** `export` · **Feature:** F1 · **Braucht:** 005, 009 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DataGrip, DBeaver. Job mit Fortschritt:
> `log-commander/src-tauri/src/export.rs`, `files-and-folders-tauri/src-tauri/src/jobs/`.

## Ziel

Ein Ergebnis, eine Abfrage oder eine ganze Tabelle in eine Datei schreiben – als Job mit Fortschritt und Abbruch,
**direkt vom Server bzw. aus dem Ergebnisspeicher in die Datei**, nie über das Gitter.

## Aufgaben

1. **Quellen**: aktuelles Ergebnis (aus dem Speicher von Prompt 006), Anweisung neu ausführen (alle Zeilen, ohne
   Anzeige), Tabelle(n) aus dem Baum.
2. **Formate** (Extraktoren aus Prompt 009, hier als Strom in Rust): CSV/TSV (Trenner, Anführungszeichen, Kodierung
   UTF-8 mit/ohne BOM, Zeilenende), JSON, NDJSON, `INSERT`-Skript (Stapelgröße, optional `CREATE TABLE`), Markdown,
   Excel `.xlsx` (Typen erhalten, Zeilengrenze von Excel beachten und melden), optional gzip.
3. **Job-Engine**: allgemeine kleine Engine für lange Arbeiten (Fortschritt über `Channel`, Abbruch-Token, Liste
   laufender Jobs mit Anzeige in der Statuszeile) – Import, Suche und Kopieren (009) hängen sich später hier ein.
4. **Dialog**: Format, Optionen, Spaltenauswahl, Ziel (nativer Speichern-Dialog; `tauri-plugin-dialog` begründet
   aufnehmen), Vorschau der ersten Zeilen; letzte Einstellungen je Format merken.
5. **Schreiben**: in eine temporäre Datei daneben, am Ende atomar umbenennen; bei Abbruch/Fehler aufräumen; nie die
   Zieldatei halb überschrieben zurücklassen. Am Ende: „Im Dateimanager zeigen“.

## Entscheidungsfragen (Design)

- `.xlsx` schreiben: welche crate (reines Rust, Strom-fähig, Lizenz)? Begründung in `docs/architecture.md`.
- Mehrere Tabellen: eine Datei je Tabelle in einen Ordner oder ein Archiv?

## Akzeptanzkriterien

- 10 Mio. Zeilen als CSV: konstanter Speicherbedarf, Fortschritt sichtbar, Abbruch räumt auf.
- Rundreise: Export als CSV/`INSERT` → Import (Prompt 033 bzw. `psql`/`mysql`) ergibt dieselben Daten, inklusive
  `NULL`, Unicode, Zeilenumbrüchen, Binärdaten.
- Schreibgeschütztes Ziel und volle Platte ergeben eine klare Meldung.

## Tests und Review

Rust: Strom je Format mit `tempfile`, Abbruch, Fehler beim Schreiben. Review: Pfad kommt nur aus dem nativen Dialog,
keine Datei wird ohne Bestätigung überschrieben.
