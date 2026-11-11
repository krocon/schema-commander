# Design 029: Spalten verwalten und im Ergebnis suchen

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/spalten-suche` · Auftrag: [029-spalten-suche.md](029-spalten-suche.md) · Feature D8

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Wem gehört das Spalten-Layout? | **Uns**, als reines Modell (`column-layout.ts`): Reihenfolge, versteckt, fixiert, Breiten – nach **Schlüssel** der Spalte (ihr Name; ein wiederholter Name zählt mit: `id`, `id#2`). Nicht der Zustand der Tabelle (`getState/applyState`): der kennt nur Indizes und überlebt keine geänderte Spaltenliste | Aufgabe 2 „sinnvoll zusammenführen“ |
| E2 | Wie wird es angewandt? | Ein neues Layout baut das **Tabellenmodell neu** (`fixedLeftColumnCount` gehört zum Modell), der Seiten-Cache der Zeilen bleibt, die erste sichtbare Zeile wird wieder angefahren. Das Gitter rechnet Gitterspalte ↔ Ergebnisspalte um (`WindowAreaModel.resultColumn`); nach außen – Kopieren, Kennzahlen, Wert-Ansicht, Sortieren, Treffer – gehen immer Spalten des Ergebnisses | eine Stelle, die umrechnet |
| E3 | Ziehen und Breiten | Spalten sind in der Tabelle wieder ziehbar; `columnMoveEnd` liefert die neue Reihenfolge (die `property` nennt die Ergebnisspalte), daraus entsteht das Layout und die Tabelle neu. `columnResizeEnd` (auch Doppelklick) merkt die Breite, ohne neu zu bauen. Tastatur: `Alt+Umschalt+←/→` verschiebt die Spalte des Cursors; fixierte bewegen sich unter den fixierten | Aufgabe 1 |
| E4 | Zusammenführen | Unbekannte Spalten stehen hinter ihrer Nachbarin im Ergebnis, verschwundene werden übergangen (und sind wieder da, wenn die Spalte zurückkommt). Mindestens eine Spalte bleibt sichtbar, mindestens eine scrollt | Aufgabe 2 |
| E5 | Merken | **Tabellen-Ansicht**: je Tabelle (`connection|schema.tabelle`, die letzten 200) in den Einstellungen `columnLayouts` – nicht im Export der Einstellungen (wie die Filter). **Abfrage-Tab**: am Tab, solange er lebt; über einen Neustart nicht | ein Abfrage-Tab hat nach dem Neustart kein Ergebnis |
| E6 | Spaltenliste | `RESULT_COLUMNS` (`Mod+K Mod+C`): modaler Dialog mit Filterfeld (Fokus dort), je Spalte Name (Klick springt), „sichtbar“, „fixiert“, vor/zurück (`Alt+↑/↓`). **`Enter` im Filter springt zur ersten passenden Spalte** – Kürzel, ein paar Buchstaben, `Enter`. Eine versteckte Spalte wird dabei gezeigt. Dazu „Alle zeigen“, „Alle Breiten anpassen“, „Zurücksetzen“ | Akzeptanzkriterium 1 |
| E7 | Kopieren bei umsortierten Spalten | in der **gezeigten** Reihenfolge, versteckte Spalten nicht: `pick_columns` (Rust) hält jetzt die genannte Reihenfolge, statt zu sortieren (zwei Tests angepasst – sie hatten das Sortieren festgehalten) | man kopiert, was man sieht |
| E8 | Suche: wo? | **In Rust** über den Ergebnisspeicher (`search.rs`). Das Fenster fragt **stückweise** (`result_search(from, max_rows, max_hits)`): erst 5 000 Zeilen, dann je 100 000 – die ersten Treffer stehen sofort da, gezählt wird weiter, eine neue Suche oder Schließen bricht ab (`cancel_job`, Ids ab 4 000 000 000). Die Orte von bis zu 100 000 Treffern hält das Fenster (markieren, springen); darüber wird nur gezählt, und die Zeile sagt es | Akzeptanzkriterium 2 |
| E9 | Muster | Jede Suche ist ein Muster der `regex`-Crate: Laufzeit linear im Text (kein Backtracking – `^(a+)+$` endet sofort), Programmgröße begrenzt (4 MB), Muster höchstens 2 000 Zeichen. Schlichter Text wird maskiert, „ganzes Wort“ ist `\b(?:…)\b` (Unicode). Dafür keine Rückbezüge und kein Lookaround. **Neue direkte Abhängigkeit `regex`** (war schon im Baum) | Aufgabe 3 „Regex-Grenzen“ |
| E10 | Was wird durchsucht? | Texte, Zahlen und Wahrheitswerte, wie sie geschrieben sind; NULL und Binärdaten nicht. Ohne Groß/Klein, wenn nicht verlangt. Optional nur eine Spalte | |
| E11 | Ungültiges Muster | `invalid_query` mit der einen Zeile, die den Fehler nennt → Hinweis **am Feld** (`aria-invalid`, `aria-describedby`), kein Dialog | Akzeptanzkriterium 3 |
| E12 | `Mod+F` im Ergebnis | neuer **Aktionsbereich `result`**: Solche Aktionen wirken nur, solange ein Ergebnisgitter die Tastatur hat, und nur mit Modifikator oder F-Taste. So bleiben `Mod+F`, `F3`, `Umschalt+F3` im Editor dessen Suche und in Feldern die des Feldes. `Mod+G` (Gehe zu Zeile), `Alt+↓` (nächster anderer Wert), `Alt+Umschalt+↓` (nächstes NULL) ebenso | Architekturregel „keine eigenen keydown-Handler für Funktionen“ |
| E13 | Suchzeile | über dem Ergebnis: Feld, drei Schalter (`aria-pressed`), Spalte, Trefferzahl („3 von 71“, während des Zählens „bisher 71 Treffer …“), voriger/nächster; daneben „Zeile“ für Gehe zu Zeile. `Enter` nächster, `Umschalt+Enter` voriger Treffer, `Esc` schließt und gibt dem Gitter die Tastatur zurück. Treffer vom Cursor aus, um die Enden herum; Farben `--hit-*` | Aufgabe 3 |
| E14 | Springen | „nächster anderer Wert“ und „nächstes NULL“ sucht Rust (`result_seek`) abwärts ab der Zelle des Cursors; erste/letzte Zeile als Aktionen ohne Vorgabe-Kürzel (die Tabelle hat ihre eigenen Tasten) | Aufgabe 4 |

## Nebenbei behoben

**Das Gitter baute sich bei jeder Einstellungsänderung neu** (Wert-Feld umschalten, Seitenleiste ziehen …): Der
Effekt las das ganze Einstellungs-Signal statt nur der Zeilenhöhe – Cursor, Auswahl und Scroll-Position waren
weg. Aufgefallen, weil „Gehe zu Zeile“ die Suchzeile über eine Einstellung einblendete. Roter Test zuerst
(`result-grid.spec.ts`, neu), dann behoben (`rowHeight` als eigenes `computed`).

## Geprüft

- **Rust** (5 Tests): Text ohne/mit Groß-Klein, Zahlen, NULL, was JSON maskiert, Emoji, Punkt als Punkt; ganzes
  Wort (auch mit Umlaut), Muster, Spalten; kaputtes Muster (eine Zeile, die sagt, was fehlt), Rückbezug, zu lang,
  zu groß, `^(a+)+$` gegen 5 000 Zeichen; stückweise mit Grenzen und Abbruch; nächster anderer Wert / NULL.
- **Fenster**: Layout rein (11 Tests: Schlüssel, verstecken, fixieren, verschieben über Verstecktes, Ziehen,
  geänderte Spaltenliste, Breiten, gespeicherte Form, merken); Suche je Tab (finden, markieren, Sprung um die
  Enden, Stücke, überholte Suche, Fehler am Feld); Tastatur-Bereich `result` (im Gitter ja; im Editor, im Feld,
  in anderen Gittern nein); Gitter bleibt bei fremden Einstellungen stehen.
- **Im Browser** mit nachgebildetem Backend, **500 Spalten × 20 000 Zeilen**: `Cmd+F` im Gitter → Feld, 71 Treffer
  nach zwei Stücken, `Enter` springt (Zelle im Blick, „2 von 71“), `Esc` zurück ins Gitter; `Alt+↓` und
  `Alt+Umschalt+↓`; `Cmd+G` → Zeile 15 000; Spaltenliste: `col_250` tippen, `Enter` → Cursor in der Spalte;
  fixieren (steht links), `Alt+Umschalt+←`, ausblenden, Ziehen am Kopf (Köpfe und Daten stimmen danach, Layout
  gemerkt); Auswahl über umsortierte Spalten geht in gezeigter Reihenfolge ans Kopieren; kaputtes Muster → Hinweis
  am Feld, kein Dialog.
- **Gemessen** (Debug-Build, `big_result_is_searched_in_a_time_one_can_wait`, ignoriert): das erste Stück
  (5 000 Zeilen) 15 ms, 1 Mio. Zeilen × 3 Spalten 2,8 s.
- `pnpm check` grün.

## Nicht umgesetzt, nicht geprüft

- **10 Mio. Zeilen** wurden nicht gemessen (hochgerechnet aus der Messung oben: im Debug-Build knapp 30 s
  Zählen im Hintergrund, die ersten Treffer sofort); kein Release-Build gemessen. Das native Fenster
  (`pnpm tauri dev`) wurde wie bisher nicht bedient; „flüssig“ beim waagerechten Scrollen ist im Browser
  gesehen, nicht gemessen.
- Gesucht wird in dem, was in der Zeile steht: von sehr langen Texten der Anfang (der ganze Wert liegt seit 026
  getrennt). Treffer **in** der Zelle werden nicht hervorgehoben, die Zelle als ganze.
- „Nur in Spalte(n)“: eine Spalte oder alle – keine Mehrfachauswahl. Gesucht wird auch in versteckten Spalten;
  der Sprung auf einen Treffer dort bleibt in der Spalte des Cursors.
- Rückwärts gibt es „voriger Treffer“, aber kein „voriger anderer Wert“ / „voriges NULL“.
- Fixieren nur links. Der Export in eine Datei schreibt weiter alle Spalten in der Reihenfolge des Ergebnisses.
- Ein neues Layout baut die Tabelle neu: die waagerechte Scroll-Position und die Auswahl gehen dabei verloren
  (die Zeile und – bei den Aktionen – der Cursor bleiben). Vorschlag fürs Mono-Repo der Tabelle:
  `fixedLeftColumnCount` zur Laufzeit ändern und ein `setFocus`/`scrollToCell` in der `TableApi`.
- Das Layout eines Abfrage-Tabs überlebt keinen Neustart.
- Die Listen der Objekt-Details (Zeilen im Fenster) haben weder Layout noch diese Suche.
