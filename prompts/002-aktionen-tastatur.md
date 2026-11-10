# Prompt 002: Aktionssystem, Tastatur, Befehlspalette

> **Slug:** `aktionen-tastatur` · **Feature:** G1 · **Braucht:** – · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild und Quelle: `log-commander/src/app/core/actions/`
> (`action-catalog.ts`, `action.service.ts`, `keyboard-dispatcher.ts`, `keymap.ts`, `shortcut.ts`,
> `keymaps/{macos,windows,linux}.json`), `log-commander/src/app/features/shortcuts/`; Befehlspalette:
> `files-and-folders-tauri/src/app/features/palette/`.

## Ziel

Jede Funktion der App ist eine **Aktion** mit Id, Name und Kürzel. Es gibt genau einen Tastatur-Verteiler, eine Keymap
je Betriebssystem, einen Kürzel-Editor und eine Befehlspalette. Alle späteren Prompts hängen ihre Funktionen hier ein.

## Aufgaben

1. **Aktionsregister**: Katalog (`core/actions/action-catalog.ts`) mit Id, Titel, Gruppe; `ActionService.register`
   / `registerAll` / `run(id, source)`; Aktionen können abgeschaltet sein (`enabled`-Signal) und einen Zustand haben
   (umschaltbar).
2. **Keymap**: JSON je OS, `Mod` = Cmd bzw. Strg; Akkorde (`Mod+K Mod+S`); eigene Belegung in den Einstellungen
   (überlagert die Vorgabe, defekte Einträge werden mit Hinweis verworfen).
3. **Verteiler**: ein `keydown`-Handler am Dokument. Regeln festhalten: Was der Editor selbst nutzt, bleibt beim
   Editor (Liste aus der Doku von editlicious); Dialoge, Menüs, Splitter behalten ihre eigenen Tasten (APG).
   `Mod+Enter` im Editor wird zur Aktion `RUN_STATEMENT` (heute fest in `sql-editor.ts`).
4. **Befehlspalette** (`Mod+Shift+P`): unscharfe Suche über alle Aktionen, zeigt Kürzel, zuletzt benutzte oben.
5. **Kürzel-Editor**: Liste aller Aktionen, Kürzel aufnehmen/entfernen/zurücksetzen, Konflikte anzeigen; Übersicht
   (`?` bzw. Menü Hilfe).
6. Bestehendes umstellen: Ausführen, Seitenleiste ein/aus, Farbschema wählen.

## Entscheidungsfragen (Design)

- Vorgabe-Kürzel: an welchem Werkzeug orientieren (DataGrip, TablePlus, VS Code)? Tabelle je OS mit Begründung;
  Kollisionen mit Systemkürzeln (macOS `Cmd+H`, `Cmd+Q`, Linux `Alt+…`) vermeiden.
- Wie erfährt der Verteiler, ob der Fokus im Editor (Shadow DOM) liegt und der Editor die Taste verbraucht?
- Kontexte (`when`): Editor, Ergebnis, Baum, Dialog – wie viele braucht es am Anfang?

## Akzeptanzkriterien

- Jede vorhandene Funktion ist über Palette und Kürzel erreichbar; kein verstreuter `keydown`-Handler für Funktionen.
- Ein Kürzel lässt sich ändern, überlebt den Neustart und wird in Tooltips und Palette richtig angezeigt.
- Tippen im Editor löst keine Aktion aus, die ein Zeichen verschluckt (Test mit `AltGr`-Zeichen wie `@`, `{`, `\`
  auf deutscher Tastatur, Windows/Linux).

## Tests

Rein: Kürzel parsen/normalisieren je OS, Akkorde, Konflikte, Zusammenführen eigener Belegung. Komponente: Palette und
Kürzel-Editor per Tastatur. Ende-zu-Ende: deutsche Tastatur, macOS und eine zweite Plattform, soweit verfügbar.
