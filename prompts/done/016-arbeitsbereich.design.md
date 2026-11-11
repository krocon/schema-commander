# Design 016: Arbeitsbereich – geteilte Ansicht und Sitzung

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/arbeitsbereich` · Auftrag: [016-arbeitsbereich.md](016-arbeitsbereich.md) · Feature G2

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Layout-Modell | **fester Aufbau mit Optionen**: Seitenleiste, höchstens **zwei Tab-Gruppen** (nebeneinander oder übereinander), je Tab Editor und Ergebnis. Keine frei verschachtelbaren Teilungen | Zwei Abfragen vergleichen ist der Fall, den der Auftrag nennt. Ein Baum aus Teilungen braucht eigene Regeln für Fokus-Reihenfolge, Tastatur („welche Gruppe ist die andere?“) und Wiederherstellung – Aufwand L statt M, und bei 720 × 420 ist ein dritter Bereich nicht mehr bedienbar. Mit zwei Gruppen heißt jede Aktion eindeutig „die andere Gruppe“ |
| E2 | Wo lebt die Gruppe? | am Tab (`QueryTab.group`, 0 oder 1); die Reihenfolge bleibt die eine Liste der Tabs. Reine Regeln in `features/tabs/layout-logic.ts`: teilen, verschieben, schließen, aufheben, reparieren | kein zweites Modell neben der Tab-Liste, das auseinanderlaufen kann |
| E3 | Fokus | `activeId` bleibt „der Tab vorn“ = der Tab der fokussierten Gruppe; `otherId` ist der sichtbare Tab der anderen. Alles, was bisher auf dem aktiven Tab arbeitet (Ausführen, Verbindung, Statuszeile, Transaktion), folgt damit der Gruppe mit dem Fokus | keine Aktion musste umgeschrieben werden |
| E4 | Eine leere Gruppe | gibt es nicht: Verlässt der letzte Tab eine Gruppe (schließen, verschieben), endet die Teilung. Teilen mit nur einem Tab legt einen zweiten an | „geteilt“ ist abgeleitet (beide Gruppen haben Tabs), kein eigener Zustand, der falsch sein kann |
| E5 | Tabs wechseln die Gruppe, ohne neu gebaut zu werden | alle `QueryPane` sind Kinder **eines** CSS-Rasters; die Gruppe ist nur die Zelle. Die Tab-Leisten liegen im selben Raster | ein Editor, der im DOM umzieht, wird neu erzeugt: Undo-Verlauf, Cursor und der noch nicht gesicherte Text wären weg |
| E6 | Ergebnisbereich je Tab oder global? | **global** (Einstellungen `resultPlacement` unten/rechts, `resultVisible`, `resultWidth` neben `resultHeight`); „maximiert“ ist ein Zustand des Fensters und wird nicht gemerkt | wie die Höhe bisher; wer den Platz umstellt, meint seinen Bildschirm, nicht eine Abfrage. Eine Anweisung, die läuft, blendet einen ausgeblendeten Ergebnisbereich wieder ein |
| E7 | Seitenleiste | Ansichten als Tab-Liste (APG): **Datenbank** (Verbindungen + Schema) und **Verlauf** (die letzten 100 eigenen Anweisungen, Suche, Enter/Doppelklick fügt ein). Einstellung `sidebarView` | „gespeicherte Abfragen“ wird die dritte Ansicht, sobald es sie gibt (Prompt dazu steht aus) |
| E8 | Sitzung | `session.json` (Version bleibt 1, neue Felder mit Vorgabe): je Tab `group`, `caretLine`, `caretCh`; dazu `other` und `split`. Rust repariert Unbekanntes (`split` ≠ row/column → row, `other` ohne Tab → leer), das Frontend den Rest (`repair`) | alte Dateien bleiben lesbar |
| E9 | Scroll- und Cursorposition | Der Cursor wird gemerkt; nach dem Start setzt `goTo(Zeile, Spalte)` ihn, sobald der Editor seinen Text hat – das zeigt die Stelle. Eine eigene Scrollposition wird nicht gespeichert | editlicious bietet `goTo`, aber kein Lesen/Setzen der Scrollposition |
| E10 | Was wird beim Start verbunden? | **nichts** außer der Demo-Datenbank. Jeder Tab kennt seine Verbindung; verbunden wird beim ersten Ausführen oder auf Wunsch | ein Start darf keine Passwortabfragen, Tunnel oder Produktionsverbindungen auslösen |
| E11 | Mehrere Fenster | zunächst **ein** Fenster | Empfehlung des Auftrags; Sitzungen, Schlüsselbund-Rückfragen und Bestätigungen sind auf ein Fenster gebaut |
| E12 | Zen | `TOGGLE_ZEN` blendet Werkzeugleiste, Seitenleiste und Statuszeile aus (nicht gemerkt); eine Meldung nennt beim Einschalten das Kürzel zum Beenden; Seitenleisten-Aktionen beenden ihn. Echter Vollbildmodus ist Sache des Fensters (kommt mit dem Menü, 018) | nichts verschwindet unerreichbar |

## Aktionen und Kürzel (alle Systeme gleich)

| Aktion | Kürzel |
|---|---|
| `SPLIT_RIGHT` / `SPLIT_DOWN` | `Mod+K Mod+→` / `Mod+K Mod+↓` |
| `MOVE_TAB_TO_OTHER_GROUP` | `Mod+K Mod+M` (auch im Menü des Tabs und per Ziehen auf die andere Leiste) |
| `FOCUS_OTHER_GROUP` | `Mod+K Mod+O` |
| `UNSPLIT` | `Mod+K Mod+U` |
| `TOGGLE_RESULT` | `Mod+J` |
| `TOGGLE_RESULT_PLACEMENT` | `Mod+K Mod+J` |
| `MAXIMIZE_RESULT` | `Mod+Shift+M` |
| `SIDEBAR_DATABASE` / `SIDEBAR_HISTORY` | `Mod+K Mod+D` / `Mod+K Mod+H` |
| `TOGGLE_ZEN` | `Mod+K Mod+N` |

`F6`/`Shift+F6` (Baum → Editor → Ergebnis) gab es seit 002; die Runde lässt jetzt aus, was nicht zu sehen ist
(ausgeblendetes Ergebnis, maximiertes Ergebnis ohne Editor, Zen ohne Seitenleiste). `NEXT_TAB`/`PREV_TAB` laufen
in der Gruppe mit dem Fokus.

## Geprüft

- Rein: `layout-logic.spec.ts` (teilen, verschieben, schließen, aufheben, reparieren), `session.rs`
  (Gruppen, Cursor, Teilung, Reparatur).
- Store und Komponenten: `tabs.store.spec.ts` (Teilung, Fokus, zwei Verbindungen, Ziehen, Neustart, defekter
  Zustand), `tab-bar.spec.ts` (Leiste je Gruppe, Drop, Menü), `history-panel.spec.ts` (Tastatur, Suche),
  `query-tab.spec.ts` (Cursor über den Neustart).
- Im Browser (`pnpm start`, ohne Backend) bei **720 × 420**: geteilt nebeneinander und übereinander, Ergebnis
  rechts, Verlauf-Ansicht, Zen, maximiertes Ergebnis – nichts überlappt, keine Bildlaufleiste am Fenster, der
  Fokus liegt nach „maximieren“ im Ergebnis.

## Nicht umgesetzt, nicht geprüft

- Die beiden Gruppen sind **gleich groß**; ein Splitter zwischen ihnen fehlt.
- Ziehen eines Tabs teilt eine ungeteilte Ansicht nicht (dafür Aktion und Menü); Ziehen selbst (HTML-Drag-and-drop)
  lief nur im Komponententest, nicht mit der Maus.
- Keine eigene Scrollposition (E9); die Wiederherstellung des Cursors im echten Editor ist nicht beobachtet worden
  (im Browser gibt es ohne Backend keine Sitzung).
- „Gespeicherte Abfragen“ als Ansicht der Seitenleiste (E7).
- DOM-Reihenfolge im geteilten Zustand: beide Tab-Leisten stehen vor den Tabs (Folge von E5); die Tab-Taste erreicht
  also erst beide Leisten, dann die Inhalte.
- Das native Fenster wurde nicht bedient: „Layout nach Neustart identisch“ ist über Store-Test und Rust-Test
  belegt, nicht durch einen echten Neustart; zwei Abfragen auf verschiedenen echten Verbindungen nebeneinander
  liefen nur mit Fake.
