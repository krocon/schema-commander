# Farben und Farbschemata

Schema Commander hat **17 Farbschemata**: die Basis **dark** und **light** und 15 Schemata nach bekannten
Editor-Themes. Man wählt sie in einer Galerie mit Vorschaubildern („◐“ in der Toolbar). Mechanik und Schemata stammen
aus `log-commander` (dort Prompt 020), das sie aus `files-and-folders-tauri` abgeleitet hat. Herkunft und Lizenzen der
Vorlagen: `files-and-folders-tauri/docs/themes.md` (nur Farbwerte, keine Dateien der Originale).

## Aufbau

- **`src/styles.css` ist die Quelle für dark und light** (Blöcke `/* @theme dark */`, `/* @theme light */`). dark ist
  der Grundwert auf `:root`, light überschreibt über `data-theme='light'`. Jeder Farb-Token steht in beiden Blöcken
  als sechsstelliger Hex-Wert.
- **Alle anderen Schemata** liegen als JSON in `src/app/core/theme/themes/<id>.json` (`{ id, name, dark, tokens }`).
- `themes/dark.json` und `themes/light.json` werden nicht von Hand gepflegt: `pnpm contrast --write-base` schreibt sie
  aus `styles.css`, `pnpm contrast` bricht ab, wenn sie abweichen.
- **Katalog** `core/theme/tokens.ts`: jeder Token mit Gruppe, Name und Art. Nur Katalog-Tokens mit gültigem Wert
  gelangen je auf `<html>`.
- **Kontrast**: `core/theme/contrast-pairs.json` (Text 4.5:1, Grafik 3:1). `pnpm contrast` prüft alle Schemata, der
  Test `builtin-themes.spec.ts` ebenso.

## Tokens

| Gruppe | Tokens |
|---|---|
| Flächen | `--bg-app`, `--bg-panel`, `--bg-raised`, `--bg-hover`, `--bg-gutter`, `--border` |
| Text | `--text`, `--text-dim` |
| Akzent und Status | `--accent`, `--accent-text`, `--danger`, `--ok`, `--warn-fg/-bg`, `--error-fg/-bg/-edge`, `--badge-danger-fg/-bg` |
| Auswahl und Treffer | `--row-selected`, `--hit-bg`, `--hit-text`, `--hit-current-bg`, `--hit-current-text` |
| SQL | `--sql-keyword`, `--sql-string`, `--sql-number`, `--sql-comment`, `--sql-ident`, `--sql-function` |
| Ergebnis | `--cell-null` |
| Splitter | `--splitter-bg`, `--splitter-grip`, `--splitter-hover-bg` |
| Verbindungen | `--conn-1` … `--conn-8` (Farbmarke einer Verbindung; Klasse `conn-N` setzt `--conn`) |
| Diagramme | `--chart-1` … `--chart-8`, `--chart-grid` |
| Schrift | `--font-ui`, `--font-mono` |

Die Tokens sind aus denen von log-commander umbenannt (Level-, Lineal- und Zeitstrahl-Farben entfielen); die Werte der
Schemata sind dieselben.

## Auswahl und Anwendung

Einstellung `themeSelection` = `{ mode: 'system' | 'fixed', theme, light, dark }`. „System folgen“ nimmt je ein
wählbares helles und dunkles Schema. Der `ThemeService` setzt `data-theme`, `color-scheme` und die abweichenden Tokens
inline auf `<html>` und über den Command `set_window_chrome` Hintergrund und Erscheinungsbild des Fensterrahmens. Das
Fenster startet unsichtbar und wird mit dem ersten Schema gezeigt (kein Aufblitzen), spätestens nach 1 s.

## Tabelle und Editor

- **GuiExpert Table**: `src/styles/ge-table-theme.css` bildet `--ge-table-*` auf unsere Tokens ab.
- **editlicious**: hat 13 eigene Schemata im Shadow DOM. `features/editor/editlicious.ts` (`editorScheme`) wählt das
  passende (`amber` → `amber`, One Dark → `one`, sonst nach Helligkeit `one`/`paper`). Offen: die Farben des Editors
  ganz aus unseren Tokens speisen (`--ed-*`), damit er jedem der 17 Schemata folgt – siehe Feature-Liste.

## Noch nicht übernommen

Der Live-Editor für eigene Schemata und Import/Export aus files-and-folders (`features/themes/theme-dialog.ts` dort).
