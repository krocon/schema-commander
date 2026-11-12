# Design 037: ER-Diagramm

> **Status:** umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/er-diagramm` · Auftrag: [037-er-diagramm.md](037-er-diagramm.md) · Feature B5

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Daten | `meta_diagram(id, schema)` liest in **drei Fragen je Schema** (nicht je Tabelle): Tabellen mit Spalten (Typ, NULL, Primärschlüssel), Fremdschlüssel (auch die, die von außen ins Schema zeigen), eindeutige Spaltensätze. Gebundene Parameter; höchstens 2000 Tabellen | 300 Tabellen in einem Zug |
| E2 | Modell | rein im Fenster (`er-model.ts`): Tabellen als Knoten, Schlüssel als Kanten. **Kardinalität**: Zielseite „genau eine“ bzw. „höchstens eine“ (eine Schlüsselspalte nimmt NULL); Quellseite „viele“ bzw. „höchstens eine“ (die Schlüsselspalten sind zusammen eindeutig). Eigene Beziehungen (030) als gestrichelte Kanten. Schlüssel in andere Schemata werden gezählt und nicht gezeichnet | Aufgabe 1 |
| E3 | **Anordnung** | **Eigenbau**, keine Bibliothek: Schichten – eine Tabelle steht rechts von allem, worauf sie zeigt (längster Weg; Kreise und Selbstbezüge zählen dabei nicht) –, innerhalb der Schicht nach dem Schwerpunkt der Nachbarn geordnet, lange Schichten in Stapel von 12 geteilt, Tabellen ohne Schlüssel als Block darunter. Überlappungsfrei nach Bauart, gleiche Eingabe gibt dieselbe Anordnung (auch bei anderer Reihenfolge) | Entscheidungsfrage: dagre/elk wären 100 kB bis über 1 MB für Graphen, die klein und fast immer schichtbar sind; kein UI-Framework, keine neue Abhängigkeit |
| E4 | Darstellung | SVG im Dialog (fast fensterfüllend), Farben über die vorhandenen Tokens (`--bg-app`, `--bg-panel`, `--border`, `--text`, `--text-dim`, `--accent` – keine neuen). Krähenfuß-Marken an den Enden; Linien setzen an der Zeile der Schlüsselspalte an, wenn sie gezeigt ist. Zoom (Rad, Knöpfe), Verschieben (Ziehen des Grunds), „Alles zeigen“, Detailgrad (nur Namen / Schlüssel / alle Spalten), Suche (Treffer hervorgehoben, Rest blass), Kanten der gewählten Tabelle hervorgehoben | Aufgabe 4 |
| E5 | Von Hand | Tabellen ziehen; die Orte merkt sich die Einstellung `diagramPlaces` je Diagramm (Verbindung, Schema, Tabelle). „Neu anordnen“ vergisst sie | Aufgabe 3 |
| E6 | Tastatur und Screenreader | Neben der Zeichnung steht **dasselbe als Listen**: die Tabellen (eine Auswahlliste – Pfeiltasten, Eingabe öffnet die Daten) und die Beziehungen der gewählten Tabelle bzw. alle in Worten („book: author_id → author (id) · viele → genau eine“). Alle Aktionen sind Knöpfe; die Zeichnung selbst ist ein Bild mit Beschriftung | Aufgabe 5 |
| E7 | Einstiege | `SCHEMA_DIAGRAM` am Knoten eines Schemas (alles) oder einer Tabelle (Nachbarn bis Tiefe 1–4, im Dialog änderbar) | Aufgabe 2 |
| E8 | Aktionen | Daten öffnen, Einzelheiten (019), aus dem Diagramm nehmen, Tabelle hinzufügen, Nachbarn hinzufügen; Export: **SVG-Datei** (alle Farben ausgeschrieben, Namen als Text), **Mermaid** und **DBML** in die Zwischenablage | Aufgabe 6 |
| E9 | Große Schemata | Über 400 Tabellen beginnt das Diagramm mit den 400 mit den meisten Beziehungen und sagt das; weitere kommen über „Tabelle hinzufügen“ | Aufgabe 7 |

## Verträge

`meta_diagram → DiagramData { tables[{ schema, name, columns[{ name, typeName, nullable, pk }] }], keys: ForeignKey[],
unique[{ table, columns }], cut }`. Fenster: `SchemaApi.diagram`, `DiagramService`, `ErDiagramDialog`, `er-model.ts`,
`er-layout.ts`, `er-export.ts`; Einstellung `diagramPlaces`.

## Geprüft

- **Rust** (2 Tests, SQLite): Tabellen, Schlüssel (Selbstbezug ohne Zielspalten, Ziel in anderer Schreibweise, zwei
  Spalten), eindeutige Sätze samt Primärschlüssel; Falten und die Grenze von 2000 Tabellen.
- **Gegen echte Server** (PostgreSQL, CockroachDB, MySQL, MariaDB, SQL Server;
  `every_server_gives_what_a_diagram_is_drawn_from`): dieselben vier Tabellen, Spalten mit NULL und
  Primärschlüssel, vier Schlüssel, eindeutige Sätze.
- **Rein** (9 Tests): Modell und Kardinalität; eigene Beziehungen; Nachbarschaft und Kern; Schichten, auch mit einem
  Kreis; **300 Tabellen (eine mit 12 Nachbarn) in allen drei Detailgraden ohne Überlappung, stabil und unabhängig
  von der Reihenfolge der Eingabe**; Linien und Ansatzpunkte; Mermaid; DBML; SVG ohne Token und ohne Markup aus
  Namen.
- **Dialog** (8 Tests): Zeichnung und Listen, Tabelle mit Nachbarn und Tiefe, wählen/entfernen/hinzufügen, Suche und
  Detailgrad, Daten und Einzelheiten öffnen, Exporte, gemerkte Orte, Fehler.
- **Im Browser** mit nachgebildetem Backend: Tabelle mit 12 Nachbarn – lesbar ohne Nacharbeit; ganzes Schema mit
  zusammengesetztem und selbstbezüglichem Schlüssel; dunkles und helles Farbschema. **Nicht geprüft:** Ziehen und
  Rad mit der Maus im echten Fenster (`pnpm tauri dev`); 300 Tabellen wurden gerechnet (Test), nicht angesehen.
- `pnpm check` grün.

## Nicht umgesetzt

- **Export als PNG**: Es gibt die SVG-Datei; ein PNG bräuchte einen Weg, Binärdaten aus dem Fenster in eine Datei zu
  schreiben.
- Mermaid und DBML gehen in die Zwischenablage, nicht in eine Datei.
- Einstieg „an einer **Auswahl** im Baum“: Der Baum kennt keine Mehrfachauswahl; Tabellen werden im Diagramm
  hinzugefügt und entfernt.
- Diagramme über **mehrere Schemata**; Views im Diagramm.
- Kein Review durch einen zweiten Agenten: Das Feature liest nur den Katalog mit gebundenem Schemanamen und
  schreibt nichts.
- Ein Diagramm ist kein Tab: Es ist ein Dialog und merkt sich nur die Orte der Tabellen, nicht Auswahl, Zoom oder
  Detailgrad.
