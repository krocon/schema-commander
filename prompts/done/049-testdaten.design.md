# Design 049: Testdaten erzeugen

> **Status:** umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/testdaten` · Auftrag: [049-testdaten.md](049-testdaten.md) · Feature H4

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Zufall | ein eigener kleiner Generator (SplitMix64) in `testdata.rs`, keine Abhängigkeit. **Jede Zelle hat ihren eigenen Strom**, bestimmt von (Startwert, Spalte, Zeile): Eine Zeile ist, was sie ist, was auch davor kam – gleiche Zeilen bei gleichem Startwert, auf jedem Rechner, und kein Speicher, der mit den Zeilen wächst | Akzeptanzkriterien 1, 2 |
| E2 | Eindeutig | nie durch Merken, nie durch Würfeln und Prüfen. Zahlen, Dezimalzahlen, Datum, Zeitpunkt: ein **Gang durch den Bereich**, der jede Stelle einmal trifft (`Zeile ↦ (a·Zeile + b) mod Größe`, `a` teilerfremd). Texte: die Nummer der Zeile am Ende (innerhalb der Länge der Spalte); E-Mail: die Nummer vor dem `@`. Reicht der Bereich nicht für die Zeilen, sagt es der Plan, bevor eine Zeile entsteht | Aufgabe 1, Akzeptanzkriterium 1 |
| E3 | Generatoren | Folge, ganze Zahl (gleichmäßig oder um die Mitte), Dezimal, Bool, Datum, Zeitpunkt (mit „nie vor Spalte …“), Uhrzeit, UUID, Text, **Muster** (ein kleiner Teil regulärer Ausdrücke: Literale, `\d \w \s`, Klassen, Gruppen mit `|`, `{n}`, `{n,m}`, `? * +`), gewichtete Auswahl, Vor-/Nach-/voller Name, E-Mail, Telefon, Straße, Ort, PLZ, Land, Firma, Lorem, JSON nach Vorlage, Fremdschlüssel, fester Wert, „der Datenbank überlassen“; je Spalte NULL-Anteil und „eindeutig“ | Aufgabe 1 |
| E4 | Plausibel | Eine Zeile hat **eine Person**: Vorname, Nachname, voller Name und E-Mail kommen aus derselben Ziehung, die E-Mail aus den Namen (Umlaute als `ae`, `oe`, `ue`, `ss`). „Nie vor“ zieht einen Zeitpunkt zwischen dem der anderen Spalte und dem Ende des Bereichs | Akzeptanzkriterium 3 |
| E5 | Vorschlag | `suggest`: aus Typ, Länge, Stellen, Schlüssel, Vorgabewert, `enum(…)` und Spaltenname (deutsch und englisch). Eine Spalte, die die Datenbank füllt (Sequenz, Identity), bleibt ihr überlassen; ein einzelner Primärschlüssel und die einzige Spalte eines eindeutigen Index sind „eindeutig“. Alles ist im Dialog änderbar | Aufgabe 2 |
| E6 | Fremdschlüssel | Werte der Spalte, auf die der Schlüssel zeigt, gelesen in fester Ordnung (höchstens 200 000 – eine Grenze, wie groß die Tabelle auch ist). Zufällig daraus, oder **Zeilen je Elternzeile** (von … bis): Dann folgt die Zeilenzahl aus den Eltern, die Kinder kommen in deren Reihenfolge. Welche Spalte wohin zeigt, sagt der Katalog, nicht das Fenster | Aufgabe 3 |
| E7 | Schreiben | über den Lader des Imports (033): Der Generator ist eine Quelle von Datensätzen (`Records`) wie eine Datei; gebundene Stapel-`INSERT`s, blockweise oder in einer Transaktion, als Job mit Fortschritt und Abbruch. Die Form des `INSERT` geht durch `admit`; **auf einer geschützten Verbindung lehnt das Backend ab** | Aufgabe 5 |
| E8 | Datei statt Tabelle | dieselben Zeilen als CSV (Kopfzeile, NULL = leeres Feld) oder als `INSERT`-Skript, geschrieben vom Backend; eine halbe Datei bleibt nicht liegen. Das geht auch für eine geschützte Verbindung | Aufgabe 6 |
| E9 | Vorlage | je Verbindung/Schema/Tabelle in den Einstellungen (höchstens 200, nicht im Export der Einstellungen). Beim nächsten Öffnen liegt sie über dem Vorschlag – für die Spalten, die es noch gibt, mit dem Typ von heute | Aufgabe 6 |
| E10 | Wortlisten | je 50 Vor- und Nachnamen, 20 Orte, 15 Straßen für Englisch und Deutsch, im Code; selbst zusammengestellt aus häufigen Namen, keine fremde Liste übernommen. E-Mail-Adressen nur unter `example.com/.org/.net/.de` | Aufgabe 7 |
| E11 | Dialog | ein Dialog je Tabelle (Knoten im Baum: „Testdaten erzeugen …“): Zeilen, Startwert, Sprache; je Spalte Erzeuger, Einstellungen, NULL %, eindeutig; die ersten 20 Zeilen als Tabelle, nach jeder Änderung neu vom Backend | Aufgabe 4 |

## Was die Datenbanken zeigten

- **MySQL** nimmt `REFERENCES` an der Spalte hin und legt keinen Fremdschlüssel an: Im Test steht der Schlüssel als
  eigene Klausel der Tabelle.
- **PostgreSQL** gibt Schlüsselwerte nur als Text heraus, wenn man sie dazu macht (`::text`); die anderen ebenso
  (`CAST`).
- 1 Mio. Zeilen mit eindeutiger Spalte und Fremdschlüssel in PostgreSQL: 46 s (Container, Stapel-`INSERT`s);
  20 000 Zeilen: MySQL 0,8 s, MariaDB 0,7 s, SQL Server 9,7 s.

## Geprüft

- `pnpm check` grün.
- `testdata.rs`: 18 Tests – gleicher Startwert → gleiche Zeilen (und mehr Zeilen hängen nur an), Namen passen zu
  E-Mails, Bereiche, `created_at ≤ updated_at`, **1 Mio. Zeilen ohne Doppelten** in einer eindeutigen Zahl,
  E-Mail und einem Zeitpunkt, zu kleine Bereiche werden vorher abgelehnt, ein NULL-Anteil ändert keinen anderen
  Wert, Muster (gegen die `regex`-Bibliothek geprüft; kaputte und zu tiefe abgelehnt), Gewichte, Fremdschlüssel
  zufällig / je Elternzeile / eins zu eins, Längen, Vorschlag aus Typen und Namen, JSON vom Fenster.
- **Container** (`pnpm rust:test:db`, 52 Tests): `generated_rows_respect_keys_and_constraints` auf PostgreSQL
  (1 Mio. Zeilen), MySQL, MariaDB, SQL Server – der Vorschlag aus dem echten Katalog (Sequenz, eindeutige E-Mail,
  „nie vor“, Fremdschlüssel), 2 000 Kunden und die Bestellungen ohne eine abgelehnte Zeile, alle Codes und
  E-Mails verschieden, kein `updated_at` vor `created_at`, und in der Tabelle steht, was der Generator für den
  Startwert sagt.
- Frontend: `testdata-logic.spec.ts` (9), `testdata-dialog.spec.ts` (11): Vorschlag und Vorschau, jede Änderung
  fragt neu, Zeilen aus „je Elternzeile“, Rückfrage des Schutzes, geschützte Verbindung schreibt nicht (Datei
  geht), Vorlage merken und wiederfinden, Werte als Text.
- **Browser** (Dev-Server, Backend nachgestellt): Dialog mit acht Spalten, Vorschau, neuer Startwert → neue
  Vorschau, Lauf mit Startwert und Optionen, Meldung.

## Review (zweiter Agent, nur lesend)

Ein Befund „hoch“, fünf „mittel“, mehrere „niedrig“. Sauber: SQL (Namen nur aus dem Katalog und gequotet, Werte
gebunden, der Typname geprüft), der Schutz (jede Anweisung durch `admit`, geschützte Verbindung abgelehnt), kein
Markup, veraltete Vorschauen werden verworfen.

| Nr. | Befund | Behoben |
|---|---|---|
| H1 | Ein Muster, dessen Gruppen nichts schreiben (`(…(){200}…){200}`), drehte ohne Ende – die Grenze der Zeichen griff nie, und die Sitzung blieb gesperrt | ein Wert darf höchstens 20 000 Schritte brauchen (Test) |
| M1 | Ein eindeutiger Text in einer zu kurzen Spalte: Die Zeilennummer wurde abgeschnitten, zwei Zeilen wurden gleich | hat die Spalte keinen Platz für die Nummer, wird der Plan abgelehnt |
| M2 | Ein eindeutiger Zeitpunkt, der auf eine andere Spalte wartet, wurde neu gewürfelt | abgelehnt |
| M3 | „Eindeutig“ galt bei Ja/Nein, JSON, Auswahl mit doppelten Einträgen und gekürzten Zahlen stillschweigend nicht | Ja/Nein: je eines; JSON und doppelte Einträge abgelehnt; eine eindeutige Zahl, Folge oder E-Mail wird nicht gekürzt; Uhrzeit geht durch ihren Bereich |
| M4 | Eine gespeicherte Vorlage mit unvollständigem Generator ließ den Dialog abstürzen | Vorlagen werden beim Lesen ganz gemacht (`soundGen`), Zeilenzahl und Anteile begrenzt |
| L | Überlauf im Gang bei dem größten Bereich; Text der Länge 100 000 quadratisch; `{{int:MIN:MAX}}` gab immer das Minimum; im Skript galten `-`, `.` und `1.2.3` als Zahl; eine Datei, die sich nicht öffnen ließ, wurde gelöscht; zwei Klicks während der Dateiwahl starteten zwei Läufe | behoben, mit Tests |

Offen (M5 und niedrig): „Anhalten“ greift zwischen den Blöcken, nicht mitten in einem `INSERT`, das auf eine
Sperre wartet; das Lesen der Schlüsselwerte davor (bis 60 s je Schlüssel) lässt sich nicht anhalten. Die
Vorschau liest die Schlüssel jedes Mal neu (bis 200 000), damit sie zeigt, was geschrieben würde. Der Export
meldet keinen Fortschritt. CSV: Werte, die mit `=`, `+`, `-`, `@` beginnen, stehen wie sie sind; NULL und leerer
Text sind dort nicht zu unterscheiden. Binärspalten stehen im `INSERT`-Skript als Text.

## Nicht geprüft

- Das native Fenster wurde nicht bedient (auch der Speichern-Dialog für die Datei nicht).
- 1 Mio. Zeilen nur gegen PostgreSQL; „konstanter Speicher“ ist aus dem Aufbau begründet (Zeile für Zeile, Schlüssel
  begrenzt), nicht gemessen. Abbruch: der des Laders aus 033, hier nicht eigens gemessen.
- CockroachDB, TimescaleDB, SQLite gegen echte Tabellen (SQLite: der Generator läuft, der Katalogweg ist der von 008).

## Nicht umgesetzt

- **Ein ganzes Schema in einem Lauf** (mehrere Tabellen in Abhängigkeitsreihenfolge): Der Dialog füllt eine
  Tabelle; Eltern zuerst füllen, dann die Kinder – die Fremdschlüssel nehmen dann die gerade erzeugten Zeilen,
  auch mit „Zeilen je Elternzeile“.
- Fremdschlüssel über mehrere Spalten; mehr als 200 000 Elternzeilen (es wird aus den ersten 200 000 gezogen).
- Vorschau als GuiExpert Table (einfache Tabelle mit 20 Zeilen).
- Check-Bedingungen lesen (nur `enum(…)` im Typ); Verteilungen über „gleichmäßig“ und „um die Mitte“ hinaus;
  weitere Sprachen; eindeutige Kombinationen mehrerer Spalten (eindeutig ist je Spalte).
