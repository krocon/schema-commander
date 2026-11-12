# Prompt 045: Daten zwischen Datenbanken kopieren

> **Slug:** `daten-kopieren` · **Feature:** F4 · **Braucht:** 011, 033, 043 · **Umfang:** L
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DBeaver (Data Transfer), Navicat (Data Transfer/Sync).

## Ziel

Eine oder mehrere Tabellen von einer Verbindung in eine andere übertragen – auch **über Datenbanktypen hinweg**
(PostgreSQL → SQLite, MySQL → PostgreSQL), als Strom ohne Zwischendatei.

## Aufgaben

1. **Assistent**: Quelle (Tabellen aus dem Baum oder eine Abfrage) → Ziel (Verbindung, Schema) → Zuordnung →
   Optionen → Vorschau → Lauf.
2. **Zieltabelle**: vorhandene (Spalten zuordnen wie beim Import, Prompt 033) oder neu anlegen. **Typabbildung
   zwischen Dialekten** als Tabelle in Rust (z. B. `jsonb` → `TEXT`/`JSON`, `uuid` → `CHAR(36)`,
   `timestamptz` → `DATETIME`, `bytea` → `BLOB`, `numeric(p,s)`); Verluste werden vor dem Lauf genannt.
3. **Übertragen als Job**: lesen als Strom (Prompt 006), schreiben mit dem schnellsten Weg des Ziels (Prompt 033),
   Gegendruck, damit der Speicher konstant bleibt; Blöcke mit Commit oder alles in einer Transaktion.
4. **Reihenfolge und Schlüssel**: mehrere Tabellen in Abhängigkeitsreihenfolge; Fremdschlüssel/Trigger im Ziel
   optional für den Lauf aussetzen (wo möglich, mit Hinweis); Identity-Werte übernehmen und Sequenzen danach
   nachziehen.
5. **Modus**: anhängen, vorher leeren, Upsert, nur fehlende Zeilen (über Schlüssel). Schutzregeln des Ziels
   (Prompt 012).
6. **Bericht**: Zeilen je Tabelle, Dauer, übersprungene Zeilen mit Grund (Fehlerdatei); Wiederaufsetzen einer
   abgebrochenen Tabelle im Design bewerten.
7. Indizes/Constraints der Quelle im Ziel anlegen (Option, nach den Daten).

## Akzeptanzkriterien

- 10 Mio. Zeilen PostgreSQL → MySQL: konstanter Speicher, Fortschritt, Abbruch lässt das Ziel in definiertem Zustand
  (je nach Transaktionsmodus).
- Rundreise A → B → A für die Testtabelle „alle Typen“: Werte gleich, wo die Typabbildung verlustfrei ist;
  Verluste stehen vorab in der Vorschau.
- Unicode, `NULL`, leere Strings, Binärdaten und Zeitzonen kommen richtig an.

## Tests und Review

Rust: Typabbildungs-Katalog je Dialektpaar, Übertragung zwischen Containern, Abbruch. Review: Zustand des Ziels nach
Fehlern, Reihenfolge, ausgesetzte Constraints werden wieder eingeschaltet.
