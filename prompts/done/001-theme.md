# Prompt 001: Farbschemata fertig machen

> **Slug:** `theme` · **Feature:** G5 · **Braucht:** E1 (editlicious: Farben von außen) · **Umfang:** S–M
> Lies zuerst `prompts/000-arbeitsweise.md`, dann `docs/themes.md`. Vorbild: `files-and-folders-tauri`
> (`src/app/core/theme/`, `src/app/features/themes/theme-dialog.ts`, `src-tauri/src/themes.rs`, `docs/themes.md` dort).

## Ziel

Look and Feel umschaltbar **wie in files-and-folders**: Das Skeleton hat die Galerie mit 17 Schemata und „System
folgen“ (aus log-commander). Es fehlen: ein Editor, der jedem Schema folgt, eigene Schemata mit Live-Editor,
Import/Export und saubere Tabellen-Farben.

## Aufgaben

1. **Editor folgt jedem Schema**: Heute wählt `editorScheme()` eines der 13 festen Schemata von editlicious. Ziel: die
   Farben des Editors kommen aus unseren Tokens (`--bg-app`, `--bg-gutter`, `--text`, `--sql-*`, `--row-selected`,
   `--hit-*`, `--accent`). Im Design klären, welche `--ed-*`/`--syn-*`-Variablen `<editlicious-editor>` von außen
   annimmt (`../editlicious/src/styles.css`, `scripts/host-theme.mjs`, `packages/editlicious-editor/README.md`
   „Styling“). Was fehlt, bringt **Prompt E1** (`prompts/done/editlicious/E1-farben-von-aussen.md`, im Repo editlicious
   auszuführen); hier wird es nicht umgangen. Bis E1 veröffentlicht ist, bleibt die Zuordnung nach Helligkeit.
2. **Eigene Schemata**: Live-Editor nach fnf (Token-Liste nach Gruppen aus `core/theme/tokens.ts`, Farbwähler +
   Texteingabe, Vorschau sofort, Kontrast-Hinweis je Paar aus `contrast-pairs.json`). Speichern als JSON im
   Konfigurationsordner der App; nach Neustart aktiv; Umbenennen, Duplizieren, Löschen, Zurücksetzen.
3. **Import/Export** einer Schema-Datei (`{ id, name, dark, tokens }`); beim Import nur Katalog-Tokens mit gültigem
   Wert (`sanitizeTokens`), Bericht über Verworfenes. Fremde Dateien sind feindlich: Größe und Anzahl begrenzen.
4. **Ergebnistabelle**: `src/styles/ge-table-theme.css` vervollständigen (Auswahl, Fokus, Hover, Kopf, Sortier-Pfeil)
   und in allen 17 Schemata ansehen. Bekannte Lücken aus dem Skeleton: Zellen zentriert, Zeilenhöhe greift nicht.
5. **Bedienung**: Schema wechseln über Toolbar, Menü und Kürzel (das Kürzel als Aktion, sobald Prompt 002 da ist;
   bis dahin nur Toolbar). `docs/themes.md` aktualisieren, Herkunftstabelle der Schemata aus fnf übernehmen.

## Entscheidungsfragen (Design)

- Eigene Schemata über `tauri-plugin-store` (wie die Einstellungen) oder eigener Rust-Command mit Datei je Schema
  (wie fnf `themes.rs`)? Empfehlung begründen.
- Editor-Farben: vollständig aus Tokens, oder Tokens nur für Flächen und Syntaxfarben aus einem festen Editor-Schema?
- Braucht es zusätzliche Tokens (z. B. `--sql-operator`, `--sql-type`, Zeilen-Zebra, Kopfzeile der Tabelle)? Jeder
  neue Token in dark, light, Katalog und Kontrastpaaren.

## Akzeptanzkriterien

- In allen 17 Schemata passen Editor, Tabelle, Leisten und Dialoge zusammen; `pnpm contrast` grün.
- Ein eigenes Schema lässt sich anlegen, speichern, exportieren, importieren und ist nach einem Neustart aktiv.
- Eine manipulierte Schema-Datei (`url(…)`, `;`, 10 000 Tokens, falsche Typen) richtet nichts an (Test).
- Wechsel ohne Neustart und ohne Aufblitzen; Fensterrahmen folgt.

## Tests

Rein: Import-Prüfung, Zuordnung Token → Editor-Variable, Kontrast eigener Schemata. Komponente: Live-Editor
(Tastatur, Abbrechen stellt das alte Schema wieder her). Ende-zu-Ende: jedes Schema einmal ansehen.
