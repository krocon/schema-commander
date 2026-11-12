# Design 035i: Firebird

> Durchlauf von [Prompt 035](035-weitere-datenbanken.md) für **Firebird**. Stand: umgesetzt am 12.11.2026 (ohne
> Freigabe-Halt, Marcs Anweisung vom 11.11.2026), geprüft gegen Firebird 5.0.4 (Container `firebirdsql/firebird:5`).

## Ergebnis in einem Satz

Firebird ist eine eigene `DbKind` mit eigenem Dialekt: verbinden, ausführen, abbrechen, Transaktionen, Baum,
Details, Fremdschlüssel, Diagramm, Tabellen-Ansicht mit Filter, **Zeilen bearbeiten**, Suche, nur lesende Sitzung.
Plan, Monitor, Rechte, Struktur bearbeiten, Schema-Vergleich und Tabellen kopieren gibt es dort noch nicht.

## Entscheidungen

| # | Entscheidung | Warum |
|---|---|---|
| E1 | Treiber **`firebird-wire`** (MIT, reines Rust), fest angepinnt (`=0.1.16`) – nicht `rsfbclient` | `rsfbclient` gibt `NUMERIC(10,2)` als Gleitkommazahl zurück; `firebird-wire` gibt Mantisse und Skala, dazu `INT128`, `DECFLOAT`, Zeitzonen, Srp256 und die eigene Verschlüsselung der Leitung. Dagegen steht: jung (fünf Monate), ein Autor, wenige Nutzer – darum die feste Version, und wenige eigene Abhängigkeiten (`bytes`, `num-bigint`, `rand`, `sha1`, `sha2`, `thiserror`) |
| E2 | **Transaktionen hält der Treiber**: Firebird führt nichts außerhalb einer aus, und das Handle liegt beim Client. Ohne eine des Nutzers bekommt jede Anweisung ihre eigene (Commit, wenn sie ging; Rollback, wenn nicht). `SET TRANSACTION`, `COMMIT`, `ROLLBACK` führt der Treiber selbst aus – genau diese drei (`ROLLBACK TO SAVEPOINT` ist eine Anweisung des Servers) | so verhält sich ein Tab wie bei jeder anderen Datenbank: Auto-Commit oder eine Transaktion, die man sieht. `begin_statement` ist `SET TRANSACTION` |
| E3 | Ob eine Transaktion offen ist, sagt das Handle | der Server hat es diesem Client gegeben; es gibt nichts zu fragen |
| E4 | **Werte**: Der Server sagt beim Vorbereiten, was jeder Platzhalter ist; der Treiber liest den Text als genau das – eine Zahl mit Skala als ganze Zahl (`12.50` → 1250), Datum, Zeit, Wahrheitswert – oder lehnt ab. Mehr Nachkommastellen, als die Spalte hält, werden abgelehnt, nicht gerundet. Ein BLOB wird erst geschrieben, dann seine Id gebunden | keine Ziffer geht verloren, nichts wird SQL |
| E5 | **Abbruch** von einer zweiten Verbindung: `DELETE FROM mon$statements WHERE mon$attachment_id = …` (die Nummer gibt der Server); die Sitzung lebt weiter | der Treiber kennt `op_cancel` nicht; so macht man es auch von Hand |
| E6 | **Nur lesen**: `Session::make_read_only` – jede Transaktion der Sitzung wird nur lesend geöffnet, auch die, die der Nutzer `READ WRITE` nennt | der Server lehnt Schreiben darin ab (geprüft) |
| E7 | **Ein Namensraum**: Die App führt ein Schema mit leerem Namen (im Baum „(Datenbank)“); nichts wird je damit qualifiziert. Katalogabfragen nehmen es als gebundenen Wert | Firebird kennt Schemata erst ab Version 6 |
| E8 | Namen: unquotiert nur, was groß geschrieben ist (`ORDERS`); alles andere in `"…"` | so speichert Firebird sie |
| E9 | „Enthält“: `CONTAINING` (ohne Groß/Klein) bzw. `POSITION(… IN …)`; ein Suchwert ohne Spaltentyp wird als `CAST(? AS VARCHAR(8191))` gebunden | `LIKE … ESCAPE` nimmt dort kein Escape vor `[`; und ein Muster ist länger als die Spalte, gegen die es steht |
| E10 | Grenze mit `FETCH FIRST n ROWS ONLY`; eine Zeile je `INSERT`, mit `RETURNING` | Firebird 4+; mehrzeilige `VALUES` gibt es nicht |
| E11 | Keine Zertifikate: „TLS“ des Profils heißt hier die eigene Verschlüsselung der Leitung – aus = wenn der Server sie anbietet, „erforderlich“ = Pflicht; die prüfenden Modi werden abgelehnt | Firebird verschlüsselt mit einem Schlüssel aus der Anmeldung (SRP) |
| E12 | `RECREATE …` gilt als **gefährlich** | es löscht, was da ist |
| E13 | Im Fenster: `:name` ist dort kein Parameter (es gehört zu PSQL), nur `${name}` und `?`; der Zerleger hält den Rumpf von Prozeduren, Funktionen, Triggern, Paketen und `EXECUTE BLOCK` zusammen | sonst zerfiele ein Rumpf an seinen `;` |

## Was noch fehlt (bewusst)

- **Ausführungsplan** (der Treiber gibt den Plan nicht heraus), **Server-Monitor** (`MON$`-Tabellen), **Rechte**,
  **Struktur bearbeiten**, **Schema-Vergleich**, **Tabellen kopieren** (kein Erzeuger für den Dialekt).
- **DDL einer Tabelle**: Firebird bewahrt keine Anweisung auf, und die App schreibt noch keine. Views zeigen ihre
  Anweisung, Prozeduren und Funktionen ihren Rumpf.
- `SET TRANSACTION`: `READ ONLY`/`WRITE`, die Isolationsstufe, `WAIT`/`NO WAIT` und `LOCK TIMEOUT` führt der
  Treiber aus; `RESERVING`, `NO AUTO UNDO` und was sonst dort stehen kann, lehnt er ab (nichts wird geöffnet).
  `COMMIT RETAIN`/`ROLLBACK RETAIN` gehen an den Server.
- Pakete im Baum, Domänen, Ausnahmen, Rollen; Arrays (als nicht lesbar gezeigt).
- Firebird 3 und 4: der Treiber nennt Firebird 5+; ältere sind nicht gelaufen. Eingebettete Datenbanken gibt es nicht.

## Nicht getestet

- **SSH-Tunnel**, `WireCrypt = Required` gegen einen Server, der sie nicht anbietet, Legacy-Anmeldung, andere
  Zeichensätze als UTF8 (die Verbindung spricht immer UTF8).
- Import einer Datei und Testdaten als ganzer Lauf (sie schreiben über dieselben Anweisungen wie das Bearbeiten).
- Das native Fenster (`pnpm tauri dev`) wurde nicht bedient.

## Tests

- `src-tauri/tests/firebird_integration.rs` (7 Tests, `pnpm rust:test:db`): Typen (auch `NUMERIC(38,2)`,
  `DECFLOAT`, BLOB, Zeitzone), Unicode, NULL; Änderungen, Grenze, Fehler mit Stelle, Transaktionen (gehalten,
  ungesehen von anderen, Savepoint, Fehler darin); falsches Passwort, unbekannte Datenbank, kein Server, eigene
  Verschlüsselung; Abbruch und Zeitlimit mit weiterlebender Sitzung; gebundene Werte (auch böse, zu viele
  Nachkommastellen), nur lesende Sitzung gegen sechs Versuche zu schreiben; Metadaten, Namensindex, Details,
  Fremdschlüssel, Diagramm, Suche; Filtern, Sortieren und ein Schreibplan mit Sperre in einer Transaktion.
- Unit-Tests: `firebird.rs` (Zahlen mit Skala in beide Richtungen, Werte je Platz, Zellen, die drei Anweisungen der
  Transaktion), `guard.rs`, `import.rs`, `mod.rs`; im Fenster Zerlegen, Parameter.

## Review

Ein zweiter, nur lesender Blick über den Branch, mit dem echten Treiber gegen den laufenden Server geprüft.
Behoben, mit Tests (`review_comments_long_values_binary_and_words_of_the_language`, `firebird.rs`, `meta.rs`,
`guard.rs`, Fälle des Zerlegers):

| # | Befund | Behebung |
|---|---|---|
| 1 (hoch) | Ein Kommentar neben `COMMIT`, `ROLLBACK` oder `SET TRANSACTION` ging am Treiber vorbei an den Server: Der schloss die Transaktion wirklich, der Treiber hielt ein totes Handle und alles danach scheiterte | Die drei Anweisungen werden ohne ihre Kommentare erkannt |
| 2 (hoch) | Ein Text, länger als sein Platz, galt als kaputte Leitung: Die Sitzung war weg, eine offene Transaktion mit ihr | Die Länge wird beim Binden geprüft und in Worten abgelehnt; die Sitzung bleibt |
| 3 (hoch) | Jeder Binärwert scheiterte: `HEX_DECODE(CAST(? AS VARCHAR(8191)))` – Firebird will eine gerade Länge | `VARCHAR(8190)`. **Bleibt:** ein Binärwert über 4095 Bytes lässt sich so nicht binden |
| 4 (hoch) | 127 reservierte Wörter von Firebird wurden nicht gequotet (`DATE`, `VALUE`, `COUNT` … als Spaltennamen), Namen mit `_` am Anfang auch nicht | eigene Liste aus `RDB$KEYWORDS` des Servers; ein Name beginnt mit einem Buchstaben |
| 5 | `DECFLOAT` und `TIMESTAMP WITH TIME ZONE` ließen sich nicht binden | werden gelesen und gebunden; `TIME WITH TIME ZONE` wird in Worten abgelehnt. Neue Import-Tabellen bekommen `NUMERIC(38, 10)` statt `DECFLOAT` |
| 6 | Optionen von `SET TRANSACTION` wurden still verworfen | ausgeführt oder abgelehnt (siehe oben) |
| 7 | `GEN_ID(…)` bewegt eine Sequenz auch in einer nur lesenden Transaktion und galt als lesend | gilt als schreibend |
| 8 | Zerleger: `SET TERM`, ein langer Kommentar vor einer Prozedur, Unterroutinen in den Deklarationen, externe Funktionen | behoben |
| 9 | `VARCHAR(10) CHARACTER SET NONE` hieß `VARCHAR(2)` | Bytes je Zeichen nach dem Zeichensatz |
| 11 | `FLOAT` 0.1 erschien als 0.10000000149…; `1e300` wurde still zu unendlich; riesige `DECFLOAT`-Exponenten wurden zu tausenden Nullen | wie geschrieben; abgelehnt; in Exponentenschreibweise |
| 12 | DDL in einer nur lesenden Sitzung war „ungültige Anweisung“ statt „keine Rechte“ | am Text der Meldung erkannt |

Offen geblieben:

- **Zeichensatz NONE mit Bytes, die kein UTF-8 sind** (alte Datenbanken mit WIN125x): Sie erscheinen als
  Ersatzzeichen; die Sperre einer solchen Zeile passt nie, und wer die Zelle bearbeitet, überschreibt die Bytes.
- Vergleiche lehnen ab, was die Spalte nicht halten könnte (`ID < 1.5` auf INTEGER) – richtig beim Schreiben,
  überraschend beim Filtern. Sekundenbruchteile über vier Stellen werden abgeschnitten.
- DDL in einer Transaktion des Nutzers sehen spätere Anweisungen erst nach dem `COMMIT`; die Fragen der App an den
  Katalog laufen in der offenen Transaktion eines Tabs und sehen deren Stand.
- Das Passwort liegt, solange die Sitzung lebt, im Verbindungsobjekt des Treibers (für die zweite Verbindung beim
  Abbruch) – als gewöhnlicher Text, nicht genullt.
- Berechnete Spalten sind nicht gekennzeichnet (das Gitter bietet sie zum Bearbeiten an, der Server lehnt ab); im
  Namensindex fehlen Funktionen und Sequenzen; mit dem leeren Schema zeigen Suche und Palette `.TABELLE`.
