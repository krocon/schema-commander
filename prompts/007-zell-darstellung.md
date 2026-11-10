# Prompt 007: Zellen richtig zeigen

> **Slug:** `zell-darstellung` · **Feature:** D2 · **Braucht:** 003, 006 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`, `../video/2026/guiexpert-table/mono/llms.txt` (Renderer, Klassen,
> Zeilenhöhen). Bestand: `src/app/features/results/result-model.ts`, `src/styles/ge-table-theme.css`. Vorbild:
> TablePlus, DataGrip.

## Ziel

Man sieht auf einen Blick, was in einer Zelle steht: `NULL` ist nicht leerer Text, Zahlen stehen rechts, Datum und
Zeit sind lesbar, JSON und Binärdaten sind als solche erkennbar, der Spaltenkopf nennt den Typ.

## Aufgaben

1. **Renderer je Zellart** (`Cell` aus Prompt 003): `NULL` (gedämpft, `--cell-null`), leerer String (eigenes
   Zeichen), Zahl (rechts, Monospace; Tausendertrennung nur als Einstellung, nie beim Kopieren), Dezimal ohne
   Rundung, Bool, Datum/Zeit/Zeitzone (Format einstellbar, Vorgabe ISO), UUID, JSON (einzeilig gekürzt), Binär
   (Größe + Anfang als Hex), Array, gekürzter langer Text mit „…“; Zeilenumbrüche und Tabs im Text sichtbar machen.
2. **Sicherheit**: Werte nie als HTML; Steuerzeichen und bidirektionale Unicode-Zeichen entschärft darstellen.
3. **Spaltenkopf**: Name, Typ (klein), Marke für Primär-/Fremdschlüssel (soweit bekannt), Sortierzustand; Tooltip
   mit vollem Typ und Herkunftstabelle.
4. **Zeilennummern-Spalte** links (fix), kompakte Zeilenhöhe; die Lücken aus dem Skeleton schließen (Zellen
   zentriert, `defaultRowHeights` greift nicht – Ursache klären, ggf. Vorschlag fürs Mono-Repo).
5. **Auswahl im Gitter**: Zelle, Bereich, Zeilen, Spalten per Maus und Tastatur (Grundlage für Kopieren 009,
   Auswerten 028); Fokusrahmen sichtbar in allen Schemata.
6. **Spaltenbreiten**: automatisch aus Kopf und sichtbaren Zeilen, Doppelklick auf den Rand = passend, Obergrenze.
7. Neue Tokens (z. B. `--cell-bool`, `--cell-date`, `--cell-key`) nur, wenn nötig; dann in dark, light, Katalog,
   Kontrastpaaren.

## Entscheidungsfragen (Design)

- Zahlen- und Datumsformat: fest (ISO, Punkt) oder nach System-Locale? Empfehlung: Vorgabe unverfälscht, Locale als
  Einstellung.
- Wo wird gekürzt: in Rust (weniger über die Brücke) oder im Renderer?

## Akzeptanzkriterien

- Die Testtabelle „alle Typen“ jeder Datenbank wird vollständig und unterscheidbar dargestellt; `NULL`, `''` und
  `'NULL'` (Text) sind drei verschiedene Bilder.
- Ein Wert `<img src=x onerror=alert(1)>` erscheint als Text.
- 500 Spalten scrollen horizontal flüssig.

## Tests

Rein: Formatierung je Zellart (Katalog `.cases.json`), Kürzen, Entschärfen. Im echten Fenster: Auswahl, Breiten, alle
Schemata.
