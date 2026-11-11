# Design 021: Vervollständigung, die das Schema kennt

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/vervollstaendigung` · Auftrag: [021-vervollstaendigung.md](021-vervollstaendigung.md) · Feature C3

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Parser oder Tokenizer mit Regeln? | **Eigener Tokenizer + Regeln** (`sql-lex.ts`, `sql-context.ts`), wie pgcli. Der Tokenizer scheitert nie: ein offener String oder Kommentar endet am Textende | Ein SQL-Parser gibt genau bei den Texten auf, die eine Vervollständigung am häufigsten sieht – unfertigen. Die Regeln sind ein Katalog von Fällen, kein Grammatikbeweis |
| E2 | Frontend oder Rust? | **Kontext im Frontend** (rein, am Editor, ohne Brücke je Tastendruck), **Namen aus Rust** (Namensindex aus 020 und Katalog) | der Kontext braucht nur Text; die Namen liegen schon im Backend |
| E3 | Wie viel Text? | 400 Zeilen vor und 150 nach dem Cursor (`getSlice`), darin die Anweisung um den Cursor (`statementAt`) – nie das ganze Skript | 50-MB-Skript: die Kosten hängen nicht von seiner Länge ab |
| E4 | Was der Kontext liefert | erwartet: Anweisung / Tabelle / Join / Spalte / Spaltenliste eines INSERT / Typ / Routine / nur Schlüsselwörter / nichts; Qualifizierer vor dem Punkt; Tabellen und Aliase in Reichweite (auch hinter dem Cursor, aus äußeren Abfragen), abgeleitete Tabellen und CTEs mit den Spalten ihrer SELECT-Liste; Klausel; was die SELECT-Liste benennt | Aufgabe 1 |
| E5 | Vorschläge | rein (`suggest.ts`) aus Kontext + Momentaufnahme der Namen: Tabellen (aktuelles Schema zuerst und ohne Schema, andere qualifiziert), Spalten mit Typ (bei mehreren Tabellen mit Alias, wenn der Name mehrfach vorkommt), Aliase, CTE-Namen, Routinen und eingebaute Funktionen mit Signatur, Schlüsselwörter je Klausel und Dialekt, Typen je Dialekt | Aufgabe 2 |
| E6 | Kluge Einfügungen | `JOIN ▮` → `tabelle alias ON alias.pk = quelle.fk` aus Fremdschlüsseln in beide Richtungen (Alias aus den Wortanfängen, bereits verbundene Tabellen ausgenommen); `INSERT INTO t (▮` → zuerst die ganze Spaltenliste; `GROUP BY`/`ORDER BY` → zuerst, was die SELECT-Liste benennt; Aktion `EXPAND_STAR` (`Mod+K Mod+8`) schreibt `*` bzw. `o.*` als Spalten aus; alle Namen kommen gequotet aus dem Backend | Aufgabe 3 |
| E7 | Metadaten-Vorrat | Der **Namensindex** (020) hält alle Objektnamen in Rust (bis 1 Mio. Einträge); Tabellen und Routinen fragt die Vervollständigung dort mit dem begonnenen Wort ab (höchstens 200 Treffer, der Editor fragt bei jedem Zeichen neu: `incomplete`). **Spalten** und **Fremdschlüssel** werden je Tabelle bei Bedarf gelesen und 5 Minuten im Frontend gehalten; nach DDL verworfen | 50 000 Tabellen × Spalten liegen so nie im Fenster; gelesen wird, was eine Anweisung nennt |
| E8 | Nie blockieren | Der Anbieter ist asynchron; tippt man weiter, bricht der Editor ab (`signal`) und verwirft die Antwort. Eine fehlgeschlagene Quelle (nicht verbunden, keine Rechte) fehlt einfach in der Liste | E3 des Editors |
| E9 | Wann die Liste aufgeht | `Strg+Leertaste` immer; `.` immer; beim Tippen ab zwei Zeichen (Einstellung „Beim Tippen vorschlagen“, jetzt Vorgabe an); nach Leerzeichen, Komma, `(` **nur**, wo ein Tabellenname oder die Spaltenliste eines INSERT fällig ist | „ohne zu nerven“: nicht nach jedem Wort |
| E10 | Einstellungen | automatisch an/aus (`editorSuggest`), Schlüsselwörter groß/klein (`completionKeywordCase`) | eine **Verzögerung** bietet der Editor nicht an (siehe unten) |
| E11 | Ohne Verbindung | Schlüsselwörter, Funktionen und Typen des Dialekts; dazu die Wörter des Textes vom Editor selbst (`completion-sources="both"`) | Akzeptanzkriterium |
| E12 | Schema eines unqualifizierten Namens | das aktuelle Schema, sonst das erste, in dem es den Namen gibt (der Index weiß es); das aktuelle Schema kommt vom Baum oder wird einmal erfragt | – |

## Geprüft

- **Fallkatalog:** `sql-context.cases.json` (155 Fälle: „Text mit `▮` → erwartet, Qualifizierer, Tabellen, CTE-
  Spalten …“) und `suggest.cases.json` (73 Fälle: „Text mit `▮` → erste Vorschläge, Einfügetext“), je Dialekt
  gefiltert und für **jeden der vier Dialekte** gelaufen; ein Test verlangt mindestens 150 je Dialekt.
- `completion.service.spec.ts`: nur die Spalten der Tabelle des Alias; eine Tabelle wird einmal gelesen; Join aus
  dem Fremdschlüssel; ohne Verbindung und bei Fehlern nur Schlüsselwörter, kein Fehler; 5 000 Zeilen davor – gelesen
  werden genau die Zeilen 4601–5151; `*` aufklappen; Auslöser.
- **Im Browser im echten Editor** (nachgestelltes Backend): nach `JOIN ` geht die Liste auf, der Vorschlag aus dem
  Fremdschlüssel steht oben, Enter fügt `customer c ON c.id = o.customer_id` ein; `WHERE o.` zeigt nur die Spalten
  von `orders`.

## Nicht umgesetzt, nicht geprüft

- **Signaturhilfe** beim Tippen der Argumente und **Schnellinfo am Bezeichner**: die Schnittstelle des Editors (E3)
  hat dafür nichts. Die Signatur steht unter der Liste, solange der Eintrag aktiv ist. Folgepunkt für editlicious.
- **Verzögerung** als Einstellung: der Editor entscheidet selbst, wann er fragt.
- **Snippets** in der Liste kommen mit Prompt 024.
- „Zuletzt benutzt“ fließt nur über den Namensindex ein (Sprünge aus 020), nicht über angenommene Vorschläge.
- Die Regeln sind kein Parser: ungewöhnliche Texte (z. B. `MERGE`, `PIVOT`, Fensterdefinitionen, mehrere
  verschachtelte CTE-Ebenen mit gleichen Namen) fallen auf „Spalte“ oder „Schlüsselwort“ zurück.
- MySQL mit `ANSI_QUOTES` (dort wäre `"x"` ein Name) wird wie ohne gelesen.
- Gegen ein **echtes Schema** und mit **echter gefühlter Geschwindigkeit** wurde nicht geprüft (Ende-zu-Ende-Test
  des Auftrags): das Backend im Browser war nachgestellt, das native Fenster wurde nicht bedient. Ein 50-MB-Skript
  wurde nicht geladen – belegt ist, dass nur 551 Zeilen gelesen werden.
- Die Kürzel für Icons der Liste (`J`, `T`, `C` …) sind die Anfangsbuchstaben der Art; eigene Farben je Art fehlen.
