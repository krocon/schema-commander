# Prompt 021: Vervollständigung, die das Schema kennt

> **Slug:** `vervollstaendigung` · **Feature:** C3 · **Braucht:** 008, E3 (editlicious: Vorschläge von außen),
> besser auch E5 · **Umfang:** L
> Lies zuerst `prompts/000-arbeitsweise.md`, `prompts/editlicious/E3-vervollstaendigung-von-aussen.md`. Vorbild:
> DataGrip (der Maßstab), pgcli (einfach und treffsicher).

## Ziel

Der Editor schlägt vor, was an der Stelle sinnvoll ist: nach `FROM` Tabellen, nach `alias.` die Spalten dieser
Tabelle, nach `JOIN` die passende Tabelle samt `ON`-Bedingung aus dem Fremdschlüssel – je Dialekt, schnell, ohne zu
nerven.

## Aufgaben

1. **Kontext erkennen** (reine Logik, Testkatalog): Aus dem Text der aktuellen Anweisung bis zum Cursor bestimmen:
   erwartet wird Tabelle / Spalte / Schema / Funktion / Schlüsselwort / Typ / Alias; welche Tabellen und Aliase sind
   im Geltungsbereich (auch aus dem Teil **nach** dem Cursor, Unterabfragen, CTEs mit ihren Spalten). Fehlertolerant:
   der Text ist beim Tippen fast immer unvollständig.
2. **Vorschläge**: Tabellen/Views (aktuelles Schema zuerst, andere qualifiziert), Spalten mit Typ, Funktionen mit
   Signatur, Schlüsselwörter des Dialekts, Aliase, CTE-Namen, Snippets (Prompt 024). Rangfolge: Kontext, Nähe,
   zuletzt benutzt.
3. **Kluge Einfügungen**: `JOIN` schlägt `tabelle alias ON a.fk = b.pk` aus Fremdschlüsseln vor; `*` zu
   Spaltenliste aufklappen (Aktion); `INSERT INTO t (` füllt Spalten; `GROUP BY`/`ORDER BY` schlägt die Spalten des
   `SELECT` vor; Bezeichner werden richtig gequotet (Funktion aus Prompt 008).
4. **Metadaten**: aus dem Zwischenspeicher in Rust; fehlt etwas (Spalten einer Tabelle), im Hintergrund nachladen
   und die Liste ergänzen, ohne das Tippen zu blockieren.
5. **Anbindung** über den Anbieter aus E3 (`completionProvider`), Auslöser: Tippen, `.`, `Ctrl+Space`;
   Einstellungen: automatisch an/aus, Verzögerung, Schlüsselwörter groß/klein.
6. **Signaturhilfe** für Funktionen und Schnellinfo am Bezeichner – wenn E3 es hergibt, sonst als Folgepunkt notieren.

## Entscheidungsfragen (Design)

- Kontextanalyse mit SQL-Parser (crate; fehlertolerant?) oder eigenem Tokenizer + Heuristik wie pgcli? Im Frontend
  (schnell, nah am Editor) oder in Rust (nah an den Metadaten)?
- Wie groß darf der Metadaten-Vorrat im Speicher werden (50 000 Tabellen × Spalten)?

## Akzeptanzkriterien

- Katalog von mindestens 150 Fällen („Text mit `▮` → erwartete erste Vorschläge“) je Dialekt grün.
- `SELECT o.▮ FROM orders o JOIN customer c ON …` zeigt nur die Spalten von `orders`.
- In einem 50-MB-Skript bleibt das Tippen flüssig (die Analyse sieht nur die aktuelle Anweisung).
- Ohne Verbindung gibt es Schlüsselwörter und Wörter aus dem Text, keinen Fehler.

## Tests

Rein: Kontext- und Rangfolge-Katalog. Rust: Metadaten-Vorrat, Nachladen. Ende-zu-Ende: echtes Schema, gefühlte
Geschwindigkeit, kein Flackern.
