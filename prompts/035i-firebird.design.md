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
- `SET TRANSACTION` mit Optionen: Nur `READ ONLY` wird beachtet; Isolationsstufe, `WAIT`/`NO WAIT`, `RESERVING`
  nicht. `COMMIT RETAIN`/`ROLLBACK RETAIN` gehen an den Server und scheitern dort.
- `SET TERM` (ein Befehl von `isql`) kennt die App nicht; der Zerleger braucht ihn nicht.
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
