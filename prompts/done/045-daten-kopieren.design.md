# Design 045: Daten zwischen Datenbanken kopieren

> **Status:** umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/daten-kopieren` · Auftrag: [045-daten-kopieren.md](045-daten-kopieren.md) · Feature F4

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Strom | Die Quelle wird in einem **eigenen Thread** gelesen (`Session::execute` in eine Senke) und gibt ihre Zeilen über eine **Warteschlange fester Länge** (2 000 Zeilen) an den Lader des Imports (033), der sie mit gebundenen Werten schreibt. Ist das Ziel langsamer, wartet die Quelle: Der Speicher bleibt gleich, wie viele Zeilen es auch sind. Keine Zwischendatei | Aufgabe 3, Akzeptanzkriterium 1 |
| E2 | Schreiben | der Lader aus 033, unverändert in seinem Verhalten: Stapel-`INSERT`s (bis 200 Zeilen bzw. 2 000 Werte), blockweise mit Commit oder die ganze Tabelle in einer Transaktion, „Zeile auslassen“ mit Fehlerdatei. Er liest jetzt aus einer Quelle von Datensätzen (`Records`) – Datei oder Datenbank | ein Schreibweg für Import und Übertragung, mit seinen Tests |
| E3 | Werte | Jede Zelle reist als Text, den nichts verliert, und wird gebunden: ganze Zahlen und Dezimalzahlen als ihr Text, Gleitkomma mit Exponent, wo Rust sonst 300 Ziffern schriebe, Datum/Zeit ISO, ein Zeitpunkt mit Zone – oder als UTC, wenn das Ziel keine Zone hält. **Binärdaten als Hex**, den die Anweisung zu Bytes macht (`decode`, `UNHEX`, `CONVERT(varbinary…, 2)`, `unhex`) – so braucht kein Treiber binäre Parameter. NULL ist NULL, ein leerer Text ein leerer Text, ein leeres BLOB ein leeres BLOB | Akzeptanzkriterium 3 |
| E4 | Typabbildung | `transfer::class_of` liest einen Typ jedes Dialekts in eine Klasse (ganze Zahl, Dezimal mit Stellen, Text mit Länge, Zeitpunkt, JSON, UUID, Binär …), `type_for` schreibt die Klasse im Zieldialekt und nennt den **Verlust**, wenn es einen gibt (Zone geht verloren, JSON wird Text, Stellen begrenzt, unbekannter Typ als Text). Die Verluste stehen in der Vorschau, bevor etwas läuft | Aufgabe 2, Akzeptanzkriterium 2 |
| E5 | Zieltabelle | vorhanden: Spalten nach Namen (ohne Groß/Klein), was das Ziel nicht hat, wird ausgelassen und genannt. Neu: angelegt mit abgebildeten Typen und dem Primärschlüssel – über den Erzeuger aus 038/043 | Aufgabe 2 |
| E6 | Reihenfolge | Tabellen in der Reihenfolge ihrer Fremdschlüssel (wer zeigt, kommt nach dem, auf den er zeigt); ein Kreis wird genannt und in der gegebenen Reihenfolge kopiert | Aufgabe 4 |
| E7 | Indizes und Schlüssel | für neu angelegte Tabellen, **nach den Zeilen aller Tabellen** (Option); nur Schlüssel zu Tabellen, die im Ziel sein werden. Scheitert einer, steht er im Bericht – die Zeilen bleiben | Aufgabe 7 |
| E8 | Modus | anhängen oder vorhandene Tabelle vorher leeren | Aufgabe 5 (Rest: „Nicht umgesetzt“) |
| E9 | Schutz | Der Plan nennt jede Anweisung, die im Ziel läuft (`CREATE`, Leeren, die Form des `INSERT`, Indizes, Schlüssel); `transfer_run` macht den Plan neu und lässt jede durch `admit` des **Ziels**. Die Quelle wird nur gelesen | Aufgabe 5, Regel „Schutz im Backend“ |
| E10 | Job | eine Übertragung zur Zeit, auf eigenen Sitzungen beider Verbindungen; Fortschritt je Tabelle in gelesenen Zeilen; „Anhalten“ beendet beim nächsten Block beide Seiten | Aufgabe 3 |
| E11 | Bericht | je Tabelle: Ausgang (kopiert, mit Lücken, fehlgeschlagen, angehalten, nicht begonnen), Zeilen geschrieben/gelesen, Dauer, der Grund der Datenbank und was bleibt („nichts davon“ in einer Transaktion, „was davor geschrieben wurde“ blockweise); Fehlerdatei je Tabelle | Aufgabe 6 |
| E12 | Wiederaufsetzen | bewertet, nicht gebaut: Ohne eine Ordnung der Quelle, die beide Seiten teilen (ein Schlüssel), gibt es keine Stelle zum Weitermachen. Der sichere Weg ist „vorher leeren“ und neu – in einer Transaktion bleibt nach einem Abbruch ohnehin nichts | Aufgabe 6 |

## Was die Datenbanken zeigten

- **SQL Server macht aus einer Spalte von `VALUES` einen Typ**: Eine Zeile mit einer Dezimalzahl und eine mit
  dem Text `-1.5e300` in derselben Spalte scheitern („nvarchar to numeric“). Gleitkommazahlen reisen deshalb
  immer als Text – jede Zeile bindet denselben Typ.
- **PostgreSQL hält zu einem `timestamptz` keine Zone**: Der Zeitpunkt kommt als UTC an, auch in einem Ziel, das
  Zonen hält (`datetimeoffset`). Kein Verlust – der Zeitpunkt ist derselbe.
- PostgreSQL nennt einen Index nur als Anweisung: Seine Spalten liest `structure::index_columns` (043).

## Geprüft

- **Rust** (14 Tests in `transfer_tests.rs`, vier davon aus dem Review): Klassen der Typen (44 Fälle); **Typabbildung je Dialektpaar**
  (38 Fälle mit und ohne Verlust; jede Klasse in ihrem eigenen Dialekt ist wieder sie selbst); Plan für neue
  Tabellen in Schlüssel-Reihenfolge mit Verlusten, Hinweisen und Anweisungen; vorhandene Tabelle (Namen ohne
  Groß/Klein, fehlende Spalte, Leeren); Abgelehntes; Kreis; Zelle als Text (22 Fälle); **Kopie zwischen zwei
  SQLite-Datenbanken** mit allen Wertarten, Anhängen mit Schlüsselkonflikt, Leeren; **Quelle scheitert mitten im
  Lauf** → in einer Transaktion bleibt nichts, beide Sitzungen sind frei; 60 000 Zeilen als Strom, Anhalten
  beendet beide Seiten.
- **Gegen die Container** (`tables_copied_between_databases_arrive_as_they_were`): eine Tabelle mit allen Typen
  (Unicode, Emoji, `'`, `\`, Zeilenumbruch, NULL in jeder Spalte, leerer Text, leeres und gefülltes `bytea`,
  `numeric`, `bigint` jenseits 2^53 und an der Grenze, `-1.5e300`, Datum im Jahr 1, Zeitpunkte mit Zonen, JSON,
  UUID) samt Kindtabelle: **PostgreSQL → MySQL** (angelegt, Schlüssel und Index nach den Zeilen, Werte geprüft,
  der Verlust „Zone“ steht im Plan) **→ zurück nach PostgreSQL** (alle verlustfreien Spalten gleich, der
  Zeitpunkt als UTC); **→ SQL Server**; **→ SQLite**. **300 000 Zeilen PostgreSQL → MySQL in 7,3 s**
  (Debug-Build), Summe und Anzahl stimmen; angehalten nach 20 000 gelesenen Zeilen: im Ziel steht genau, was der
  Bericht sagt, beide Sitzungen arbeiten weiter.
- **Fenster** (15 Tests): Logik (Standardschema, Auslassen ≠ alles-oder-nichts, Prüfung, Verluste, Ausgang je
  Tabelle, Summe, Dauer); Dialog (Tabellen und nur verbundene Ziele, Plan mit Tabelle aus dem Baum und Schema des
  Ziels, Lauf mit Fortschritt, Anhalten und Bericht, Rückfrage des Schutzes am **Ziel**, Fehlerdatei, Fehlschlag
  mit dem Text der Datenbank als Text, Tabelle in sich selbst, Planfehler).
- **Im Browser** mit nachgebildetem Backend: Tabellen des Schemas, Ziel wählen (Schema des Ziels vorbelegt),
  Vorschau mit „wird angelegt / ist vorhanden“, ausgelassener Spalte und dem Verlust der Zone; Lauf mit
  „Tabelle 1 von 2 … Zeilen gelesen“; Bericht mit einer gescheiterten Tabelle („nichts davon bleibt“).
  **Nicht bedient:** das native Fenster.
- `pnpm check` grün; `pnpm rust:test:db` grün.

## Review

Ein zweiter Agent hat Plan, Strom und Lauf gelesen (Zustand des Ziels nach Fehlern, Threads, Reihenfolge, Werte,
Typen, Schutz). Nichts gefunden bei: Warteschlange und Threads (kein Hängen, keine verlorene oder doppelte
Zeile), Zustand der Quell-Sitzung, Schutz (jede Anweisung im Ziel ist eine des Plans), Berichte in einer
Transaktion, den meisten Wertarten. Behoben – mit Tests:

| Nr. | Befund | Behebung |
|---|---|---|
| H1 | Eine als binär geltende Spalte (SQLite ohne Typ) „dekodierte“ Zahlen und Texte, die wie Hex aussehen (`42` → Byte 0x42), still und nur für manche Zeilen | In eine binäre Spalte geht, was kein Binärwert ist, als die Bytes seines Textes; eine SQLite-Spalte ohne Typ ist keine binäre |
| H2 | Ein Absturz im lesenden Thread sah aus wie das Ende der Tabelle – der Rest wäre festgeschrieben und als „kopiert“ gemeldet worden | Das Ende wird ausdrücklich gemeldet (`Done`); eine Quelle, die ohne das Wort verschwindet, ist ein Fehler |
| H3 | „Vorher leeren“ blockweise: Scheiterte danach etwas, waren die alten Zeilen weg – und der Bericht sagte es nicht | Der Bericht sagt „die Tabelle wurde vorher geleert: ihre alten Zeilen sind weg“ |
| M1 | Nach einem Fehler oder Anhalten bekamen auch die **vollständig** kopierten Tabellen keine Indizes und Schlüssel – und beim nächsten Lauf „gab es sie schon“ | Indizes und Schlüssel jeder vollständigen Tabelle werden immer angelegt |
| M2 | Eine in diesem Lauf angelegte Tabelle bleibt, auch wenn ihre Zeilen zurückgerollt wurden – der Bericht sagte „nichts davon bleibt“ | Der Bericht sagt „die Tabelle wurde angelegt und ist da“ |
| M4 | „Tabelle in sich selbst“ wurde nur im Fenster geprüft; in SQLite zählt das Schema nicht | abgelehnt im Backend |
| M5 | Ein Text-Primärschlüssel wurde `longtext` / `nvarchar(max)` – beides kann kein Schlüssel sein | `varchar(255)` / `nvarchar(450)`, als Verlust genannt |
| M6 | Lange `varchar` sprengen die Zeilengröße von MySQL | über 255 Zeichen → `longtext` |
| M7 | SQLite: Namen, die nichts sagen (`STRING`, `UUID`), galten als Zahl – jeder andere Wert wurde abgelehnt | gelten als „irgendetwas“ und reisen als Text |
| M8 | `smallint unsigned` passte nicht in `smallint` | → `int` |

Offen gelassen (unter „Nicht umgesetzt“): M3, M9, M10 und die kleineren Punkte.

## Nicht geprüft

- **10 Mio. Zeilen**: gelaufen sind 300 000 (≈ 41 000 Zeilen/s im Debug-Build); der Speicher ist durch die
  Warteschlange fester Länge und die Blöcke des Laders begrenzt, gemessen wurde er nicht.
- MariaDB als Ziel eigens (läuft über denselben Treiber und Dialekt wie MySQL).

## Nicht umgesetzt

- **Eine Abfrage als Quelle**: Quelle sind Tabellen.
- **Upsert** und **nur fehlende Zeilen**: Der Lader kennt `INSERT`; beides braucht je Dialekt eine andere
  Anweisung (`ON CONFLICT`, `ON DUPLICATE KEY`, `MERGE`).
- **Fremdschlüssel/Trigger im Ziel aussetzen**: Stattdessen die Reihenfolge der Schlüssel und Schlüssel erst
  nach den Zeilen (neue Tabellen). Bei vorhandenen Tabellen im Kreis kann das Ziel Zeilen ablehnen – der Plan
  sagt es.
- **Identity-Werte und Sequenzen**: Die Werte der Schlüsselspalten werden übernommen; neu angelegte Tabellen
  haben keine Identity (der Schnappschuss kennt sie nicht), Sequenzen vorhandener Tabellen werden nicht
  nachgezogen.
- **Vorgaben und Checks** neuer Tabellen (im Dialekt der Quelle geschrieben), Indizes auf Ausdrücken, in SQLite
  Indizes und Schlüssel neuer Tabellen: stehen als Hinweis im Plan.
- **Zuordnung von Hand** (Spalte A → Spalte B): zugeordnet wird nach Namen.
- **Alles in einer Transaktion über mehrere Tabellen**: Die Transaktion gilt je Tabelle.
- Werte über 16 MB (als Hex die Hälfte) lehnt der Lader ab; die Zeile scheitert mit Grund.
- **Aus dem Review, nicht behoben:** „Vorher leeren“ mit Fremdschlüsseln zwischen den gewählten, vorhandenen
  Tabellen (die Eltern werden zuerst geleert – das Ziel lehnt ab; vorher von Hand leeren); eine vorhandene
  SQL-Server-Spalte `datetime` nimmt keine Werte mit mehr als drei Nachkommastellen; vorhandene Zielspalten mit
  Identity oder `GENERATED ALWAYS` lehnen jede Zeile ab (kein Hinweis im Plan); `tinyint(1)` mit Werten über 1
  wird wahr; `NaN`/`Infinity`, Daten vor Christus und `infinity`-Zeitpunkte werden als Zeile abgelehnt;
  `datetime2(7)` rundet auf sechs Stellen; der Plan beim Lauf kann von dem gezeigten abweichen, wenn sich das
  Ziel dazwischen ändert (jede Anweisung geht dennoch durch den Schutz).
