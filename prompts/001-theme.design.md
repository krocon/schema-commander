# Design 001: Farbschemata fertig machen

> **Status:** Entwurf, wartet auf Freigabe 🛑 · **Datum:** 11.11.2026 · **Branch:** `feat/theme`
> Auftrag: [001-theme.md](001-theme.md) · Feature G5 · Voraussetzung E1 ist erfüllt (`editlicious-editor` 1.2.0).

## Kurzfassung der Entscheidungen

| Nr. | Entscheidung |
|---|---|
| E1 | Der Editor läuft mit `scheme="none"` und bekommt **alle** Farben aus unseren Tokens (eine CSS-Zuordnung am Element). `editorScheme()` und die Zuordnung auf 13 feste Schemata entfallen. |
| E2 | **Keine neuen Tokens.** Die Syntaxklassen des Editors werden auf die vorhandenen `--sql-*`-Tokens gelegt; was kein eigenes Token hat, nimmt `--text` bzw. `--text-dim`. |
| E3 | Eigene Schemata liegen in **einer Datei `themes.json`** im Konfigurationsordner, gelesen und geschrieben von einem kleinen Rust-Modul `themes.rs` (nach fnf), nicht über `tauri-plugin-store`. |
| E4 | Import/Export über den nativen Dateidialog (`tauri-plugin-dialog`, neue Abhängigkeit) und zwei eigene Commands; das Frontend liest nie selbst Dateien. |
| E5 | Ein eigenes Schema speichert wie die mitgelieferten **nur die Abweichungen** von dark bzw. light. |
| E6 | Der Live-Editor ist ein eigener Dialog („Schema bearbeiten …“), erreichbar aus der Galerie. Die Galerie bleibt, wie sie ist. |
| E7 | Eigene Schemata werden beim Start **vor** dem Zeigen des Fensters geladen (kein Aufblitzen); die 1-s-Rückfallzeit in Rust bleibt. |
| E8 | Phasen 2 (Rust) und 3 (Frontend) bleiben getrennt; Kürzel für „Farbschema wählen“ kommt erst mit Prompt 002 (heute nur Toolbar). |

## 1. Bestand

| Baustein | Wofür | Befund |
|---|---|---|
| `core/theme/theme.service.ts` | Auswahl, Vorschau, Tokens auf `<html>`, Fensterrahmen | passt; muss eigene Schemata in den Katalog aufnehmen (heute nur `BUILT_IN_THEMES`) |
| `core/theme/theme-logic.ts` | Werte prüfen (`tokenValueOk`, `sanitizeTokens`), `completeTokens`, `diffTokens`, `checkContrast` | passt vollständig, wird vom Live-Editor und vom Import benutzt |
| `core/theme/theme.models.ts` | `BUILT_IN_DARK` (Helligkeit vor dem Laden bekannt) | fehlt für eigene Schemata → E7 |
| `features/themes/theme-picker.ts` | Galerie | muss eigene Schemata als eigene Gruppe zeigen und Bearbeiten/Neu/Import anbieten |
| `features/editor/editlicious.ts` | `editorScheme()` → eines von 13 Schemata | **entfällt** (E1) |
| `styles/ge-table-theme.css` | Brücke zur GuiExpert Table | unvollständig: Zellen zentriert, Zeilenhöhe greift nicht, Auswahl/Sortierpfeil ungeprüft |
| fnf `features/themes/theme-dialog.ts` (477 Z.) | Live-Editor mit Farbwähler, Kontrast, Import/Export | Vorlage; hängt an fnf-Bausteinen (`Modal`, `DialogService`, `DialogKey`, i18n), die es hier nicht gibt → auf `<dialog>` wie die Galerie umbauen |
| fnf `src-tauri/src/themes.rs` (1005 Z.) | Datei, Grenzen, Prüfung, Import/Export | Vorlage; ohne den Legacy-Teil (`--fnf-*`) bleibt etwa ein Drittel |
| `editlicious-editor` 1.2.0 | `scheme="none"`, `color-scheme`, 60 dokumentierte Variablen | passt (README „Colour variables“) |

## 2. Editor folgt jedem Schema (E1, E2)

`<editlicious-editor scheme="none" [attr.color-scheme]="dark ? 'dark' : 'light'">`, dazu in den Styles von
`SqlEditor` am Element (Variablen wirken nur dort, nicht von `<html>`):

| Editor-Variable | Unser Token |
|---|---|
| `--ed-bg` / `--ed-text` | `--bg-app` / `--text` |
| `--ed-gutter-bg` / `--ed-gutter-text` / `--ed-gutter-text-active` | `--bg-gutter` / `--text-dim` / `--text` |
| `--ed-current-line` | `color-mix(in srgb, var(--text) 5%, transparent)` |
| `--ed-selection` / `--ed-selection-inactive` | `color-mix(… var(--accent) 30%, transparent)` / `color-mix(… var(--text-dim) 22%, transparent)` |
| `--ed-caret` | `--accent` |
| `--ed-search-match` / `--ed-search-current` | `color-mix(… var(--hit-current-bg) 30%, transparent)` / `… 60%` |
| `--ed-scrollbar` / `-hover` | `--bg-hover` / `--text-dim` |
| `--ed-indent-guide`, `--ed-whitespace` | `--border` |
| `--ed-mark-error` / `-warning` / `-info` / `-hint` | `--danger` / `--warn-fg` / `--accent` / `--text-dim` |
| `--syn-keyword` / `-string` / `-number` / `-comment` / `-function` | `--sql-keyword` / `--sql-string` / `--sql-number` / `--sql-comment` / `--sql-function` |
| `--syn-constant` / `--syn-type` | `--sql-number` / `--sql-ident` |
| `--syn-variable` | `--text` |
| `--syn-operator`, `--syn-punct` | `--text-dim` |
| `--syn-invalid` | `--danger` |
| `--color-bg`, `--color-surface`, `--color-surface-2`, `--color-hover` | `--bg-panel`, `--bg-raised`, `--bg-hover`, `--bg-hover` |
| `--color-text`, `--color-text-muted`, `--color-border` | `--text`, `--text-dim`, `--border` |
| `--color-accent`, `--color-accent-text`, `--color-focus` | `--accent`, `--accent-text`, `--accent` |
| `--color-error`, `--color-warning` | `--danger`, `--warn-fg` |
| `--font-editor` | `--font-mono` (Matrix und Amber bringen ihre eigene mit) |

Auswahl und Treffer sind durchscheinend gemischt, weil der Editor die Textfarbe darüber nicht ändert: Ein deckendes
`--hit-current-bg` (hell, für dunklen Text gedacht) würde hellen Text unlesbar machen. Die genauen Prozentwerte
stelle ich in Phase 4 im Fenster ein. Die übrigen Variablen (Wort-Marker, Diff-, Log-, Markdown-Farben) bleiben bei
dem, was `scheme="none"` aus Hintergrund und Text ableitet – sie kommen in SQL nicht vor.

**Warum keine neuen Tokens (E2):** Ein neues Token (`--sql-type`, `--sql-operator`) hätte in den 15 abgeleiteten
Schemata den Wert der Basis dark/light, also eine Farbe außerhalb ihrer Palette, bis jemand 15 Dateien von Hand
nachzieht. Der Gewinn ist gering: SQL hat kaum Typen und Operatoren, die eine eigene Farbe brauchen.

**Test:** Eine Spec liest die Zuordnung und prüft, dass jede Variable links im README des Pakets vorkommt und jedes
Token rechts im Katalog (`tokens.ts`) – eine Umbenennung auf einer der beiden Seiten fällt damit auf.

## 3. Eigene Schemata (E3, E5, E7)

### Speicherort – Optionen

| Option | Dafür | Dagegen |
|---|---|---|
| A `tauri-plugin-store` (wie die Einstellungen) | kein Rust-Code | keine Grenzen und keine Prüfung im Backend; Import/Export brauchen trotzdem Dateizugriff; eine kaputte Datei reißt die Einstellungen mit |
| **B eigenes Modul `themes.rs`, eine Datei `themes.json`** | Grenzen und Prüfung im Backend, atomar schreiben, kaputte Datei wird beiseitegelegt; erprobt in fnf | etwa 300 Zeilen Rust mit Tests |
| C eine Datei je Schema in einem Ordner | von Hand teilbar | Ordner überwachen, Namenskonflikte; Export deckt das Teilen schon ab |

**Empfehlung B.**

### Vertrag

```rust
// src-tauri/src/themes.rs (rein) + commands
#[serde(rename_all = "camelCase")]
pub struct UserTheme { id: String, name: String, dark: bool, tokens: BTreeMap<String, String> }
pub struct ThemesFile { version: u32, themes: Vec<UserTheme> }
pub struct LoadedThemes { themes: Vec<UserTheme>, notice: Option<String> }   // notice: Datei war defekt

load_themes()                         -> LoadedThemes
save_themes(file: ThemesFile)         -> ()
import_theme(path: String)            -> serde_json::Value   // roh; das Frontend prüft und zeigt, was es verwirft
export_theme(path: String, theme: UserTheme) -> ()
```

- Alle vier `#[tauri::command(async)]`. Grenzen wie fnf: 50 Schemata, 300 Tokens, Name 100 Zeichen, Wert 200 Zeichen,
  Importdatei 256 KiB. Id `[a-z0-9-]{1,64}` mit Präfix `user-` (kann nie ein eingebautes Schema überdecken).
- Rust prüft Form und Grenzen (`token_name_ok`, `value_ok`: keine `; { } < > \ @`, kein `url(`), das Frontend prüft
  zusätzlich gegen den Katalog (`sanitizeTokens`) – nur Katalog-Tokens mit gültigem Wert erreichen je `<html>`.
- Neue Fehlercodes: `invalid_theme` (Form, Grenzen), `too_large`, `not_found`; in `error.rs` und `app-error.ts`.
- `path` kommt nur aus dem nativen Dialog; Export schreibt in eine Nachbardatei und benennt atomar um.
- TS: `ThemeApi` (abstrakt) + `TauriThemeApi`, Fake in `src/testing/fake-apis.ts`.

### Start ohne Aufblitzen (E7)

`App.ngOnInit` lädt Einstellungen und eigene Schemata **parallel**; der `ThemeService` zeigt das Fenster erst, wenn
beides da ist (heute: nur Einstellungen). Ist ein eigenes Schema gewählt, das es nicht mehr gibt, greift der
vorhandene Rückfall auf die Basis seiner Helligkeit.

## 4. Bedienung

Galerie (bestehend) bekommt eine Gruppe „Eigene“ und drei Knöpfe; der Live-Editor ist ein zweiter Dialog:

```
┌ Farbschema ───────────────────────────────── × ┐   ┌ Schema bearbeiten ─────────────────────── × ┐
│ Filter [____________]        19 von 19 Schemata │   │ Name [Mein Schema______]  (•) dunkel ( ) hell│
│ [System folgen]                                 │   │ Filter [________]                            │
│ Eigene      [▣ Mein Schema] [▣ …]               │   │ Flächen                                      │
│ Dunkel      [▣][▣][▣][▣][▣] …                   │   │  Hintergrund      [■] [#14171c ]  ↺          │
│ Hell        [▣][▣][▣][▣]                        │   │  Leisten          [■] [#1b1f26 ]  ↺          │
│─────────────────────────────────────────────────│   │ Text                                         │
│ [Neu aus aktuellem] [Bearbeiten] [Importieren…] │   │  Text             [■] [#d7dce3 ]  ↺   4.2 ⚠  │
│                          [Abbrechen]  [OK]      │   │ …                                            │
└─────────────────────────────────────────────────┘   │ Kontrast: 2 Paare unter WCAG AA  [zeigen]    │
                                                      │ [Exportieren…] [Löschen]   [Abbrechen] [Speichern]│
                                                      └──────────────────────────────────────────────┘
```

- **Neu aus aktuellem** dupliziert das gewählte Schema (eingebaut oder eigenes) und öffnet den Editor. Eingebaute
  Schemata selbst sind nicht änderbar.
- Jede Änderung wirkt sofort im Fenster hinter dem Dialog (Vorschau des `ThemeService`). **Abbrechen** stellt den
  Stand von vorher her, **Speichern** schreibt `themes.json`.
- Je Token: nativer Farbwähler (`<input type="color">`) + Textfeld (Hex, `rgb()`, `hsl()`, `var(--token)`), ↺ setzt
  auf den Wert der Basis zurück. Schrift-Tokens als Textfeld. Ungültige Eingabe: Feld markiert, Wert nicht
  übernommen.
- **Kontrast**: Neben jedem Token das schlechteste Verhältnis seiner Paare aus `contrast-pairs.json`; unter dem
  Soll ein Warnzeichen mit Text (nicht nur Farbe). Speichern bleibt erlaubt – es ist das Schema des Nutzers.
- **Importieren**: Dateidialog → Prüfung → Editor öffnet mit dem Inhalt und einer Zeile „3 Einträge verworfen: …“.
- Tastatur: Dialoge sind `<dialog>` (Fokusfalle, `Esc`), Reihenfolge Name → Helligkeit → Filter → Token-Liste →
  Knöpfe; jede Zeile hat beschriftete Felder (`aria-label` „Hintergrund, Farbe“).
- Texte deutsch wie die Galerie (Kataloge kommen mit Prompt 017).

## 5. Ergebnistabelle

Offene Punkte aus dem Skeleton, Ursache wird in Phase 3 mit `llms.txt`/`instructions.md` der Tabelle geklärt:

- Zellen stehen zentriert → linksbündig (Zahlen rechts bleibt).
- `defaultRowHeights` wirkt nicht (Zeilen ~27 px statt 22 px).
- Auswahl, Fokusrahmen, Hover, Sortierpfeil, Griff für die Spaltenbreite in allen Schemata prüfen und fehlende
  `--ge-table-*` in `ge-table-theme.css` ergänzen.

Liegt die Ursache in der Tabelle selbst, steht sie als Vorschlag fürs Mono-Repo im Abschlussbericht. `NULL`-Anzeige
und Renderer bleiben bei Prompt 007.

## 6. Abhängigkeiten

| Paket | Wofür | Begründung |
|---|---|---|
| `tauri-plugin-dialog` + `@tauri-apps/plugin-dialog` | Datei wählen bei Import/Export | nativer Dialog; in log-commander im Einsatz; Prompts 004, 011, 033 brauchen ihn ebenfalls. Capability nur `dialog:allow-open`, `dialog:allow-save`. |

## 7. Tests

| Wo | Was |
|---|---|
| Rust `themes.rs` | Laden: fehlt / leer / defekt (beiseitegelegt, `notice`) / zu groß; Speichern atomar; Grenzen; `value_ok` mit feindlichen Werten (`url(`, `;`, Steuerzeichen, 10 000 Tokens); Import zu groß / kein JSON; Export-Rundreise; Unicode im Namen |
| TS rein | Zuordnung Editor-Variable ↔ Token gegen README und Katalog; Import-Prüfung (was wird verworfen); Kontrast je Token; neue Id (`user-…`, eindeutig) |
| TS `ThemeService` | eigene Schemata im Katalog; Start wartet auf beide Ladevorgänge; gelöschtes gewähltes Schema → Basis |
| TS Komponenten | Live-Editor: ändern → Vorschau, Abbrechen stellt her, Speichern ruft die Fassade; Tastatur; ungültige Eingabe |
| Ende-zu-Ende | alle 17 Schemata + ein eigenes mit Editor, Tabelle, Dialogen ansehen; anlegen → Neustart → aktiv; exportieren → löschen → importieren; manipulierte Datei importieren |

`pnpm contrast` bleibt für die eingebauten Schemata; eigene werden nur im Dialog bewertet.

## 8. Nicht in diesem Prompt

Kürzel und Menüeintrag (002, 018), Übersetzung (017), `NULL`-Darstellung und Renderer (007), Tokens für geänderte
Zellen (031), Import von Schemata anderer Werkzeuge (VS Code, fnf).

## Fortschritt

- [x] Vorbereitung: Branch `feat/theme`, `editlicious-editor` 1.2.0, `pnpm check` grün (Commit `df20c06`)
- [x] Phase 1: dieses Dokument
- [ ] 🛑 Freigabe
- [ ] Phase 2: Rust (`themes.rs`, Commands, Dialog-Plugin)
- [ ] Phase 3: Frontend (Editor-Zuordnung, `ThemeApi`, Galerie, Live-Editor, Tabellen-Brücke)
- [ ] Phase 4: Ende-zu-Ende
- [ ] Phase 5: Doku (`docs/themes.md`, `architecture.md`, README, Index)
- [ ] Phase 6: Abschlussprüfung und Bericht
