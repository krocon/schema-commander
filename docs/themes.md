# Farben und Farbschemata

Schema Commander hat **17 eingebaute Farbschemata** – die Basis **dark** und **light** und 15 Schemata nach bekannten
Editor-Themes – und beliebig viele **eigene**. Man wählt sie in einer Galerie mit Vorschaubildern („◐“ in der Toolbar)
und bearbeitet eigene im Schema-Editor. Mechanik und Schemata stammen
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

## Eigene Schemata (Prompt 001)

- **Anlegen**: in der Galerie „Neu aus gewähltem …“ (Kopie eines beliebigen Schemas) oder „Importieren …“. Eingebaute
  Schemata sind nicht änderbar.
- **Schema-Editor** (`features/themes/theme-editor.ts`, Seitenfeld rechts): Name, Helligkeit, jedes Token mit
  Farbwähler und Textfeld (`#hex`, `rgb()`, `hsl()`, `var(--token)`; Schriften als Namen), ↺ setzt auf die Basis
  zurück. Jede Änderung ist sofort im Fenster zu sehen; „Abbrechen“ stellt den Stand von vorher her.
- **Kontrast**: je Token das schwächste seiner Paare aus `contrast-pairs.json`, unter dem Soll mit „⚠“; unten die
  Zahl der Paare unter WCAG AA. Es ist ein Hinweis – speichern darf man trotzdem.
- **Gespeichert** wird nur, was von dark bzw. light abweicht, in **`themes.json`** im Konfigurationsordner der App
  (Rust `src-tauri/src/themes.rs`, Commands `load_themes`, `save_themes`). Grenzen: 50 Schemata, 300 Tokens,
  256 KiB; Ids beginnen mit `user-` und können kein eingebautes Schema überdecken. Eine defekte Datei wird als
  `themes.json.broken` beiseitegelegt, die App startet mit den eingebauten.
- **Export/Import**: eine Datei je Schema (`{ id, name, dark, tokens }`, `*.theme.json`), Pfad nur aus dem nativen
  Dialog. Beim Import überleben nur Katalog-Tokens mit gültigem Wert; der Editor nennt, was verworfen wurde. Fehlt
  `dark`, entscheidet die Helligkeit von `--bg-app`.
- **Doppelte Prüfung**: Rust prüft Form, Grenzen und harmlose Werte (kein `url(`, kein `; { } < > \ @`), das Frontend
  zusätzlich gegen den Katalog (`sanitizeTokens`, `tokenValueOk`). Nur was beides besteht, erreicht `<html>`.
- **Start**: Einstellungen und eigene Schemata werden geladen, bevor das Fenster erscheint.

## Tabelle und Editor

- **GuiExpert Table**: `src/styles/ge-table-theme.css` bildet `--ge-table-*` auf unsere Tokens ab.
- **editlicious** läuft mit `scheme="none"` und bekommt **jede** Farbe aus unseren Tokens:
  `features/editor/editor-colors.ts` (`EDITOR_COLORS`) wird als Inline-Style am Element gesetzt (die Variablen des
  Editors wirken nur dort) und löst gegen die Tokens auf `<html>` auf. Der Editor folgt damit jedem eingebauten und
  eigenen Schema sofort. Auswahl und Suchtreffer sind durchscheinend gemischt, weil der Editor die Textfarbe darüber
  nicht ändert. `color-scheme` am Element folgt der Helligkeit des Schemas. Eine Spec prüft, dass links nur
  dokumentierte Variablen des Pakets und rechts nur Katalog-Tokens stehen.
- Zeilenhöhen der Tabelle: `HEADER_ROW_HEIGHT`/`BODY_ROW_HEIGHT` in `features/results/result-model.ts`; die
  Zeilenhöhe des Textes in `ge-table-theme.css` muss dazu passen.

## Noch offen

Kürzel und Menüeintrag für die Galerie (Prompts 002, 018), Übersetzung der Texte (017), Import von Schemata anderer
Werkzeuge (VS Code, files-and-folders).
