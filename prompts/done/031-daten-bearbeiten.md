# Prompt 031: Daten bearbeiten mit Änderungsvorschau

> **Slug:** `daten-bearbeiten` · **Feature:** E1 · **Braucht:** 007, 012, 013, 027 · **Umfang:** L
> Lies zuerst `prompts/000-arbeitsweise.md`, `llms.txt` der GuiExpert Table (Zell-Editoren, `editable`, Validierung).
> Vorbild: **TablePlus** (Änderungen sammeln, `Cmd+S` schreibt), DataGrip (Submit, DML-Vorschau).

## Ziel

Zellen direkt im Gitter ändern – aber nichts geht sofort an die Datenbank: Änderungen werden **gesammelt**, sind
farbig sichtbar, lassen sich als SQL ansehen und werden gemeinsam in einer Transaktion geschrieben oder verworfen.

## Aufgaben

1. **Wann bearbeitbar**: Tabellen-Ansicht oder Abfrage-Ergebnis, dessen Spalten eindeutig aus **einer** Tabelle
   stammen und deren Primärschlüssel (oder ein eindeutiger Nicht-NULL-Schlüssel) im Ergebnis ist. Sonst nur lesen,
   mit einem Satz, warum.
2. **Zell-Editoren je Typ**: Text (mehrzeilig über die Wert-Ansicht, Prompt 026), Zahl, Bool, Datum/Zeit, Aufzählung
   (`ENUM`, kleine Fremdschlüssel-Tabellen als Auswahl), JSON (mit Prüfung), „auf `NULL` setzen“, „auf Default
   setzen“. Prüfung vor dem Schreiben (Typ, Länge, NOT NULL).
3. **Änderungspuffer** je Tab (reine Logik): geänderte Zellen mit altem und neuem Wert; Undo/Redo; Zelle/Zeile/alles
   zurücksetzen; geänderte Zellen farbig (neue Tokens für geändert/neu/gelöscht, mit Kontrastpaaren).
4. **Vorschau**: Dialog/Reiter mit den erzeugten `UPDATE`-Anweisungen (lesbar mit eingesetzten Werten; gesendet wird
   gebunden).
5. **Schreiben** (`Mod+S`): in einer Transaktion; `WHERE` über den Schlüssel **plus** Prüfung, dass genau eine Zeile
   betroffen ist; optional optimistische Sperre (alte Werte im `WHERE`) – erkennt Änderungen durch andere.
   Bei Fehler: Rollback, fehlerhafte Zelle markiert, Puffer bleibt erhalten. Danach geänderte Zeilen neu lesen
   (Trigger, Defaults).
6. **Schutz**: Regeln aus Prompt 012 gelten (nur lesen → kein Bearbeiten; nachfragen → Bestätigung mit Vorschau).
   Tab/Fenster mit offenen Änderungen fragt beim Schließen. Neu laden/Filtern/Sortieren mit offenen Änderungen:
   Verhalten festlegen.

## Entscheidungsfragen (Design)

- Abfrage-Ergebnisse bearbeitbar machen (Herkunft der Spalten je Treiber verlässlich?) oder zunächst nur
  Tabellen-Ansichten?
- Optimistische Sperre als Vorgabe? Umgang mit Gleitkomma- und Zeitstempel-Vergleich im `WHERE`.
- Tabellen ohne Schlüssel: gar nicht, oder mit allen Spalten im `WHERE` und „genau eine Zeile“-Prüfung?

## Akzeptanzkriterien

- Zwanzig Zellen in fünf Zeilen ändern, Vorschau ansehen, schreiben: genau fünf `UPDATE`, alles oder nichts.
- Hat ein anderer die Zeile inzwischen geändert, wird das erkannt und gemeldet, nichts wird überschrieben.
- Kein Wert gelangt als Text in eine gesendete Anweisung (Test mit `'`-, `\`- und Unicode-Werten).
- Verwerfen stellt den Ausgangszustand exakt wieder her.

## Tests und Review

Rein: Änderungspuffer, SQL-Erzeugung je Dialekt. Rust gegen Container: Schreiben, Konflikt, Rollback, Trigger.
**Review durch einen zweiten Agenten**: Datenverlust-Szenarien, falsches `WHERE`, Transaktionsgrenzen.
