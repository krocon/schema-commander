# Design 011: Export

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/export` · Auftrag: [011-export.md](011-export.md) · Feature F1

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Quellen | (a) das **angezeigte Ergebnis** aus dem Speicher (006), ganz oder die im Gitter markierten Zeilen, mit Spaltenauswahl; (b) dieselbe **Anweisung neu ausgeführt** (Häkchen im Dialog) – alle Zeilen, direkt vom Server; (c) eine **Tabelle aus dem Baum** (`SELECT * FROM …`, wie b) | Auftrag |
| E2 | Strom | (a) liest den Speicher blockweise (`each_row`); (b)/(c) hängen einen `FileSink` als `RowSink` an den Treiber: jede Zeile geht vom Server in den Extraktor in die Datei. Text wird ab 256 kB geschrieben | der Speicher wächst nicht mit dem Ergebnis; nichts geht über das Gitter oder die WebView |
| E3 | Formate | CSV, TSV, JSON, NDJSON, `INSERT`-Skript (Zeilen je Anweisung, Vorgabe 500), Markdown, HTML – die Extraktoren aus 009 (neu: NDJSON, gestapeltes `INSERT`, Zeilenende am Dateiende) – und Excel `.xlsx`. Optionen: Kopfzeile, Trenner, `NULL` als, CR LF, UTF-8-BOM, gzip | Auftrag |
| E4 | `.xlsx` | crate **`rust_xlsxwriter`** (reines Rust, MIT/Apache-2.0) im Modus `constant_memory`. Zahlen als Zahl, Bool als Bool, alles andere als Text – auch Zahlen, die als Text kommen (64-Bit, Dezimal): Excel behielte ihre Ziffern nicht. Grenzen von Excel: 1 048 576 Zeilen (der Rest fehlt, die Meldung sagt es; eine Anweisung wird dann auf dem Server beendet), 32 767 Zeichen je Zelle (gekürzt und gezählt) | einzige gepflegte crate, die zeilenweise schreibt |
| E5 | gzip | crate `flate2` (war schon im Abhängigkeitsbaum) | – |
| E6 | Schreiben | in `.<name>.part-<pid>` im Zielordner, am Ende `rename`; bei Fehler oder Abbruch räumt `Drop` die Teildatei weg. Eine vorhandene Zieldatei bleibt bis zum Umbenennen unberührt (Test) | nie eine halbe Datei am Ziel |
| E7 | Ziel | nur aus dem nativen Speichern-Dialog (`tauri-plugin-dialog` ist seit 004 da); er fragt vor dem Ersetzen. Der Command nimmt nur absolute Pfade | Review-Punkt des Auftrags |
| E8 | Job-Engine | klein: `Jobs` in Rust (Id, die das Frontend vergibt → Abbruch-Flag, bei Anweisungen auch die Verbindung für den Abbruch auf dem Server), Fortschritt über `Channel<u64>`, `cancel_job`. Im Frontend `ExportService`: ein Export zur Zeit, Statuszeile mit Fortschritt und „Abbrechen“, danach „Im Dateimanager zeigen“ | so viel, wie der Export braucht; Import (033) und Suche hängen sich später ein. Das Kopieren (009) hat seinen eigenen Abbruch behalten |
| E9 | „Im Dateimanager zeigen“ | Command `reveal_export`: `open -R` / `explorer /select,` / `xdg-open <Ordner>` – nur für Pfade, die die App in dieser Sitzung selbst geschrieben hat | kein `shell`- oder `opener`-Plugin, kein beliebiger Pfad |
| E10 | Mehrere Tabellen | **nicht**: eine Tabelle je Export | Ordner oder Archiv ist eine eigene Entscheidung; kommt mit Dump/Restore (047) |
| E11 | Dialog | Format, dessen Optionen, Spalten (alle/keine), Vorschau der ersten fünf Zeilen (`export_preview`, Excel als TSV), „Speichern unter …“; je Format bleiben die Einstellungen (`exportChoices`), das letzte Format steht vorn | Auftrag |

Aktionen: `EXPORT_RESULT` (`Mod+Shift+E`), `SCHEMA_EXPORT_TABLE` (Kontextmenü im Baum), `CANCEL_EXPORT`,
`REVEAL_EXPORT`.

## Nebenbei behoben

Eine Seite, die kürzer zurückkam, als das Ergebnis Zeilen meldet, wurde vom Gitter endlos neu angefragt (jede Antwort
löste ein Neuzeichnen aus, jedes Neuzeichnen eine Anfrage) – das Fenster hing. Gefunden mit einem nachgebildeten
Backend; `WindowAreaModel` merkt sich solche Seiten jetzt bis zum nächsten Wachsen (roter Test zuerst).

## Geprüft

- Rust: jedes Textformat als ganze Datei, Auswahl von Zeilen und Spalten, BOM + gzip (zurückgelesen), Abbruch und
  Fehler lassen nichts zurück und die alte Datei ganz, schreibgeschützter Ordner, fehlender Ordner, Excel-Datei mit
  gekürzter Zelle, `FileSink`.
- Frontend: Logik, Dienst (Fortschritt, einer zur Zeit, Abbruch, Fehlertext), Dialog als Komponententest.
- Im Browser mit nachgebildetem Backend: Dialog, Vorschau, Speichern-Dialog mit Namen und Filter, Fortschritt in der
  Statuszeile, „Im Dateimanager zeigen“.

## Nicht umgesetzt, nicht geprüft

- **Binärdaten** über 64 Bytes: Die Treiber behalten nur den Anfang (006); im Export steht dafür
  `NULL /* binary … */` bzw. der Anfang. Das Akzeptanzkriterium „Rundreise inklusive Binärdaten“ ist damit **nicht**
  erfüllt – es braucht ganze Binärwerte aus den Treibern (Prompt 026).
- `CREATE TABLE` vor dem `INSERT`-Skript; andere Kodierungen als UTF-8; mehrere Tabellen (E10).
- **10 Mio. Zeilen** und die Rundreise durch `psql`/`mysql` wurden nicht gemessen: die Test-Container liefen nicht
  mehr, `export_query` gegen einen echten Server ist ungeprüft (der `FileSink` selbst ist getestet).
- Volle Platte ist nur als Fehlertext vorgesehen, nicht provoziert. Die Excel-Datei wurde nicht in Excel geöffnet.
- `reveal_export` und der native Speichern-Dialog wurden nicht im echten Fenster ausgeführt.
- Bei meinen Browser-Prüfungen blieb das Vorschau-Fenster mehrfach hängen, wenn das Prüfskript die App direkt
  aufrief; über einen Timer gestartet lief derselbe Weg jedes Mal. Ich halte das für ein Verhalten des
  Prüfwerkzeugs, habe die Ursache aber nicht bewiesen.
