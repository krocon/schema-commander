# Roadmap

| Schritt | Inhalt | Status |
|---|---|---|
| 0 | Technischer Aufbau, Walking Skeleton (Editor → Rust → Gitter), Farbschemata, Best Practices | ✅ |
| 1 | Feature-Analyse der wichtigsten SQL-Tools (`docs/feature-analysis.md`) | ✅ alle Features freigegeben |
| 2 | Prompts 001–049 (`prompts/`) und E1–E5 für editlicious (`prompts/done/editlicious/`) | ✅ geschrieben |
| 3 | Umsetzung Prompt für Prompt in der Reihenfolge von `prompts/README.md` | 001–034 ✅, 035 teilweise (035a: CockroachDB, TimescaleDB; 035b: Oracle), 036–049 ✅ (offen: 035, die weiteren Datenbanken); E1–E5 erledigt mit `editlicious-editor` 1.2.0; seit 1.3.0 Zeilenkommentar und Ansicht nach dem Kürzen im Editor |

Bekannte Lücken des Skeletons (werden von den ersten Prompts geschlossen):

- Das Gitter sortiert nicht mehr lokal (kommt mit 027); 10 Mio. Zeilen und ein Release-Build wurden nicht gemessen
  (Design 006).
- Sortieren und Filtern: im nativen Fenster und gegen echte Server nicht gelaufen; lokal höchstens 5 Mio. Zeilen
  sortieren, ohne Kollation; keine benannten Filter, freies `WHERE` ohne Vervollständigung; die Tabellen-Ansicht
  ist nach einem Neustart ein Abfrage-Tab (Design 027).
- Wert-Ansicht: im nativen Fenster nicht bedient; Kopieren und Export schreiben weiter die gekürzte Zeile (der
  ganze Wert liegt jetzt im Speicher – eigener Auftrag); keine Geometrie, kein JSON-Pfad, Feld nur rechts
  (Design 026).
- Parameter: im nativen Fenster nicht bedient; kein „nur ersetzen“ für Namen (Absicht), kein Typ aus dem Katalog,
  Werte nur im Speicher des Tabs; `E'…'`-Strings von PostgreSQL liest der Tokenizer nicht richtig (Design 025).
- Gespeicherte Abfragen und Snippets: im nativen Fenster nicht bedient (Neustart, Papierkorb, Ordner-Dialog);
  keine Variable für die Zwischenablage (fehlt im Editor), kein Import aus VS Code; Ordner verwaltet man im
  Dateimanager (Design 024).
- Formatieren: im nativen Fenster nicht bedient, 20 MB nicht gemessen; Schlüsselwörter groß/klein kann auf einem
  SQL Server mit groß/klein-empfindlicher Sortierung Namen treffen; Rümpfe in Dollar-Quotes bleiben unformatiert
  (Design 023).
- Fehler im Editor: keine Vorabprüfung; SQLite und SQL Server nennen nicht immer die genaue Stelle; Ende-zu-Ende
  nur mit nachgestellter Antwort gesehen (Design 022).
- Vervollständigung: keine Signaturhilfe und keine Schnellinfo am Bezeichner (fehlt im Editor), Regeln statt
  Parser, nicht gegen ein echtes Schema im nativen Fenster geprüft (Design 021).
- Springen zu allem: keine gespeicherten Abfragen, „im Baum zeigen“ filtert nur, der Index wird erst bei der
  ersten Suche gelesen; 200 000 Namen nur erzeugt gemessen (Design 020).
- Objekt-Details: ein Dialog statt eines Tabs; DDL von PostgreSQL- und SQL-Server-Tabellen ohne Besitzer, Rechte,
  Speicherparameter; kein Abgleich mit `pg_dump`; große Tabellen nur mit nachgestellten Daten gesehen (Design 019).
- SQL Server: Trigger und Prozeduren, die mit einer Version vor 019 angelegt wurden, tragen die angehängte
  Zeilenzähl-Abfrage in ihrem Text (Design 019).
- Menüs: Die native Menüleiste ist auf keinem System gelaufen (`Cmd+C/V/X/A/Z`, Beschleuniger, Sprachwechsel
  ungeprüft); Windows und Linux standen nicht zur Verfügung (Design 018).
- Sprache: Detailtexte aus Rust (`AppError.message`) sind weiter deutsch; Meldungen, die schon im Fenster stehen
  (Meldungsprotokoll, Export-Status), wechseln die Sprache nicht nachträglich; Speichergrenzen sind keine
  Einstellung; das native Menü wurde nicht im laufenden Programm umgeschaltet (Design 017).
- Arbeitsbereich: zwei Gruppen sind gleich groß (kein Splitter dazwischen), keine eigene Scrollposition, die
  Ansicht „gespeicherte Abfragen“ fehlt; im nativen Fenster nicht bedient (Design 016).
- Import: die Formate von DBeaver und DataGrip sind nicht an echten Dateien belegt; TablePlus fehlt (Design 015).
- SSH/TLS: kein `ProxyJump`, kein Hostname-Check des Zertifikats durch den Tunnel; Zertifikatsprüfung und Agent
  sind gegen keinen echten Server gelaufen (Design 014).
- Transaktionen: keine Isolationsstufe, kein Modus je Profil; Trennen einer Verbindung fragt nicht (Design 013).
- Produktionsschutz: eigene Funktionen gelten als lesend, SQL Server hat keine zweite Linie auf dem Server; die
  nach dem Review neu geschriebene Einstufung wurde nicht erneut angegriffen (Design 012).
- Binärwerte über 64 Bytes fehlen in Kopie und Export; `export_query` und 10 Mio. Zeilen sind gegen keinen
  echten Server gemessen (Design 011).
- Die Zwischenablage (`arboard`) ist übersetzt, aber auf keinem System ausgeführt worden (Design 009).
- Schema-Baum: keine Mehrfachauswahl, keine Favoriten, wartet hinter einer laufenden Anweisung (Design 008).
- Spaltenkopf ohne Schlüssel-Marken und Sortierzustand (008, 027); Datumsformat nicht einstellbar (017).
- Meldungen des Servers (NOTICE, PRINT) kommen nicht an (Treiber geben sie nicht weiter, Design 005).
- SQL Server: Ein Abbruch kostet die Verbindung (kein Attention-Signal in `tiberius`).
- Keine Menüleiste (018), keine Übersetzung (017).
- Die native App wurde gebaut und gestartet, ihr Fenster aber noch nicht von Hand durchgeklickt – auch nicht
  gegen einen echten Server und den echten Schlüsselbund (003).
