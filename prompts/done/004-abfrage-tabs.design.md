# Design 004: Abfrage-Tabs

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/abfrage-tabs` · Auftrag: [004-abfrage-tabs.md](004-abfrage-tabs.md) · Feature C1

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Ein Editor je Tab oder einer für alle? | **Ein `<editlicious-editor>` je Tab**, alle bleiben in der Seite; der inaktive ist `display: none` und `inert` | Undo-Verlauf, Cursor, Auswahl und Scroll-Position bleiben ohne eigenen Code erhalten; die WebAssembly-Engine teilt sich ein Modul |
| E2 | Wann wird ein Tab gebaut? | erst, wenn er **zum ersten Mal vorn** ist (`mounted`) | 50 wiederhergestellte Tabs kosten beim Start nichts; ihr Text wird erst dann aus der Sicherung gelesen |
| E3 | Tab-Modell | `QueryTab` ist eine einfache Klasse mit Signals (kein Injectable), erzeugt vom Root-`TabsStore`, adressiert per Id. Die Ausführlogik der bisherigen `QuerySession` liegt jetzt im Tab | mehrere unabhängige Instanzen; Tabs entstehen zur Laufzeit |
| E4 | Laufende Sicherung | Der Editor meldet nur „geändert“ (`ed-change`: Revision, Größe). Eine Weile nach der letzten Änderung holt der Store den Text **einmal** (`getValue()`) und schreibt ihn in `tabs/<id>.sql` (atomar). Wartezeit 1,2 s, ab 5 Mio. Zeichen 8 s, ab 50 Mio. 30 s | nichts geht bei jedem Tastendruck über die Brücke; ein Absturz kostet höchstens die letzten Augenblicke |
| E5 | Zusätzliches Schreiben | beim Verstecken oder Schließen des Fensters (`visibilitychange`, `pagehide`) werden wartende Sicherungen sofort geschrieben | der Timer soll kein Tippen verlieren, das gerade erst geschah |
| E6 | Sitzung | `session.json` (Tabs in Reihenfolge, Titel, Verbindung, Datei, Kodierung, aktiver Tab) im Datenordner der App; nie ein Text, nie ein Ergebnis. Beim Laden werden Textdateien entfernt, die keinem Tab mehr gehören | getrennt von den Texten, klein, 400 ms nach jeder Änderung geschrieben |
| E7 | Schließen | **ohne Rückfrage**; die letzten 20 geschlossenen Tabs kommen mit `Mod+Shift+T` samt Text an ihre Stelle zurück (bis zum Beenden der App) | „nie eine Speichern?-Frage“ |
| E8 | Titel | automatisch aus dem Text: Tabelle der ersten Anweisung, sonst Anfang der ersten Zeile, sonst „Abfrage n“; ein selbst vergebener Name bleibt, ein leerer gibt den Titel an den Text zurück. Es werden nur die ersten 4 000 Zeichen angesehen | brauchbare Namen ohne Zutun, kein Lesen riesiger Skripte |
| E9 | Verbindung je Tab | jeder Tab hat seine Verbindung; neuer Tab erbt die des aktiven. Die in der Liste gewählte Verbindung geht **sofort** an den Tab vorn; ein Tab, der nach vorn kommt, zeigt seine als aktive | der Wettlauf „Tab-Wechsel und Verbindungswahl im selben Augenblick“ ist durch einen direkten Aufruf statt eines zweiten Effekts ausgeschlossen (Test) |
| E10 | Dateien | Lesen und Schreiben in Rust (`textfile.rs`): UTF-8 mit/ohne BOM, UTF-16 mit BOM, sonst Windows-1252; Zeilenenden sind Teil des Textes. Kann die alte Kodierung den Text nicht halten, wird **UTF-8** geschrieben und das gemeldet – nie mit Verlust | keine neue Abhängigkeit; alte Skripte bleiben, wie sie sind |
| E11 | „geändert“-Marke | nur für Tabs mit Datei (aus `dirty` des Editors, zurückgesetzt beim Speichern) | Tabs ohne Datei sind immer gesichert |
| E12 | macOS-Menü | eigenes Menü ohne „Fenster schließen“ (`menu.rs`) | Tauris Vorgabe-Menü belegt `Cmd+W`; hier schließt es einen Tab. Das volle Menü baut Prompt 018 |
| E13 | Tab-Leiste | APG „Tabs“ mit automatischer Aktivierung: Pfeile/Pos1/Ende wechseln, `Entf` schließt, `F2`/Doppelklick benennt um, Ziehen sortiert, Mitteltaste schließt, Kontextmenü (auch per Tastatur) | Tastatur zuerst |

Aktionen: `NEW_TAB` (`Mod+T`), `CLOSE_TAB` (`Mod+W`), `REOPEN_TAB` (`Mod+Shift+T`), `NEXT_TAB`/`PREV_TAB`
(`Ctrl+Tab`/`Ctrl+Shift+Tab`), `DUPLICATE_TAB`, `OPEN_FILE` (`Mod+O`), `SAVE_FILE` (`Mod+S`), `SAVE_FILE_AS`
(`Mod+Shift+S`).

## Verträge

Commands (alle `async`): `load_session`, `save_session(session)`, `load_tab_text(id)`, `save_tab_text(id, text)`,
`delete_tab_text(id)`, `read_text_file(path)`, `write_text_file(path, text, encoding)`. Tab-Ids sind zugleich
Dateinamen und deshalb nur `[a-z0-9-]` (Test: keine Id verlässt den Ordner). Neue Fehlercodes: `invalid_session`,
`encoding_failed`. TS: `SessionApi`, `TabsStore` (Root), `QueryTab`, `QueryPane`, `TabBar`.

## Abweichungen vom Auftrag

- **Tab ohne Verbindung** gibt es nicht: Jeder Tab hat eine (Vorgabe: die Demo). Verbunden wird ohnehin erst beim
  Ausführen.
- **Zwei Tabs auf derselben Verbindung teilen sich eine Sitzung** (Design 003 E4): Ihre Anweisungen laufen
  nacheinander, und `SET`/Transaktionen des einen wirken im anderen. Eine Sitzung je Tab kommt mit Prompt 013.
- **Ergebnisse bleiben je Tab im Speicher**, bis der Tab geschlossen wird oder die nächste Anweisung läuft (bis zu
  100 000 Zeilen je Tab). Prompt 006 ändert das.
- Dateien per **Drag & Drop**: umgesetzt über das Drop-Ereignis der WebView (nur in der Desktop-App).

## Tests

- Rust (58): `session.rs` (Reihenfolge, defekte Datei, ungültige Tabs, Texte, Ids verlassen den Ordner nicht,
  Aufräumen), `textfile.rs` (Erkennung, Rundreise jeder Kodierung mit CRLF, kein Schreiben mit Verlust).
- Frontend (205 gesamt): `tab-logic.spec.ts` (Titel aus SQL, auch 5 MB in < 200 ms), `tabs.store.spec.ts`
  (Wiederherstellen, Sicherung mit Wartezeit, Schließen/Zurückholen, Dateien, Kodierungs-Rückfall, Verbindung je
  Tab), `query-tab.spec.ts`, `tab-bar.spec.ts` (Rollen, Tastatur, Umbenennen, Menü).

## Ende-zu-Ende und was offen ist

- Im Browser mit nachgestelltem Backend angesehen: drei Tabs mit eigenem Editor, Titel aus dem Text, Sicherung
  geschrieben, Ausführen im Tab, Verbindung je Tab.
- **Nicht geprüft:** `kill -9` und Neustart der echten App (die Wiederherstellung ist durch die Store- und
  Rust-Tests belegt, nicht durch einen Durchlauf im Fenster); das **200-MB-Skript** (keine Messung von Tippen und
  Speicher); `Cmd+W` gegen das neue macOS-Menü im Fenster; Drag & Drop einer Datei; Windows und Linux; Rundreise
  der Zeilenenden durch den Editor (die Rust-Seite erhält sie, ob `getValue()` CRLF unverändert zurückgibt, ist
  nicht gemessen).
