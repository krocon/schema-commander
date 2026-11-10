# Prompt 018: Menüleiste und Kontextmenüs

> **Slug:** `menues` · **Feature:** G4 · **Braucht:** 002 (017 für Übersetzung) · **Umfang:** S–M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild und Quelle: `files-and-folders-tauri` Prompt 014
> (`src-tauri/src/app_menu.rs`, `src/app/core/menu/`, `features/menus/`), `log-commander/src-tauri/src/menu_accel.rs`.

## Ziel

Eine Menüleiste, wie sie das Betriebssystem erwartet, und Kontextmenüs an Baum, Editor, Tabs und Ergebnis – beide aus
**einem Menümodell**, dessen Einträge Aktionen sind.

## Aufgaben

1. **Menümodell** im Frontend (Baum aus Aktions-Ids, Trennern, Untermenüs; Zustand aktiv/abgehakt aus dem
   `ActionService`).
2. **Native Menüleiste** (macOS immer; Windows/Linux nativ oder HTML – im Design entscheiden wie fnf): Rust baut sie
   aus dem Modell, Klicks kommen als Ereignis zurück; Kürzel folgen der Keymap (auch nach Änderung); Sprache folgt.
   macOS-Pflichtmenüs (App, Bearbeiten mit Kopieren/Einfügen, Fenster) korrekt, damit Systemkürzel im Editor
   funktionieren.
3. **Kontextmenü-Komponente** nach APG (Menü, Untermenü, Tastatur, Fokus zurück), positioniert im Fenster; für
   Baumknoten, Tab-Reiter, Ergebniszellen/-köpfe, Verbindungsliste. Im Editor: eigenes Menü oder das von editlicious
   – im Design klären.
4. Menüstruktur festlegen: Datei, Bearbeiten, Ansicht, Abfrage, Verbindung, Werkzeuge, Fenster, Hilfe.
5. Validierung des Modells in Rust (Größe, Tiefe, nur bekannte Ids).

## Akzeptanzkriterien

- Jeder Menüeintrag führt dieselbe Aktion aus wie Kürzel und Palette und zeigt das aktuelle Kürzel.
- Abgeschaltete Aktionen sind im Menü grau; Umschalter zeigen ihren Zustand.
- Kontextmenü per `Shift+F10`/Menütaste, vollständig mit der Tastatur bedienbar.
- `Cmd+C/V/X/A/Z` wirken auf macOS im Editor, in Eingabefeldern und im Gitter richtig.

## Tests

Rein: Menümodell → nativer Aufbau, Kürzel-Umsetzung je OS. Komponente: Kontextmenü-Tastatur. Von Hand: native
Menüleiste auf jedem verfügbaren System.
