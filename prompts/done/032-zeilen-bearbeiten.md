# Prompt 032: Zeilen einfügen, duplizieren, löschen, Block einfügen

> **Slug:** `zeilen-bearbeiten` · **Feature:** E2 · **Braucht:** 031 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`, `llms.txt` der GuiExpert Table (`table-clipboard.css`,
> `table-fill-batch.css`, `table-sheet-editing.css`). Vorbild: TablePlus, Postico (Tabellenkalkulations-Gefühl).

## Ziel

Der Änderungspuffer aus Prompt 031 kann auch **ganze Zeilen**: einfügen, duplizieren, löschen – und einen
**Zellblock aus Excel** einfügen.

## Aufgaben

1. **Neue Zeile**: am Ende oder unter der aktuellen; Spalten mit Default/Identity/generiert bleiben leer und werden
   als „Default“ gezeigt; Pflichtspalten markiert. Nach dem Schreiben die vom Server vergebenen Werte anzeigen
   (`RETURNING`, `OUTPUT`, `LAST_INSERT_ID`/`last_insert_rowid`).
2. **Duplizieren** einer oder mehrerer Zeilen (ohne Schlüssel-/Identity-Spalten).
3. **Löschen**: Zeilen werden durchgestrichen vorgemerkt; `DELETE` über den Schlüssel mit „genau eine Zeile“-Prüfung;
   Fremdschlüssel-Fehler verständlich melden (welche Tabelle verweist).
4. **Einfügen aus der Zwischenablage**: TSV/CSV-Block ab der aktiven Zelle – überschreibt vorhandene Zeilen und legt
   bei Bedarf neue an; Typumwandlung mit Fehlermarken je Zelle; Vorschau bei großen Blöcken.
5. **Füllen**: Wert nach unten ziehen/`Mod+D`, gleichen Wert in alle markierten Zellen, markierte Zellen auf `NULL`.
6. **Reihenfolge beim Schreiben**: Löschen, Ändern, Einfügen so ordnen, dass eindeutige Schlüssel nicht kollidieren;
   alles in einer Transaktion; Vorschau zeigt `INSERT`/`UPDATE`/`DELETE` getrennt mit Anzahl.
7. Stapel: viele `INSERT`s gebündelt senden (mehrzeilig bzw. Batch je Treiber).

## Akzeptanzkriterien

- 5 000 Zeilen aus einer Tabellenkalkulation einfügen: Vorschau, Schreiben in wenigen Sekunden, bei einem Fehler in
  Zeile 3 000 bleibt die Datenbank unverändert und die Zelle ist markiert.
- Neue Zeile zeigt nach dem Schreiben ihre vergebene Id.
- Undo nimmt Einfügen, Duplizieren und Löschen im Puffer zurück.

## Tests und Review

Rein: Puffer mit Zeilenoperationen, Block-Parser, Reihenfolge. Rust gegen Container: Rückgabe vergebener Werte je
Treiber, Batch. Review: Datenverlust, Reihenfolge, Transaktion.
