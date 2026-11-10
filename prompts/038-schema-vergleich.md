# Prompt 038: Schema-Vergleich

> **Slug:** `schema-vergleich` · **Feature:** B6 · **Braucht:** 019 · **Umfang:** L
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DbVisualizer, Navicat (Structure Synchronization), DataGrip
> (Compare Structure). Diff-Ansicht: fnf Prompt 037 (`diff_files`), Ordnervergleich fnf Prompt 036.

## Ziel

Zwei Schemata vergleichen (Entwicklung gegen Produktion, vorher gegen nachher) und ein **Migrationsskript**
vorschlagen – zum Lesen und Bearbeiten, nie zum blinden Ausführen.

## Aufgaben

1. **Quellen**: zwei Verbindungen/Schemata des gleichen Datenbanktyps; zusätzlich ein gespeicherter Schnappschuss
   (Datei) als eine Seite.
2. **Modell und Diff** (reine Logik in Rust): Tabellen, Spalten (Typ, NULL, Default, Reihenfolge optional), Indizes,
   Constraints, Views, Routinen, Trigger, Sequenzen, Kommentare. Unterschiede: nur links, nur rechts, verschieden –
   mit normalisiertem Vergleich (Leerraum, Typ-Synonyme wie `int4`/`integer`, Namensvergabe automatischer
   Constraints).
3. **Ansicht**: Baumtabelle der Objekte mit Zustand, Filter (nur Unterschiede, Objektart), darunter Text-Diff der
   beiden Definitionen nebeneinander.
4. **Migrationsskript** für eine Richtung aus ausgewählten Unterschieden: `CREATE`/`ALTER`/`DROP` in tragfähiger
   Reihenfolge (Abhängigkeiten); **gefährliche Schritte** (Spalte/Tabelle löschen, Typ verengen, NOT NULL auf
   Bestandsdaten) deutlich markiert und standardmäßig auskommentiert. Ergebnis öffnet sich als Abfrage-Tab auf der
   Zielverbindung – Ausführen ist Sache des Nutzers (Schutzregeln 012 greifen).
5. Umbenennungen erkennt die App nicht von selbst: als Paar „löschen + anlegen“ zeigen, mit der Möglichkeit, sie von
   Hand als Umbenennung zu kennzeichnen.
6. Schnappschuss speichern/laden; Bericht exportieren (Markdown/HTML).

## Entscheidungsfragen (Design)

- Umfang der ersten Fassung je Datenbank (PostgreSQL zuerst?) und was ausdrücklich nicht verglichen wird (Rechte,
  Partitionen, Speicherparameter).
- Vergleich über Typgrenzen (PostgreSQL ↔ MySQL) ausschließen oder nur anzeigen ohne Skript?

## Akzeptanzkriterien

- Rundreise-Test: Schema A, verändertes Schema B; das erzeugte Skript auf A angewendet ergibt laut Vergleich keinen
  Unterschied mehr zu B (für die unterstützten Objektarten).
- Kein zerstörender Schritt steht unkommentiert im Skript.

## Tests und Review

Rust: Diff- und Skript-Katalog, Rundreise gegen Container. Review: Reihenfolge, Datenverlust-Schritte.
