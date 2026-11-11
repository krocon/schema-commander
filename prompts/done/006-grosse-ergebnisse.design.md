# Design 006: Große Ergebnisse

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/grosse-ergebnisse` · Auftrag: [006-grosse-ergebnisse.md](006-grosse-ergebnisse.md) · Feature D1

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Format des Speichers | **eigene Zeilen + Offsets** (`results.rs`): jede Zeile ist das JSON-Array ihrer Zellen, dahinter ein Index mit dem Anfang jeder Zeile. Kein SQLite, kein Arrow | ein Fenster ist das Aneinanderhängen fertiger Zeilen – kein Umkodieren beim Lesen; die Kodierung der Zellen (`value.rs`) bleibt die eine Wahrheit; keine neue Abhängigkeit |
| E2 | Speicher oder Platte | bis **32 MB** im Speicher, darüber wandert das Ergebnis in eine Datei im Cache-Ordner der App (`results/`) und wächst dort weiter | kleine Ergebnisse berühren die Platte nie |
| E3 | Grenzen | je Ergebnis höchstens **4 GiB** und **50 Mio. Zeilen** (Konstanten); wird eine erreicht, endet das Lesen mit „abgeschnitten“ und die Anweisung wird auf dem Server beendet | eine volle Platte ist schlimmer als ein gekürztes Ergebnis. Als Einstellung erst mit Prompt 017 |
| E4 | Verbindung besetzt halten? | **nein: immer zu Ende lesen**, kein Server-Cursor. Die Treiber schreiben beim Lesen über einen `RowSink` in den Speicher | eine Sitzung je Profil; ein offener Cursor würde jede weitere Anweisung blockieren und Transaktionen offen halten. „Erst bei Bedarf weiterlesen“ entfällt damit |
| E5 | Ereignisse | `run_query` bekommt einen `Channel<RunEvent>`: `started` (Ergebnis-Id, Spalten) und `rows` (Zahl, höchstens alle 100 ms). Der Command endet erst mit der Anweisung und liefert das `RunOutcome` | das Gitter zeigt die ersten Zeilen, während Rust weiterliest; der Abbruch bleibt der von 005 |
| E6 | Fenster | `result_window(resultId, from, count)` liefert das JSON als fertige Antwort (`tauri::ipc::Response`), höchstens 5000 Zeilen; Texte sind im Fenster auf **1000 Zeichen** gekürzt, der Speicher hält sie ganz | der volle Wert kommt mit Prompt 026 |
| E7 | Gitter | `WindowAreaModel`: Seiten zu 200 Zeilen, höchstens 60 Seiten im Speicher (älteste fällt heraus), Platzhalter „…“ bis die Seite da ist, Zeilennummer als feste erste Spalte. Antworten für ein anderes Ergebnis werden verworfen | der Speicher der WebView wächst nicht mit der Zeilenzahl |
| E8 | Abschneiden und die Sitzung | nach dem Abschneiden wird wie beim Abbruch auf dem Server beendet; danach räumt `settle()` die Verbindung auf (`SELECT 1`, bis zu fünfmal), sonst wird sie verworfen. SQL Server verliert die Verbindung | sonst trifft das verspätete „abgebrochen“ des Servers die nächste Anweisung |
| E9 | Aufräumen | `free_results` bei neuem Lauf und beim Schließen des Tabs; beim Start werden Dateien entfernt, die ein früherer Prozess hinterließ; je Lauf bleiben höchstens **50** Ergebnisse | Plattenplatz ist nach dem Schließen wieder frei |
| E10 | Sortieren | **entfällt vorerst**: das Gitter sortiert nicht mehr lokal. Sortieren und Filtern kommen mit Prompt 027 (an den Server oder über den Speicher) | lokal sortieren hieße, alle Zeilen in die WebView zu holen |
| E11 | Wartende Anweisung | unverändert zu 005: ein neuer Lauf im selben Tab ersetzt den alten; ein Lauf in einem anderen Tab derselben Sitzung wartet und zeigt „Läuft …“ | – |

Statuszeile: während des Lesens „Läuft … · 755 000 Zeilen gelesen“, danach „2 000 000 Zeilen · 1,23 s“ (schmale
Leerzeichen als Tausendertrennung).

## Messwerte

- PostgreSQL im Container, **Debug-Build**, 3 Mio. Zeilen: erste Zeilen nach 0,13 s, alles nach 45,7 s
  (`millions_of_rows_stream_into_the_store`). Ein Release-Build wurde nicht gemessen.
- Browser mit nachgebildetem Backend, 2 Mio. Zeilen: Sprung ans Ende lädt genau ein Fenster (1 999 800–2 000 000)
  und zeigt die richtigen Zeilen; Heap der Seite 25 MB.

## Nicht umgesetzt, nicht geprüft

- Das Akzeptanzkriterium **10 Mio. Zeilen × 20 Spalten** wurde nicht gemessen (nur 3 Mio. schmale Zeilen, Debug).
- Einstellung für die Grenzen (E3) und „erst bei Bedarf weiterlesen“ (E4) gibt es nicht.
- Schnelles Ziehen am Scrollbalken fordert jede überstrichene Seite an; ein Verzögern der Anfragen fehlt.
- Volle Platte beim Schreiben ist nur als Fehlerpfad programmiert, nicht getestet.
- Das native Fenster wurde nicht von Hand geprüft – das Gitter nur im Browser mit nachgebildetem Backend.
