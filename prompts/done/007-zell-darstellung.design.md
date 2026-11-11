# Design 007: Zellen richtig zeigen

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/zell-darstellung` · Auftrag: [007-zell-darstellung.md](007-zell-darstellung.md) · Feature D2

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Zahlen- und Datumsformat | **unverfälscht**: Zahlen Ziffer für Ziffer mit Punkt, Datum und Zeit so, wie Rust sie liefert (ISO). Einzige Einstellung: `groupDigits` (Tausendertrennung mit schmalem Leerzeichen, nur vor dem Komma), Aktion `TOGGLE_DIGIT_GROUPING` | was man sieht, ist der Wert; die Locale käme mit Prompt 017 |
| E2 | Wo wird gekürzt? | **an beiden Stellen**: Rust kürzt im Fenster auf 1000 Zeichen (006), die Anzeige auf 300 (`SHOWN_CHARS`), mit „…“ | wenig über die Brücke, wenig im DOM; der volle Wert kommt mit Prompt 026 |
| E3 | Renderer oder Klassen? | **kein Renderer für Zellen**: das `WindowAreaModel` liefert den Text (`getValueAt`) und die Klasse (`getCustomClassesAt`) aus `showCell(cell, kind)`; die Tabelle schreibt Text als Text | ein Weg weniger, auf dem ein Wert als HTML enden könnte; die Seiten behalten die Zellen, wie sie kamen (`cellAt`, Grundlage für 009 und 026) |
| E4 | Bilder der Zellen | `NULL` kursiv gedämpft (`sc-null`), leerer Text `∅` kursiv gedämpft (`sc-empty`), Zahl rechts in `--sql-number` (`sc-num`; auch große Ganzzahlen und Dezimalzahlen, die als Text kommen, und Zahlen in Spalten ohne Typ), Bool `true`/`false` in `--sql-keyword`, Binär `0x… (3,0 MB)` und Unlesbares `‹TYP›` gedämpft | `NULL`, `''` und der Text `NULL` sind drei Bilder (Test) |
| E5 | Entschärfen (`defuse`) | Zeilenumbruch `↵`, Tab `→`, Steuerzeichen als ihre Zeichen `␀…␡`, C1 sowie unsichtbare und umordnende Zeichen (Bidi, Zero-Width, BOM) als `‹U+202E›` | eine Zelle ist eine Zeile; nichts Unsichtbares täuscht |
| E6 | Spaltenkopf | eigener `HeaderRenderer`: Name, dahinter klein der Typ (klein geschrieben), `title` mit Name und vollem Typ – nur Textknoten | – |
| E7 | Auswahl | `SelectionModel('range', 'multi')` je Gitter: Zelle, Bereich (Ziehen, Umschalt+Klick), Mehrfachauswahl, Pfeiltasten; Fokusrahmen in `--accent` | Grundlage für Kopieren (009) und Auswerten (028) |
| E8 | Breiten | aus Kopf (Name + Typ) und den ersten 100 Zeilen, 60–420 px; Doppelklick auf den Rand passt an (höchstens 800 px) | – |
| E9 | Neue Tokens | **keine**: `--cell-null`, `--sql-number`, `--sql-keyword`, `--text-dim` reichen | alle vier sind in den Kontrastpaaren |

## Geprüft

- Katalog `cell-format.cases.json` (36 Fälle), dazu Kürzen, Entschärfen, Gruppieren.
- Im Browser mit nachgebildetem Backend: alle Zellarten, `<img src=x onerror=alert(1)>` erscheint als Text (kein
  `img` im DOM), Bereichsauswahl und Fokus per Maus und Pfeiltaste, 509 Spalten: 100 Sprünge über 40 000 px in 0,9 s,
  dabei unter 100 Zellen im DOM.

## Nicht umgesetzt, nicht geprüft

- **Marken für Primär-/Fremdschlüssel** und die Herkunftstabelle im Tooltip: die Treiber liefern sie nicht; kommt mit
  dem Schema-Baum (008) bzw. dem Bearbeiten (019).
- **Sortierzustand** im Kopf: Prompt 027. **Datumsformat** einstellbar, Locale: Prompt 017.
- Auswahl ganzer Zeilen/Spalten über Kopf und Zeilennummer wurde nicht eigens geprüft.
- Die Testtabellen „alle Typen“ der echten Server wurden nicht im Gitter angesehen (nur die Formatierung ihrer
  Zellarten), das native Fenster nicht von Hand; die Schemata nur über den Kontrast-Check, nicht mit dem Auge.
- Kontrast der Zellfarben auf markierten Zeilen (`--row-selected`) ist nicht in den Kontrastpaaren.
