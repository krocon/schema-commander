# Design 032: Zeilen einfügen, duplizieren, löschen, Block einfügen

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/zeilen-bearbeiten` · Auftrag: [032-zeilen-bearbeiten.md](032-zeilen-bearbeiten.md) · Feature E2

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Puffer | Der Puffer aus 031 bekommt **neue Zeilen** (eine Id, die gegebenen Zellen – was fehlt, gibt die Datenbank: Default, Identity, `NULL`) und **zu löschende Zeilen** (Schlüssel + Zeile, wie sie gelesen wurde). **Undo/Redo sind Schnappschüsse** des Puffers statt einzelner Zell-Schritte: Einfügen, Duplizieren, Löschen, ein ganzer eingefügter Block und „Füllen“ sind je ein Schritt | Akzeptanzkriterium 3 |
| E2 | Neue Zeile | `EDIT_ADD_ROW` (`Mod+Umschalt+I`): unter den Zeilen der Tabelle, grün, jede Zelle zeigt `DEFAULT`, bis sie einen Wert hat; `+` statt Zeilennummer. Bearbeitet wie jede Zelle (`F2`). Pflichtspalten werden **nicht** eigens markiert: Was fehlt, sagt die Datenbank beim Schreiben, die Zeile ist dann markiert | siehe „Nicht umgesetzt“ |
| E3 | Duplizieren | `EDIT_DUPLICATE_ROW` (`Mod+Umschalt+D`): die markierten Zeilen (oder die des Cursors) als neue Zeilen, **ohne die Schlüsselspalten**. Binärdaten und Texte ab 1000 Zeichen (in der Zeile gekürzt) bleiben der Datenbank überlassen | Aufgabe 2 |
| E4 | Löschen | `EDIT_DELETE_ROW` (`Mod+⌫`): Zeilen werden rot und durchgestrichen **vorgemerkt** (noch einmal: Marke weg); neue Zeilen des Puffers verschwinden einfach. Geschrieben als `DELETE` über den Schlüssel – mit Sperre zusätzlich über **alle vergleichbaren Zellen** der Zeile, wie sie gelesen wurde – und „genau eine Zeile“. Der Fehler eines Fremdschlüssels erscheint mit dem Text der Datenbank (sie nennt die verweisende Tabelle), die Zeile ist markiert | Aufgabe 3 |
| E5 | Block einfügen | `Mod+V` im Gitter (das `paste`-Ereignis; im Menü liest das Backend die Zwischenablage): ab der Zelle des Cursors nach rechts über die **gezeigten** Spalten und nach unten über die Zeilen der Tabelle, danach in neue Zeilen (vorhandene neue zuerst, dann weitere). Parser rein: Tabs (Tabellenkalkulation, mit `"…"` für Zellen mit Umbruch), sonst CSV mit `,` oder `;`. Leere Zelle = `NULL`, in Textspalten leerer Text. Über 200 Zellen fragt ein Dialog mit Zeilen × Spalten, überschriebenen und neuen Zeilen. **Ungültige Werte** werden übernommen und markiert; geschrieben wird erst, wenn keiner mehr markiert ist | Aufgabe 4 |
| E6 | Füllen | `EDIT_FILL_DOWN` (`Mod+D`): je markierter Spalte der Wert der obersten Zelle in die Zellen darunter. „Auf NULL“/„Default“ wirken auf alle markierten Zellen. Kein Ziehen mit der Maus | Aufgabe 5 |
| E7 | **Reihenfolge** | Im Backend fest: **Löschen, Ändern, Einfügen**, in einer Transaktion. So kann eine neue Zeile den eindeutigen Wert einer gelöschten übernehmen. Eine Zeile, die geändert **und** gelöscht ist, wird gelöscht. Die Vorschau nennt die drei Anzahlen und zeigt die Anweisungen in dieser Reihenfolge | Aufgabe 6 |
| E8 | **Bündeln** | Aufeinanderfolgende neue Zeilen mit **denselben Spalten** teilen sich ein `INSERT … VALUES (…), (…)` – bis 200 Zeilen und 2000 Werte. Zellen im Default werden gar nicht genannt (SQLite kennt kein `DEFAULT` in `VALUES`); eine Zeile ganz ohne Werte ist `DEFAULT VALUES` bzw. `() VALUES ()`. Jede Anweisung muss so viele Zeilen ändern, wie sie abdeckt | Aufgabe 7; 5000 Zeilen = 25 Anweisungen |
| E9 | Fehler in einem Bündel | Die Transaktion ist dann zurückgerollt. Um die Zeile zu nennen, laufen die Zeilen dieses Bündels **einzeln in einer zweiten Transaktion, die immer zurückgerollt wird** – geschrieben wird dabei nichts | Akzeptanzkriterium 1 „die Zelle ist markiert“ (markiert ist die Zeile) |
| E10 | Vergebene Schlüssel | PostgreSQL und SQLite: `RETURNING` der ersten Schlüsselspalte, die Statuszeile nennt die Schlüssel („Neue Schlüssel: 6, 7“). Danach wird die Tabelle ohnehin neu gelesen und zeigt die Zeilen mit ihrer Id, soweit Filter und Grenze sie zeigen | Akzeptanzkriterium 2 |
| E11 | Grenzen | 20 000 Zeilen je Schreiben (gelöscht + geändert + neu), 20 000 Zeilen je eingefügtem Block | |

## Verträge

`UpdatePlan` zusätzlich `deletes`, `inserts`, `returning`; `edit_preview → Step[]` (`kind`, `first`, `rows`,
`returns` neben `sql/params/display`); `Applied` zusätzlich `failedKind`, `inserted`; `read_clipboard_text`.

## Geprüft

- **Rust, Erzeuger** (9 Tests): Reihenfolge der Schritte; `DELETE` mit Sperre; `INSERT` mit `NULL`, ohne
  Default-Zellen, ohne alles; Bündel nach Spaltenliste und an den Grenzen (1000 Zeilen → 5 Anweisungen);
  Einzelanweisungen eines Bündels; `RETURNING` nur, wo es das gibt; böse Werte in neuen und gelöschten Zeilen.
- **Rust, Schreiben** (SQLite über den Manager): löschen + ändern + einfügen in einem Zug, wobei die neue Zeile den
  eindeutigen Namen der gelöschten übernimmt; vergebene Schlüssel zurück; 450 neue Zeilen, Zeile 318 verletzt
  `NOT NULL` → **nichts** geschrieben, Zeile 318 benannt; Löschen einer Zeile, die es nicht mehr gibt → Konflikt,
  auch das Einfügen daneben nicht; **5000 neue Zeilen in unter 5 s** (Debug-Build).
- **Gegen echte Server** (PostgreSQL, MySQL, MariaDB, SQL Server; `every_server_inserts_and_deletes_rows`):
  geteiltes `INSERT` meldet alle Zeilen, Zeile aus lauter Defaults, `RETURNING` in PostgreSQL, Identity-Spalten;
  Löschen genau einer Zeile, einer fehlenden (0), mit nicht passender Sperre (0), und einer Zeile, auf die ein
  Fremdschlüssel zeigt (Fehler, Zeile bleibt).
- **Fenster**: Puffer (16 Tests, darunter Zeilen, Block, ungültige Zellen, Plan mit allen drei Arten); Parser
  (4 Tests: Tabs, Anführungszeichen, CSV, Grenze); Dienst (4 neue Tests: Zeile anlegen/füllen/duplizieren/löschen,
  Block einfügen mit Rückfrage und ungültigem Wert, Füllen und NULL für die Auswahl, ein Plan für alles und
  Zuordnung eines Fehlers zur Zeile).
- **Im Browser** mit nachgebildetem Backend: Zeile vormerken (`Mod+⌫`, rot durchgestrichen), neue Zeile
  (`Mod+Umschalt+I`, grün, `DEFAULT`), Zelle der neuen Zeile per `F2`; Block mit vier Zeilen ab Zeile 4 eingefügt
  → zwei vorhandene Zeilen überschrieben, vorhandene neue Zeile fortgesetzt, eine weitere angelegt, Zelle mit
  Zeilenumbruch als eine Zelle; geschrieben → Plan `1 gelöscht, 2 geändert, 2 eingefügt`, neue Schlüssel
  gemeldet, Tabelle neu gelesen.
- **Review durch einen zweiten Agenten**: siehe unten.
- `pnpm check` grün.

## Nicht umgesetzt, nicht geprüft

- **Pflichtspalten** einer neuen Zeile sind nicht markiert; **welche Spalte** eines gescheiterten `INSERT`
  schuld ist, sagt nur der Text der Datenbank – markiert ist die Zeile, nicht die Zelle.
- **Vergebene Schlüssel** meldet die Statuszeile nur in PostgreSQL und SQLite; in MySQL und SQL Server zeigt sie
  die neu gelesene Tabelle.
- **Füllen durch Ziehen** mit der Maus und „gleicher Wert in alle markierten Zellen“ über ein Feld gibt es
  nicht (nur NULL, Default und Füllen nach unten).
- Neue Zeilen stehen immer am Ende, nicht „unter der aktuellen“.
- Eine **Vorschau des eingefügten Blocks** Zelle für Zelle gibt es nicht – die Rückfrage nennt Umfang und Folgen,
  das Ergebnis steht farbig im Gitter und lässt sich mit einem Undo zurücknehmen.
- 5000 Zeilen aus einer echten Tabellenkalkulation im echten Fenster gegen eine echte Datenbank: nicht
  durchgespielt (Parser, Puffer, Bündel und die 5000 Zeilen in SQLite sind einzeln geprüft). Das native Fenster
  wurde wie bisher nicht bedient; ob `Cmd+V` dort als `paste`-Ereignis im Gitter ankommt, ist ungeprüft – der
  Menüpunkt „Zellen aus der Zwischenablage einfügen“ geht in jedem Fall.
