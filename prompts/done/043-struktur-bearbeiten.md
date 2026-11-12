# Prompt 043: Struktur bearbeiten

> **Slug:** `struktur-bearbeiten` · **Feature:** E3 · **Braucht:** 012, 019 · **Umfang:** L
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: HeidiSQL (Tabelleneditor), TablePlus (Struktur-Reiter mit
> gesammelten Änderungen), Navicat.

## Ziel

Tabellen anlegen und ändern, ohne DDL auswendig zu kennen: Spalten, Indizes und Schlüssel in Tabellenform bearbeiten –
mit **DDL-Vorschau** und dem gleichen „sammeln, ansehen, schreiben“ wie bei den Daten (Prompt 031).

## Aufgaben

1. **Struktur-Ansicht bearbeitbar** (baut auf Prompt 019 auf): Spalten (Name, Typ mit Vorschlägen des Dialekts,
   Länge/Genauigkeit, NULL, Default, Identity/Auto-Increment, generiert, Kommentar, Reihenfolge wo möglich), Indizes
   (Spalten mit Richtung, eindeutig, Art, Bedingung), Primärschlüssel, Fremdschlüssel (Zieltabelle/-spalten mit
   Auswahl, `ON DELETE/UPDATE`), Unique, Check, Tabellenkommentar.
2. **Änderungsmodell** (reine Logik): Unterschied zwischen geladener und bearbeiteter Struktur → Liste von
   Operationen.
3. **DDL-Erzeugung je Dialekt** in Rust: `ALTER TABLE …` in tragfähiger Reihenfolge; Besonderheiten festhalten
   (SQLite: viele Änderungen nur über „neue Tabelle, kopieren, umbenennen“; MySQL: `CHANGE`/`MODIFY`; PostgreSQL:
   `USING` bei Typwechsel; SQL Server: Default-Constraints mit Namen).
4. **Vorschau und Ausführen**: DDL im Editor (bearbeitbar), **gefährliche Schritte markiert** (Spalte löschen, Typ
   verengen, NOT NULL auf Bestandsdaten, Neuaufbau der Tabelle, lange Sperre); Ausführen nach den Regeln aus
   Prompt 012, in einer Transaktion, wo die Datenbank transaktionales DDL kann – sonst ausdrücklicher Hinweis.
5. **Neue Tabelle**, Tabelle duplizieren (Struktur, optional Daten), umbenennen, leeren, löschen – jeweils mit
   Vorschau und Bestätigung.
6. Danach Metadaten-Zwischenspeicher, Baum und offene Ansichten der Tabelle auffrischen.
7. Views und Routinen: Bearbeiten ihres Quelltextes im Editor mit „Speichern = `CREATE OR REPLACE`“ (Entsprechung je
   Dialekt).

## Entscheidungsfragen (Design)

- Umfang der ersten Fassung je Datenbank; was bewusst nur über handgeschriebenes DDL geht.
- SQLite-Tabellenneuaufbau automatisch anbieten (Datenkopie, Indizes, Trigger, Fremdschlüssel) oder nur anzeigen?

## Akzeptanzkriterien

- Rundreise je Dialekt: Struktur ändern → DDL ausführen → neu laden ergibt genau die bearbeitete Struktur.
- Kein zerstörender Schritt ohne Markierung und Bestätigung; auf „nur lesen“-Verbindungen ist Bearbeiten aus.
- Bezeichner mit Sonderzeichen werden richtig gequotet; Defaults und Kommentare mit `'` kommen richtig an.

## Tests und Review

Rein: Änderungsmodell. Rust gegen Container: DDL-Katalog und Rundreise. **Review durch einen zweiten Agenten**:
Datenverlust, Reihenfolge, Transaktionen.
