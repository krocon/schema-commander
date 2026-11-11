# Prompt 023: SQL formatieren

> **Slug:** `sql-formatieren` · **Feature:** C5 · **Braucht:** 002, E2 (editlicious: Bereich ersetzen) ·
> **Umfang:** S–M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DataGrip (Code Style), Beekeeper Studio.

## Ziel

Eine Taste macht aus einer Zeile Bandwurm-SQL eine lesbare Anweisung – für die Auswahl, die aktuelle Anweisung oder
das ganze Skript, als **ein** Undo-Schritt.

## Aufgaben

1. **Formatierer** auswählen und einbinden: Kandidaten (crate `sqlformat`, npm `sql-formatter`, eigener auf Basis
   des Tokenizers aus Prompt 005/021) nach Dialektabdeckung, Fehlertoleranz, Größe, Lizenz bewerten.
2. **Stil-Einstellungen**: Schlüsselwörter groß/klein/unverändert, Einrückung, Komma vorn/hinten, Zeilenbreite,
   `AND`/`OR` am Zeilenanfang, Leerzeilen zwischen Anweisungen; Vorschau im Einstellungsdialog.
3. **Sicherheit des Textes**: Kommentare, Strings, Dollar-Quoting, Hinweise (`/*+ … */`) bleiben unverändert;
   Formatieren ändert nie die Bedeutung – Test: Token-Folge ohne Leerraum vorher = nachher.
4. **Aktionen**: Formatieren (Auswahl, sonst Anweisung unter dem Cursor), ganzes Skript formatieren, Schlüsselwörter
   groß/klein, in eine Zeile zusammenziehen, Kommentar umschalten. Cursor bleibt sinnvoll stehen.
5. Text holen und ersetzen über die Methoden aus E2 (`getRange`/`replaceRange`), nicht über `getValue()` des ganzen
   Dokuments, wenn nur eine Anweisung betroffen ist.

## Akzeptanzkriterien

- Katalog je Dialekt (CTEs, Fensterfunktionen, `CASE`, Unterabfragen, `MERGE`, Prozedurrümpfe): Ergebnis stabil
  (zweimal formatieren = einmal formatieren) und bedeutungsgleich.
- Unvollständiges oder fehlerhaftes SQL wird nicht zerstört (im Zweifel unverändert lassen und melden).
- Ein 20-MB-Skript blockiert das Fenster nicht (im Hintergrund, abbrechbar).

## Tests

Rein: Katalog mit Vorher/Nachher, Idempotenz, Token-Gleichheit. Ende-zu-Ende: Undo stellt exakt den alten Text her.
