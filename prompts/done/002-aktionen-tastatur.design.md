# Design 002: Aktionssystem, Tastatur, Befehlspalette

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/aktionen-tastatur` · Auftrag: [002-aktionen-tastatur.md](002-aktionen-tastatur.md) · Feature G1

## Entscheidungen

| Nr. | Entscheidung | Grund |
|---|---|---|
| E1 | Engine aus log-commander übernommen (`core/actions/`: Katalog, Keymap je OS, Notation, Verteiler, `ActionService`) samt Kürzel-Editor (`features/shortcuts/`) | erprobt, gleiche Bedienung in allen Projekten |
| E2 | Zwei Geltungsbereiche: `global` (überall außer in Dialogen; in Feldern und im Editor nur mit Mod/Strg/Alt oder F-Taste) und `view` (nur ohne Feld, Editor, Dialog, Menü, Widget). `field` und `panels` aus log-commander entfallen | es gibt hier kein Suchfeld und keine Panels mit eigenen Buchstabentasten |
| E3 | **Der Editor ist ein Textfeld**: `placeOf` erkennt `editlicious-editor` (Shadow DOM: Ziel des Ereignisses ist das Element) als `input`. Einfache Tasten erreichen dort nie eine Aktion | Tippen darf nie eine Aktion auslösen |
| E4 | Unser Verteiler sitzt in der Capture-Phase am Dokument und gewinnt vor dem Editor. Deshalb sind die Tasten des Editors **reserviert** (`Mod+C/V/X/A/Z`, `Mod+F`, `F3`, `Strg+Leertaste`): keine globale Aktion darf sie bekommen, weder in der Vorgabe noch im Kürzel-Editor | sonst verschluckt die App Suchen/Kopieren im Editor |
| E5 | **AltGr**: In Feldern und im Editor wird ein Tastendruck, der über AltGr ein Zeichen tippt (Windows/Linux melden ihn als Strg+Alt), nie zur Aktion – erkannt über `getModifierState('AltGraph')` oder daran, dass ein Zeichen entsteht, das kein Buchstabe und keine Ziffer ist (`@ { [ ] } \ | ~ €`) | Akzeptanzkriterium „deutsche Tastatur“; ohne das verschluckte ein eigenes Kürzel `Strg+Alt+Q` das `@` |
| E6 | Vorgabe-Kürzel nah an VS Code: `Mod+Enter` ausführen, `Mod+B` Seitenleiste, `Mod+Shift+P`/`F1` Palette, `Mod+K Mod+S` Kürzel-Editor, `F6`/`Shift+F6` Bereich wechseln, `Mod+0/1/2` Seitenleiste/Editor/Ergebnis, `Mod+Alt+T` Farbschema, `?` Übersicht. Alle drei Systeme gleich (`Mod` = Cmd bzw. Strg) | bekannt, kollidiert mit keinem Systemkürzel und keiner Editor-Taste |
| E7 | Befehlspalette als eigene kleine Komponente (`features/palette/`), nicht die universelle Palette aus fnf: unscharfe Suche in reiner Logik (`palette-logic.ts`), zuletzt benutzte Aktionen in den Einstellungen (`recentActions`) | „Springen zu allem“ (Prompt 020) baut darauf auf, braucht aber den Namensindex erst dann |
| E8 | Die gewählte Aktion läuft **nach** dem Schließen der Palette | der Fokus ist dann wieder dort, wo er war (Editor), und die Aktion findet ihn |
| E9 | Eigene Belegung in den Einstellungen (`keymap: { version, bindings }`), nur Abweichungen von der Vorgabe; Unlesbares → Vorgabe mit Hinweis | wie log-commander |
| E10 | `sendMenu` (Kürzel an die native Menüleiste) ist bis Prompt 018 ein Leerlauf | es gibt noch kein Menü |

## Aktionen

`RUN_STATEMENT`, `TOGGLE_SIDEBAR`, `COLOR_SCHEME`, `EDIT_COLOR_SCHEME` (ohne Kürzel), `OPEN_PALETTE` (nicht in der
Palette selbst), `FOCUS_EDITOR`, `FOCUS_RESULT`, `FOCUS_SIDEBAR`, `FOCUS_NEXT_AREA`, `FOCUS_PREV_AREA`,
`OPEN_SHORTCUTS`, `SHOW_SHORTCUTS`. Ids sind in den Einstellungen gespeichert und werden nie umbenannt.

Neue Aktion anlegen: Eintrag in `action-catalog.ts`, Kürzel in den drei `keymaps/*.json`, Handler per
`ActionService.register` in der Komponente, der die Funktion gehört. Der Test `keymap.spec.ts` schlägt an, wenn die
Vorgabe Konflikte, unbekannte Ids oder reservierte Tasten enthält.

## Tests

`keymap.spec.ts` (Vorgaben je OS, Überlagerung, Konflikte, Reserviertes), `keyboard-dispatcher.spec.ts` (Orte,
Editor als Feld, AltGr, Akkord mit Zeitgrenze, Wiederholung, abgeschaltete Aktion reicht die Taste durch),
`action.service.spec.ts`, `shortcut.spec.ts` (Notation, aus log-commander), `shortcut-logic.spec.ts`,
`palette-logic.spec.ts`, `command-palette.spec.ts`, `settings.models.spec.ts` (`mergeKeymap`), `app.spec.ts`
(Bereichswechsel).

## Ende-zu-Ende

Im Browser (Dev-Server) geprüft: `Cmd+Enter` im Editor führt die Anweisung unter dem Cursor aus und tippt keinen
Zeilenumbruch; Palette filtert, zeigt Kürzel, führt aus; Kürzel-Editor listet alle Aktionen.
**Nicht geprüft:** das native Fenster; `Cmd+Shift+P` als echter Tastendruck (die Browser-Vorschau fängt ihn ab –
das Ereignis wurde nachgestellt); Windows und Linux (deutsche Tastatur ist nur durch die Tests abgedeckt).

## Offen

Kontexte über `global`/`view` hinaus (Ergebnis, Baum) kommen mit den Prompts, die sie brauchen. Texte sind deutsch
(Prompt 017). Menü-Kürzel: Prompt 018.
