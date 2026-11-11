# Design 018: Menüleiste und Kontextmenüs

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/menues` · Auftrag: [018-menues.md](018-menues.md) · Feature G4

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Ein Menümodell | `features/menus/menu-model.ts` (rein): ein Menü ist eine Liste aus Aktions-Ids, `'-'`, Untermenüs (`sub`, Name als Funktion → folgt der Sprache), Einträgen des Systems (`native`) und Teilen nur für macOS / nur für die anderen (`when`). Daraus entstehen die native Menüleiste, die Menüleiste im Fenster und die Kontextmenüs | ein Eintrag hat keine eigene Logik: er führt die Aktion aus wie Kürzel und Palette |
| E2 | Nativ oder HTML? | **macOS: nativ** (Pflicht). **Windows und Linux: im Fenster gezeichnet** (`MenuBar`, APG-Menubar), wie in files-and-folders-tauri. `SC_NATIVE_MENU=1` schaltet zum Ausprobieren die native ein | eine native Leiste nimmt unter Windows/Linux `Alt`-Tasten, folgt keinem Farbschema und sieht unter GTK je nach Desktop anders aus; die gezeichnete ist dieselbe Komponente wie die Kontextmenüs |
| E3 | Wer baut die native Leiste? | Das Frontend schickt die ganze Leiste als `MenuSpec` (Namen in der Sprache des Fensters, Kürzel in der Notation der Keymap, aktiv, abgehakt); `app_menu.rs` prüft sie und baut das Menü. Ändert sich nur ein Zustand, werden einzelne Einträge umgeschaltet (`set_menu_state`), nicht neu gebaut; gebündelt über 150 ms | Zustände ändern sich bei jedem Tab-Wechsel |
| E4 | Prüfung in Rust | höchstens 600 Knoten, 3 Ebenen, Namen ≤ 120 Zeichen ohne Steuerzeichen; Ids haben die Form von Aktions-Ids (`A-Z`, Ziffern, `_`); Einträge des Systems nur aus fester Liste. **„Nur bekannte Ids“**: Rust kennt den Katalog nicht – zurückgemeldet werden nur Ids der gerade eingebauten Leiste, und das Fenster führt nur aus, was `isActionId` kennt | der Katalog lebt im Frontend; zwei Listen liefen auseinander |
| E5 | Kürzel im nativen Menü | nur ein Anschlag mit Mod/Ctrl oder eine F-Taste wird zum Beschleuniger; einfache Tasten, `Alt+Buchstabe` und Folgen (`Mod+K Mod+S`) bleiben beim Fenster und stehen nur als Text in der gezeichneten Leiste. Während ein Kürzel aufgezeichnet wird, hat das Menü keine Beschleuniger | sonst nähme das Menü Tasten aus Textfeldern |
| E6 | Taste und Menü melden denselben Druck | `ActionService.run(id, 'menu')` führt nicht aus, wenn dieselbe Aktion in den letzten 300 ms von der Tastatur kam (und umgekehrt) – gab es seit 002 | – |
| E7 | Dialoge | Ein `MutationObserver` auf `<dialog open>` setzt `dialogOpen`: alle Aktionen der nativen Leiste sind dann grau, die gezeichnete ist `inert`, ein Menüereignis wird verworfen. Kopieren/Einfügen des Systems bleiben | die Dialoge sind modale Elemente, es gibt keine Liste von ihnen |
| E8 | Umschalter | `ActionService.registerCheck(id, () => boolean)`; Menüs zeigen ✓ (`menuitemcheckbox`, nativ ein Check-Item). `canRun` und `isChecked` sind reaktiv | Auftrag |
| E9 | Kontextmenü | `shared/context-menu.ts` nach files-and-folders-tauri: APG-Menü mit Untermenüs, Häkchen, Kürzel, Buchstaben-Sprung; bleibt im Fenster. Geöffnet über `MenuService.openContext(defs, x, y, fokusZurück)` an Tab-Reitern, Ergebnis und Verbindungsliste – per Rechtsklick, `Shift+F10` und Menütaste. Das angeklickte Ding wird zuerst das aktive, damit die Aktionen es meinen | – |
| E10 | Schema-Baum | behält sein Menü je Knotenart (die Einträge hängen vom Knoten ab), gezeichnet mit derselben Komponente; die Aktionen stehen zusätzlich in Verbindung → Schema | schon seit 008 Aktionen |
| E11 | Editor | behält das Kontextmenü von **editlicious** (Ausschneiden, Kopieren, Einfügen, Suchen …), in der Sprache des Fensters (`ui-language`). Unsere Aktionen für den Editor stehen in der Menüleiste | ein zweites Menü über dem des Editors verdeckte dessen Funktionen |
| E12 | Struktur | App (nur macOS), Datei, Bearbeiten, Ansicht, Abfrage, Verbindung, Werkzeuge, Fenster (nur macOS), Hilfe. Ein Test verlangt, dass **jede Aktion des Katalogs** in der Leiste steht | Auftrag; nichts ist nur über die Palette erreichbar |
| E13 | Neue Aktionen | `RENAME_TAB`, `CLOSE_OTHER_TABS` (gab es nur im alten Tab-Menü), `QUIT_APP` (Windows/Linux; macOS nimmt den Eintrag des Systems) | jede Funktion ist eine Aktion |
| E14 | Sprache | Die Leiste wird mit jedem Sprachwechsel neu geschickt; auch die Wörter der System-Einträge kommen aus dem Katalog. `set_language` aus 017 entfällt | eine Stelle statt zwei |

## Geprüft

- Rust: `app_menu.rs` (Prüfung der Spec, Beschleuniger je OS, Zustandsänderungen, JSON-Form) – 7 Tests.
- Rein: `menu-model.spec.ts` (jede Aktion in der Leiste, nur bekannte Ids, Zustände, Striche, macOS/andere,
  native Spec, Struktur gegen Zustand, Grenzen des Backends).
- Komponenten: `context-menu.spec.ts` (Tastatur, Untermenü, Schließen), `menus.spec.ts` (Dienst mit Fake-Backend:
  einmal bauen, dann schalten; Echo von Taste und Menü; Dialog; Rückfall; Menüleiste per Tastatur),
  `tab-bar.spec.ts` (Menü per Maus, `Shift+F10`, Menütaste).
- Im Browser (`pnpm start`, ohne Backend): Die gezeichnete Menüleiste erscheint, „Ansicht“ zeigt Häkchen und
  Kürzel; Rechtsklick auf einen Tab öffnet das Menü, der erste Eintrag hat den Fokus, nicht ausführbare sind grau,
  `Esc` gibt den Fokus an den Tab zurück.
- **Dabei gefunden:** Ohne Backend warf das Abonnieren der Menüereignisse beim Start (`new Channel` braucht Tauri)
  und das Fenster blieb leer. Roter Test `menu-api.spec.ts`, dann behoben.

## Nicht umgesetzt, nicht geprüft

- **Die native Menüleiste ist auf keinem System gelaufen.** Der Code übersetzt (macOS), die Prüf- und
  Umsetzungsregeln sind getestet, der Aufbau selbst braucht ein laufendes Programm. Ungeprüft sind damit: ob
  `Cmd+C/V/X/A/Z` im Editor, in Feldern und im Gitter wirken (Akzeptanzkriterium), ob Taste und Beschleuniger
  wirklich beide ankommen, und das Umschalten der Sprache im Menü.
- Windows und Linux standen nicht zur Verfügung; die gezeichnete Leiste lief nur im Browser auf macOS.
- Im Browser auf macOS zeigt die gezeichnete Leiste ein Menü „Schema Commander“ mit nur einem Eintrag (die
  Einträge des Systems fehlen dort) – das betrifft nur `pnpm start`.
- Das Schnellmenü „Kopieren als“ (`COPY_AS`, zuletzt benutztes Format oben) gibt es weiter neben dem Untermenü.
- `MenuApi` hat eine Root-Vorgabe statt eines Eintrags in `app.config.ts` (jede Komponente mit Kontextmenü käme
  sonst in ihren Tests nicht ohne Provider aus); der Katalog der Aktionen liegt dadurch im ersten Bündel.
