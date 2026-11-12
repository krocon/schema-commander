# Prompt 037: ER-Diagramm

> **Slug:** `er-diagramm` · **Feature:** B5 · **Braucht:** 008, 019 · **Umfang:** L
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DBeaver (ER-Reiter je Tabelle/Schema), DataGrip (Diagramme).

## Ziel

Beziehungen sehen: ein Diagramm einer Tabelle mit ihren Nachbarn oder eines (Teil-)Schemas – automatisch angeordnet,
verschiebbar, exportierbar.

## Aufgaben

1. **Modell** aus den Metadaten: Tabellen (Spalten, Schlüssel-Marken, Typen), Fremdschlüssel als Kanten mit
   Kardinalität (aus NOT NULL/Unique abgeleitet), virtuelle Beziehungen aus Prompt 030 gestrichelt.
2. **Einstiege**: „Diagramm“ an einer Tabelle (Nachbarn bis Tiefe *n*), an einem Schema, an einer Auswahl im Baum.
3. **Anordnung** automatisch (Schichten oder kräftebasiert; Bibliothek gegen Eigenbau im Design abwägen – Größe,
   Lizenz, kein UI-Framework), danach von Hand verschiebbar; Positionen je Diagramm speichern.
4. **Darstellung** als SVG (scharf, exportierbar, Farben aus Tokens): Zoom, Verschieben, „alles zeigen“; Detailgrad
   (nur Namen / Schlüssel / alle Spalten); Hervorheben der Kanten einer Tabelle; Suche.
5. **Bedienung per Tastatur** und für Screenreader: parallele Listenansicht der Tabellen und Beziehungen (das
   Diagramm allein ist nicht barrierefrei).
6. **Aktionen**: Tabelle öffnen/Details, Tabellen hinzufügen/entfernen, Export als SVG/PNG, als Mermaid/DBML-Text.
7. Große Schemata: ab einer Schwelle nur Auswahl/Nachbarschaft, mit Hinweis.

## Akzeptanzkriterien

- Tabelle mit 12 Nachbarn: lesbare Anordnung ohne Nacharbeit; 300 Tabellen: bedienbar (Zoom, Suche).
- Diagramm sieht in einem dunklen und einem hellen Schema richtig aus; Export enthält die Farben fest.
- Zusammengesetzte und selbstbezügliche Fremdschlüssel werden richtig gezeichnet.

## Tests

Rein: Modellbildung, Kardinalität, Anordnung (keine Überlappung, stabil bei gleicher Eingabe), Mermaid/DBML-Export.
