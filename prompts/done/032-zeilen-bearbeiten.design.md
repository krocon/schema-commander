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
| E5 | Block einfügen | `Mod+V` im Gitter (das `paste`-Ereignis; im Menü liest das Backend die Zwischenablage): ab der Zelle des Cursors nach rechts über die **gezeigten** Spalten und nach unten über die Zeilen der Tabelle, danach in neue Zeilen (vorhandene neue zuerst, dann weitere). Parser rein: Tabs (Tabellenkalkulation, mit `"…"` für Zellen mit Umbruch); ohne Tab ist jede Zeile eine Zelle – ein Trenner wird nie geraten. Leere Zelle = `NULL`, in Textspalten leerer Text. Über 200 Zellen fragt ein Dialog mit Zeilen × Spalten, überschriebenen und neuen Zeilen. **Ungültige Werte** werden übernommen und markiert; geschrieben wird erst, wenn keiner mehr markiert ist | Aufgabe 4 |
| E6 | Füllen | `EDIT_FILL_DOWN` (`Mod+D`): je markierter Spalte der Wert der obersten Zelle in die Zellen darunter. „Auf NULL“/„Default“ wirken auf alle markierten Zellen. Kein Ziehen mit der Maus | Aufgabe 5 |
| E7 | **Reihenfolge** | Im Backend fest: **Löschen, Ändern, Einfügen**, in einer Transaktion. So kann eine neue Zeile den eindeutigen Wert einer gelöschten übernehmen. Eine Zeile, die geändert **und** gelöscht ist, wird gelöscht. Die Vorschau nennt die drei Anzahlen und zeigt die Anweisungen in dieser Reihenfolge | Aufgabe 6 |
| E8 | **Bündeln** | Aufeinanderfolgende neue Zeilen mit **denselben Spalten** teilen sich ein `INSERT … VALUES (…), (…)` – bis 200 Zeilen und 2000 Werte. Zellen im Default werden gar nicht genannt (SQLite kennt kein `DEFAULT` in `VALUES`); eine Zeile ganz ohne Werte ist `DEFAULT VALUES` bzw. `() VALUES ()`. Jede Anweisung muss so viele Zeilen ändern, wie sie abdeckt | Aufgabe 7; 5000 Zeilen = 25 Anweisungen |
| E9 | Fehler in einem Bündel | Vor einem geteilten `INSERT` steht ein Savepoint; nach einem Fehler laufen seine Zeilen von dort **einzeln in derselben Transaktion**, die danach zurückgerollt wird – geschrieben wird dabei nichts (nicht bei MySQL, siehe Review) | Akzeptanzkriterium 1 „die Zelle ist markiert“ (markiert ist die Zeile) |
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
- **Gegen echte Server**, nach dem Review: Savepoint, Zurück zum Savepoint und Weiterarbeiten nach einem
  gescheiterten `INSERT` in PostgreSQL und SQL Server. Ganze Treiber-Suite: 34 Tests grün.
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

## Review (zweiter Agent, nur lesend: Datenverlust, Reihenfolge, Transaktion)

Kein schwerer Befund: kein Weg, auf dem eine Anweisung mit falscher Zeilenzahl geschrieben bleibt oder der Puffer
in eine andere Tabelle geht; die Korrekturen aus dem Review zu 031 halten. Fünf mittlere Befunde, alle behoben
(roter Test zuerst):

| Befund | Behoben |
|---|---|
| **M1** Ohne Tab im Text wurde ein Trenner geraten: eine Spalte `1,5` oder `Smith, John` lief in die Nachbarspalte | Es wird nicht mehr geraten: ohne Tab ist jede Zeile eine Zelle. CSV wird hier nicht gelesen (das ist der Import, 033) |
| **M2** Eine Zelle, die nur mit `"` beginnt, verschluckte die Zellen dahinter | Ein Anführungszeichen umschließt nur, wenn das schließende am Ende der Zelle steht; sonst ist es ein Zeichen |
| **M3/M4** Die Suche nach der fehlerhaften Zeile eines Bündels lief in einer zweiten Transaktion: im falschen Zustand (ohne die Löschungen und Änderungen des Plans → falsche Zeile, falscher Fehler) und auf MySQL-Tabellen ohne Transaktionen mit doppelt geschriebenen Zeilen | Vor einem geteilten `INSERT` ein **Savepoint**; nach einem Fehler werden seine Zeilen von dort einzeln versucht – in derselben Transaktion, die danach wie nach jedem Fehler zurückgerollt wird. Nicht bei MySQL und nicht nach Abbruch oder Zeitlimit: dann nennt die Meldung „Neue Zeilen a–b (eine davon)“. Geprüft gegen PostgreSQL und SQL Server |
| **M5** Ungültige Werte in Zeilen, die zum Löschen vorgemerkt sind, sperrten das Schreiben, ohne markiert zu sein | Solche Zeilen zählen bei der Prüfung nicht, und ein eingefügter Block lässt sie aus |
| L1 Zeilen-Aktionen, die noch Zeilen lasen, schrieben während des Schreibens in den Puffer; die Erfolgsmeldung zählte aus dem Puffer | Der Puffer nimmt während des Schreibens an der einen zentralen Stelle nichts an; gezählt wird, was gesendet wurde |
| L2 Duplizieren nahm die Zeile, wie sie gelesen wurde, nicht wie sie gezeigt ist | mit den ungeschriebenen Änderungen |
| L3 Kein Nachfragen vor dem Schreiben von Löschungen | Vor jedem Schreiben mit Löschungen eine Rückfrage mit der Anzahl |
| L5 „von jemand anderem geändert“ auch, wenn ein `DELETE` oder `INSERT` nicht genau seine Zeile ergab | eigene Meldung (geändert, weg, oder von Trigger/Regel abgewiesen) |
| L8 Wert für eine neue Zeile, die inzwischen weg ist, ging still verloren | wird am Feld gemeldet |
| Tempo: Einfügen kopierte je Zelle die Liste der neuen Zeilen (20 000 Zeilen: 6 s) | neue Zeilen werden in einem Zug geschrieben; 20 000 × 3 Zellen unter 2 s (Test) |

**Bleibt, wie es ist – für Marc zu wissen:**

- Die **Reihenfolge innerhalb einer Art** ist die der Zeilen: Zwei Zeilen, die eindeutige Werte tauschen, oder
  Eltern- und Kindzeile derselben Tabelle in „falscher“ Reihenfolge werden abgelehnt (alles zurückgerollt), obwohl
  eine andere Reihenfolge ginge.
- Die **Sperre beim Löschen** über alle vergleichbaren Zellen kann fälschlich einen Konflikt melden, wo Text und
  Wert nie gleich sind (SQLite-Spalten ohne Typ, MySQL `bit`). Abhilfe: die Sperre ausschalten.
- Die **Prüfung vor dem Schreiben** lehnt einige Werte ab, die eine Datenbank nähme (`NaN` in PostgreSQL-`numeric`,
  `on`/`off` als Bool, Datum mit Zeit in einer SQLite-`DATE`-Spalte) – aus dem Gitter lassen sie sich nicht schreiben.
- Eine markierte **ganze Zeile** meint bei „NULL“/„Füllen“ alle gezeigten Spalten, wenn Spalten versteckt oder
  umsortiert sind, sonst nur die Spalte des Cursors.
- NULL aus dem Gitter kopiert und wieder eingefügt wird in Textspalten zum leeren Text.
- Duplizieren kopiert auch generierte Spalten, die nicht zum Schlüssel gehören; das `INSERT` wird dann abgelehnt,
  bis die Zelle auf „Default“ steht.

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
