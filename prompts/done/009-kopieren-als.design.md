# Design 009: Kopieren als …

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/kopieren-als` · Auftrag: [009-kopieren-als.md](009-kopieren-als.md) · Feature D6

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Zwischenablage: WebView oder Rust? | **Rust** (`arboard`, ohne Bild-Feature, mit `wayland-data-control`), Commands `copy_result`, `cancel_copy`, `copy_text`. Eine `Clipboard`-Instanz lebt so lange wie die App | die Zeilen liegen in Rust (006) – eine Million Zeilen gehen nie durch die WebView; `text/html` neben `text/plain`; unter X11/Wayland lebt der Inhalt nur mit seinem Besitzer. Kein breites Plugin, drei schmale Commands |
| E2 | Wo werden die Formate geschrieben? | in Rust, rein: `extract.rs` (`Extractor`: `begin`, `row`, `end` auf einen String) – Prompt 011 schreibt damit Dateien | eine Wahrheit für Kopieren und Export |
| E3 | Formate | TSV (Vorgabe für `Mod+C`), CSV (Trenner, optional CR LF), JSON, Markdown, HTML (zusätzlich als TSV in `text/plain`), `INSERT`, `IN (…)` und „Werte“ der ersten Spalte, `WHERE` | Auftrag |
| E4 | Auswahl | aus dem `SelectionModel` des Gitters: die Zeilen aller Bereiche (zusammengeführt, jede einmal, in ihrer Reihenfolge) × die Spalten aller Bereiche. Berührt ein Bereich die Zeilennummer, sind ganze Zeilen gemeint. **Nichts markiert = das ganze Ergebnis** | ein Rechteck je Kopie; getrennte Bereiche als getrennte Blöcke kennt kein Zielformat |
| E5 | Volle Werte | kopiert wird aus dem Speicher, nicht aus dem Fenster: lange Texte ganz. **Binärdaten** nur, wenn sie ganz gespeichert sind (bis 64 Bytes, 006) – sonst `NULL /* binary, n bytes: not copied */` | lieber kein Wert als ein falscher |
| E6 | Grenzen | ab **1 Mio. Zellen** fragt das Fenster nach (`ConfirmService`, `shared/confirm.ts`); über **256 MB** Text bricht Rust mit `too_large` ab; „Abbrechen“ in der Statuszeile (`CANCEL_COPY`) | der Hinweis „stattdessen exportieren“ kommt mit Prompt 011 |
| E7 | Optionen | Einstellungen `copyHeader`, `copyNullAs` (leer, `NULL`, `\N`), `csvDelimiter`, `lastCopyFormat`; Aktion `TOGGLE_COPY_HEADER`. Eine Oberfläche dafür bringt Prompt 017 | – |
| E8 | Bedienung | `Mod+C` im Gitter über das `copy`-Ereignis des Browsers (kein eigener `keydown`; die Taste bleibt im Editor die des Editors); `Mod+Shift+C` und Rechtsklick öffnen „Kopieren als“ mit dem zuletzt benutzten Format oben; jede Variante ist eine Aktion der Palette; die Statuszeile meldet „n Zeilen kopiert (Format)“ | Auftrag |
| E9 | Tabelle für `INSERT` | aus der Anweisung, wenn sie genau eine Tabelle liest (`tableOf`), sonst der Platzhalter `tabelle` | – |
| E10 | Namen aus dem Schema-Baum | gehen jetzt auch über `copy_text` statt `navigator.clipboard` | ein Weg zur Zwischenablage |

## Literale je Dialekt (`INSERT`, `IN`, `WHERE`)

| Wert | PostgreSQL | MySQL / MariaDB | SQL Server | SQLite |
|---|---|---|---|---|
| NULL | `NULL` | `NULL` | `NULL` | `NULL` |
| Bool | `TRUE` / `FALSE` | `TRUE` / `FALSE` | `1` / `0` | `1` / `0` |
| Zahl (auch groß, dezimal) | Ziffer für Ziffer, ohne Anführungszeichen – nur wenn es streng eine Zahl ist | ebenso | ebenso | ebenso |
| Text, Datum, Zeit, JSON, UUID | `'…'`, `'` verdoppelt | zusätzlich `\` verdoppelt | `N'…'` bei Nicht-ASCII | `'…'` |
| Binär (ganz) | `'\xcafe'` | `X'cafe'` | `0xcafe` | `X'cafe'` |

Bezeichner quotet `meta::quote` (008).

## Geprüft

- Rust: Katalog je Format mit bösen Werten (Tab, Zeilenumbruch, Anführungszeichen, `NULL` gegen den Text `NULL`,
  Unicode, Trenner im Wert); Rundreise TSV/CSV durch einen Leser nach Tabellenkalkulations-Art; JSON wird
  zurückgelesen; Injektionsversuche gegen Literale; Kopier-Job über die Blöcke eines großen Ergebnisses, Abbruch.
- Frontend: Auswahl → Zeilen/Spalten, Dienst mit Fake (Optionen, Rückfrage, Fehlertexte).
- Im Browser mit nachgebildetem Backend: Bereich im Gitter → `copy`-Ereignis → richtige Auswahl; Menü; Rückfrage
  bei 9 Mio. Zellen; Statuszeile.

## Nicht umgesetzt, nicht geprüft

- **Die echte Zwischenablage wurde nicht beschrieben** (sie gehört dem Benutzer): `arboard` ist nur übersetzt, nicht
  ausgeführt – weder macOS noch Windows noch Linux/Wayland. Ob `Cmd+C` im nativen Fenster das `copy`-Ereignis im
  Gitter auslöst, ist offen.
- Die Ende-zu-Ende-Rundreise (Einfügen in Excel/LibreOffice, `INSERT` zurück in die Datenbank) und „1 Mio. Zeilen
  blockieren nicht“ wurden nicht am echten Fenster gemessen.
- Spaltenauswahl als eigene Option, Zeilenende von CSV als Einstellung, eine Oberfläche für die Optionen.
