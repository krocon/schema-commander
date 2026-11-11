# Feature-Analyse: Was die besten SQL-Tools können – und was wir nachbauen

> Stand 10.11.2026 · Status: **Alle Features von Marc freigegeben (10.11.2026).** Die Spalte „Freigabe“ nennt den
> Prompt; Reihenfolge und Abhängigkeiten stehen in [`prompts/README.md`](../prompts/README.md).
>
> Grundlage ist mein Wissen über die Werkzeuge (Bedienung, Doku, bekannte Stärken und Schwächen), keine neue
> Recherche im Netz und kein Test der aktuellen Versionen. Einzelne Details können sich in neueren Versionen
> geändert haben; die Design-Phase jedes Prompts prüft das Vorbild noch einmal genau.

## 1. Die betrachteten Werkzeuge

| Werkzeug | Art | Wofür es geliebt wird | Wofür es kritisiert wird |
|---|---|---|---|
| **DataGrip** (JetBrains) | kommerziell, Java | beste Vervollständigung und Code-Intelligenz (Aliase, JOINs über Fremdschlüssel, Refactoring), Konsolen ohne „Speichern?“, Daten-Extraktoren, Ergebnisse vergleichen | schwer, langsamer Start, Introspektion großer Schemata dauert, Bedienung überladen |
| **DBeaver** | Open Source + Pro, Java/Eclipse | unterstützt fast jede Datenbank, ER-Diagramme, Datentransfer, Wert-Panel, Sitzungsmanager | träge, verschachtelte Dialoge, uneinheitliche Oberfläche |
| **TablePlus** | kommerziell, nativ | sehr schnell und aufgeräumt, Änderungen sammeln und mit einem Befehl schreiben, Farbe und Schutz je Verbindung, Filterzeile | wenig Tiefe (Vervollständigung, Pläne), Linux-Version schwach, Lizenz je Gerät |
| **Beekeeper Studio** | Open Source + kommerziell, Electron | freundliche, moderne Oberfläche, gespeicherte Abfragen, Verlauf, Tabellen bearbeiten | Electron-Gewicht, große Ergebnisse, wenig Admin-Funktionen |
| **HeidiSQL** | Open Source, Windows (Linux neu) | winzig und sofort da, Struktur und Daten direkt bearbeiten, Prozessliste, Text auf dem ganzen Server suchen | altbackene Oberfläche, kein macOS |
| **DbVisualizer** | kommerziell, Java | solide über viele Datenbanken, Abfrage-Parameter, Schema-Vergleich | altmodisch, schwer |
| **SSMS / Azure Data Studio** | Microsoft | grafische Ausführungspläne, Aktivitätsmonitor, Snippets; ADS mit Notebooks und Diagrammen | nur SQL Server bzw. eingestellt (ADS) |
| **pgAdmin 4** | Open Source, Web-Technik | vollständige PostgreSQL-Verwaltung, grafisches EXPLAIN, Dashboard | langsam, umständlich, nur PostgreSQL |
| **Navicat** | kommerziell | Datensynchronisation, Struktur-Synchronisation, Modellierung, Import-Assistent | teuer, überladen |
| **Postico 2** | kommerziell, macOS | die ruhigste Oberfläche, Tabellen wie in einer Tabellenkalkulation bearbeiten | nur macOS und PostgreSQL |
| **DbGate** | Open Source, Electron/Web | Master-Detail über Fremdschlüssel, Formularansicht, auch NoSQL | Electron, weniger poliert |
| **DB Browser for SQLite**, **SQLiteStudio** | Open Source | einfacher Einstieg, alles für eine Datei | nur SQLite |
| **Oracle SQL Developer**, **Toad** | Hersteller-Werkzeuge | Tiefe für eine Datenbank: PL/SQL-Debugger, Tuning | schwer, altmodisch |
| **Harlequin**, **usql**, **pgcli** | Terminal | Tastatur zuerst, sofort gestartet | keine Maus-Bedienung, wenig Übersicht |

### Was daraus folgt

Die Beschwerden wiederholen sich: **langsamer Start, hoher Speicherverbrauch, große Ergebnisse, die das Werkzeug
einfrieren, überladene Dialoge**. Genau dort sind unsere Bausteine stark:

- **Tauri + Rust**: startet in Sekundenbruchteilen, kleine Pakete, ein Binary je System.
- **GuiExpert Table**: Millionen Zeilen und viele Spalten ohne Ruckeln; das Fenster holt nur, was es zeigt.
- **editlicious**: Skripte mit Millionen Zeilen, Mehrfach-Cursor, Makros, Suchen/Ersetzen – auch für SQL-Dumps und
  lange JSON-Werte.
- **Tastatur zuerst** und umschaltbare Farbschemata wie in files-and-folders.

**Positionierung:** so schnell und aufgeräumt wie TablePlus, mit der Code-Intelligenz Richtung DataGrip, frei (MIT)
und auf allen drei Systemen gleich gut.

## 2. Die Feature-Liste

Spalten: **Vorbild** = wo es am besten gelöst ist · **Umfang** S (Tage) / M (1–2 Wochen) / L (mehr, meist mehrere
Prompts) · **Stufe** = meine Empfehlung: **1** Grundlage (ohne das ist es kein SQL-Tool), **2** macht es gut,
**3** später · **Freigabe** = freigegeben, mit dem zugehörigen Prompt.

### A – Verbindungen

| Id | Feature | Vorbild | Umfang | Stufe | Freigabe |
|---|---|---|---|---|---|
| A1 | **Verbindungsprofile**: anlegen, testen, in Ordnern gruppieren, Farbmarke je Verbindung (Tokens `--conn-1…8` gibt es schon). Treiber PostgreSQL, MySQL/MariaDB, SQLite, SQL Server – reines Rust wie in log-commander (`sqlx`, `tiberius`, `rusqlite`) | TablePlus, DBeaver | L | 1 | ☑ [003](../prompts/done/003-verbindungen.md) |
| A2 | **Geheimnisse nur im Schlüsselbund** des Betriebssystems, nie in Dateien; Passwort auf Wunsch jedes Mal fragen | TablePlus, DataGrip | S–M | 1 | ☑ [003](../prompts/done/003-verbindungen.md) |
| A3 | **SSH-Tunnel** (Schlüssel, Agent, `~/.ssh/config`) und **TLS-Optionen** (Zertifikate, Prüfmodus) – `russh` ist in fnf und log-commander erprobt | TablePlus, HeidiSQL | M | 2 | ☑ [014](../prompts/done/014-ssh-tls.md) |
| A4 | **Schutz für Produktion**: Verbindung als „geschützt“ markieren → farbiger Fensterrahmen, Nur-Lesen-Modus, Rückfrage vor jeder schreibenden Anweisung, harte Rückfrage bei `UPDATE`/`DELETE` ohne `WHERE` und bei `DROP`/`TRUNCATE` | TablePlus (Safe Mode), DataGrip | M | 2 | ☑ [012](../prompts/done/012-produktionsschutz.md) |
| A5 | **Verbindung aus URL einfügen** (`postgres://…`) und **Import** aus DBeaver, DataGrip, TablePlus, `.pgpass`, `~/.my.cnf` | TablePlus | S–M | 2 | ☑ [015](../prompts/done/015-verbindungs-import.md) |
| A6 | **Weitere Datenbanken**: Oracle, DuckDB, ClickHouse, Snowflake, BigQuery … (je Treiber ein eigener kleiner Prompt) | DBeaver | L | 3 | ☑ [035](../prompts/035-weitere-datenbanken.md) |

### B – Schema-Browser

| Id | Feature | Vorbild | Umfang | Stufe | Freigabe |
|---|---|---|---|---|---|
| B1 | **Schema-Baum** in der Seitenleiste: Datenbanken, Schemata, Tabellen, Views, Spalten, Indizes, Schlüssel, Routinen; lädt Äste erst beim Aufklappen; **Filter beim Tippen**; als GuiExpert-Baumtabelle auch bei 50 000 Objekten flüssig | DataGrip, HeidiSQL | L | 1 | ☑ [008](../prompts/done/008-schema-baum.md) |
| B2 | **Springen zu allem** (`Strg/Cmd+P`): ein Feld, unscharfe Suche über alle Tabellen, Views, Routinen, gespeicherte Abfragen, offene Tabs | DataGrip, TablePlus | M | 2 | ☑ [020](../prompts/done/020-springen-zu-allem.md) |
| B3 | **Objekt-Details**: Spalten mit Typ/Default/Kommentar, Indizes, Constraints, Trigger; **DDL anzeigen und kopieren**; Zeilenzahl und Größe | DBeaver, Postico | M | 2 | ☑ [019](../prompts/done/019-objekt-details.md) |
| B4 | **Suche auf dem Server**: einen Text in allen Tabellen (Daten) und in Routinen/Views (Quelltext) finden, als abbrechbarer Job mit Treffer-Tab | HeidiSQL, DataGrip | M | 3 | ☑ [036](../prompts/036-server-suche.md) |
| B5 | **ER-Diagramm** einer Tabelle mit ihren Nachbarn bzw. eines Schemas | DBeaver | L | 3 | ☑ [037](../prompts/037-er-diagramm.md) |
| B6 | **Schema-Vergleich** zweier Datenbanken mit Migrationsskript | DbVisualizer, Navicat | L | 3 | ☑ [038](../prompts/038-schema-vergleich.md) |

### C – SQL-Editor

| Id | Feature | Vorbild | Umfang | Stufe | Freigabe |
|---|---|---|---|---|---|
| C1 | **Abfrage-Tabs**, jeder mit eigener Verbindung; Inhalt wird laufend gesichert und ist nach einem Neustart wieder da – **nie eine „Speichern?“-Frage**; Tabs benennen, als Datei speichern/öffnen | DataGrip (Konsolen), TablePlus | M | 1 | ☑ [004](../prompts/done/004-abfrage-tabs.md) |
| C2 | **Ausführen**: Anweisung unter dem Cursor, Auswahl, ganzes Skript; mehrere Ergebnisse; **Abbrechen** auf dem Server; Laufzeit und betroffene Zeilen; Skript bei Fehler anhalten oder weiterlaufen | alle | M | 1 | ☑ [005](../prompts/done/005-ausfuehren.md) |
| C3 | **Vervollständigung, die das Schema kennt**: Tabellen, Spalten (auch über Aliase), Funktionen, Schlüsselwörter je Dialekt; `JOIN`-Vorschläge aus Fremdschlüsseln; `*` zu Spaltenliste aufklappen. *Braucht in editlicious eine Schnittstelle für Vorschläge von außen.* | DataGrip | L | 2 | ☑ [021](../prompts/done/021-vervollstaendigung.md) |
| C4 | **Fehler an der Stelle**: Position der Fehlermeldung im Editor markieren, dorthin springen; Meldung des Servers vollständig (Hinweis, Detail, Kontext) | pgAdmin, DataGrip | M | 2 | ☑ [022](../prompts/done/022-fehler-im-editor.md) |
| C5 | **SQL formatieren** (Auswahl oder alles), Stil einstellbar; Groß-/Kleinschreibung der Schlüsselwörter | DataGrip, Beekeeper | S–M | 2 | ☑ [023](../prompts/done/023-sql-formatieren.md) |
| C6 | **Verlauf** aller ausgeführten Anweisungen je Verbindung mit Zeit, Dauer, Zeilen, Fehler; durchsuchbar; zurück in den Editor | DBeaver, Beekeeper | M | 1 | ☑ [010](../prompts/done/010-verlauf.md) |
| C7 | **Gespeicherte Abfragen und Snippets** mit Ordnern, Kürzeln und Platzhaltern (`sel` → `SELECT * FROM ▮`) | TablePlus, SSMS | M | 2 | ☑ [024](../prompts/done/024-snippets-gespeicherte-abfragen.md) |
| C8 | **Parameter** in Abfragen (`:name`, `$1`, `?`): Eingabefeld je Parameter, Werte werden gemerkt, immer gebunden gesendet | DbVisualizer, DataGrip | S–M | 2 | ☑ [025](../prompts/done/025-parameter.md) |
| C9 | **Ausführungsplan**: `EXPLAIN (ANALYZE)` als Baumtabelle mit Kosten, Zeit, Zeilen; teuerste Knoten hervorgehoben | pgAdmin, SSMS | M–L | 3 | ☑ [039](../prompts/039-ausfuehrungsplan.md) |
| C10 | **Transaktionen sichtbar**: Auto-Commit je Tab umschaltbar, Knöpfe Commit/Rollback, deutliche Anzeige einer offenen Transaktion, Warnung beim Schließen | DataGrip, SQL Developer | M | 2 | ☑ [013](../prompts/done/013-transaktionen.md) |

### D – Ergebnisgitter

| Id | Feature | Vorbild | Umfang | Stufe | Freigabe |
|---|---|---|---|---|---|
| D1 | **Große Ergebnisse**: Rust streamt vom Server, das Gitter lädt beim Scrollen nach; Millionen Zeilen ohne Einfrieren; Abbruch jederzeit; Speichergrenze mit Auslagern auf die Platte. *Unser deutlichster Vorteil gegenüber allen anderen.* | – (DataGrip blättert seitenweise) | L | 1 | ☑ [006](../prompts/done/006-grosse-ergebnisse.md) |
| D2 | **Zellen richtig zeigen**: `NULL` sichtbar und von leerem Text unterscheidbar, Zahlen rechts, Datum/Zeit lesbar, Boolean, JSON gekürzt, BLOB als Größe; Typ im Spaltenkopf | TablePlus, DataGrip | M | 1 | ☑ [007](../prompts/done/007-zell-darstellung.md) |
| D3 | **Wert-Ansicht**: Seitenfeld für die aktuelle Zelle – langer Text und **JSON formatiert in editlicious**, Bild, Hex für Binärdaten | DBeaver | M | 2 | ☑ [026](../prompts/026-wert-ansicht.md) |
| D4 | **Zeile als Formular** (eine Zeile, Felder untereinander) für breite Tabellen | DBeaver, DbGate | S–M | 3 | ☑ [040](../prompts/040-zeilen-formular.md) |
| D5 | **Sortieren und Filtern**: im geladenen Ergebnis sofort; bei Tabellen als `WHERE`/`ORDER BY` an den Server; **Schnellfilter aus der Zelle** („nur dieser Wert“, „ohne diesen Wert“) | TablePlus, HeidiSQL | M | 2 | ☑ [027](../prompts/027-sortieren-filtern.md) |
| D6 | **Kopieren als …**: TSV (für Excel), CSV, JSON, Markdown-Tabelle, `INSERT`-Anweisungen, `IN (…)`-Liste; mit oder ohne Kopfzeile | DataGrip (Extraktoren) | S–M | 1 | ☑ [009](../prompts/done/009-kopieren-als.md) |
| D7 | **Auswahl auswerten**: Anzahl, Summe, Mittel, Min, Max der markierten Zellen in der Statuszeile | DataGrip, Excel | S | 2 | ☑ [028](../prompts/028-auswahl-auswerten.md) |
| D8 | **Spalten**: fixieren, ausblenden, verschieben, Breite merken; **Suchen im Ergebnis** mit Treffer-Sprung | DBeaver | S–M | 2 | ☑ [029](../prompts/029-spalten-suche.md) |
| D9 | **Mehrere Ergebnisse** als Unter-Tabs; Ergebnis **anpinnen**, damit die nächste Ausführung es nicht ersetzt; **zwei Ergebnisse vergleichen** (Unterschiede farbig) | DataGrip | M | 3 | ☑ [041](../prompts/041-ergebnisse-vergleichen.md) |
| D10 | **Fremdschlüssel folgen**: von einer Zelle zur referenzierten Zeile springen; Zeilen anzeigen, die auf diese Zeile zeigen | DataGrip, DbGate | M | 2 | ☑ [030](../prompts/030-fremdschluessel-folgen.md) |
| D11 | **Diagramm aus dem Ergebnis** (Linie, Balken, Zeitreihe); Tokens `--chart-1…8` gibt es schon | Azure Data Studio, DBeaver | M | 3 | ☑ [042](../prompts/042-diagramme.md) |

### E – Daten und Struktur bearbeiten

| Id | Feature | Vorbild | Umfang | Stufe | Freigabe |
|---|---|---|---|---|---|
| E1 | **Tabelle öffnen und direkt bearbeiten, Änderungen sammeln**: geänderte Zellen farbig, **SQL-Vorschau** aller Änderungen, dann gemeinsam schreiben oder verwerfen (`Strg/Cmd+S`); nur mit Primärschlüssel, sonst klarer Hinweis | TablePlus | L | 2 | ☑ [031](../prompts/031-daten-bearbeiten.md) |
| E2 | **Zeilen** einfügen, duplizieren, löschen; `NULL`/Default setzen; **Block aus Excel einfügen** | TablePlus, Postico | M | 2 | ☑ [032](../prompts/032-zeilen-bearbeiten.md) |
| E3 | **Struktur bearbeiten**: Spalten, Indizes, Fremdschlüssel in Tabellenform mit **DDL-Vorschau** vor dem Ausführen | HeidiSQL, TablePlus | L | 3 | ☑ [043](../prompts/043-struktur-bearbeiten.md) |

### F – Import und Export

| Id | Feature | Vorbild | Umfang | Stufe | Freigabe |
|---|---|---|---|---|---|
| F1 | **Export** eines Ergebnisses oder einer Tabelle: CSV, TSV, JSON, NDJSON, Excel, `INSERT`-Skript, Markdown – als Job mit Fortschritt und Abbruch, direkt vom Server in die Datei (nicht über das Gitter) | DataGrip, DBeaver | M | 1 | ☑ [011](../prompts/done/011-export.md) |
| F2 | **Import** von CSV/JSON in eine Tabelle: Vorschau, Spalten zuordnen, Typen erkennen, Tabelle anlegen, Fehlerzeilen protokollieren | DataGrip, Navicat | M–L | 2 | ☑ [033](../prompts/033-import.md) |
| F3 | **Sichern und Wiederherstellen** über die Werkzeuge der Datenbank (`pg_dump`, `mysqldump`) mit Dialog | TablePlus, DBeaver | M | 3 | ☑ [044](../prompts/044-sichern-wiederherstellen.md) |
| F4 | **Daten zwischen Datenbanken kopieren** (Tabelle → andere Verbindung) | DBeaver, Navicat | L | 3 | ☑ [045](../prompts/045-daten-kopieren.md) |

### G – Bedienung und Rahmen

| Id | Feature | Vorbild | Umfang | Stufe | Freigabe |
|---|---|---|---|---|---|
| G1 | **Aktionssystem**: jede Funktion ist eine Aktion; Keymap je Betriebssystem, Kürzel-Editor, **Befehlspalette** (`Strg/Cmd+Shift+P`) – Übernahme aus files-and-folders/log-commander. Grundlage für alle Tastaturbedienung | fnf, VS Code | M | 1 | ☑ [002](../prompts/done/002-aktionen-tastatur.md) |
| G2 | **Arbeitsbereich**: Tab-Leiste, geteilte Ansicht (zwei Abfragen nebeneinander), Sitzung nach Neustart wiederherstellen | DataGrip, TablePlus | M | 2 | ☑ [016](../prompts/done/016-arbeitsbereich.md) |
| G3 | **Einstellungen und Sprache**: Dialog, Deutsch/Englisch zur Laufzeit (Text-Kataloge wie in fnf) | fnf | M | 2 | ☑ [017](../prompts/done/017-einstellungen-sprache.md) |
| G4 | **Menüleiste** (nativ) und **Kontextmenüs** aus einem Menümodell | fnf | S–M | 2 | ☑ [018](../prompts/done/018-menues.md) |
| G5 | **Farbschemata fertig machen**: Editor folgt allen 17 Schemata (seine Farben aus unseren Tokens), Live-Editor für eigene Schemata, Import/Export – wie in fnf | fnf | S–M | 2 | ☑ [001](../prompts/done/001-theme.md) |
| G6 | **Release**: Pakete je System, Signierung, Auto-Update, Lizenzhinweise, About | fnf | M | 2 | ☑ [034](../prompts/034-release.md) |

### H – Verwaltung und Extras

| Id | Feature | Vorbild | Umfang | Stufe | Freigabe |
|---|---|---|---|---|---|
| H1 | **Server-Monitor**: laufende Sitzungen und Abfragen, Sperren, Abfrage beenden; aktualisiert sich | HeidiSQL, pgAdmin | M | 3 | ☑ [046](../prompts/046-server-monitor.md) |
| H2 | **Benutzer und Rechte** verwalten | HeidiSQL, Navicat | L | 3 | ☑ [047](../prompts/047-benutzer-rechte.md) |
| H3 | **KI-Anbindung über MCP** wie in log-commander und editlicious: ein Assistent darf (nach Freigabe) Schema lesen, Abfragen vorschlagen und ausführen; dazu „Abfrage erklären“ und „Text → SQL“ | DataGrip AI, eigene Projekte | M–L | 3 | ☑ [048](../prompts/048-mcp-ki.md) |
| H4 | **Testdaten erzeugen** für eine Tabelle | DBeaver, DataGrip | M | 3 | ☑ [049](../prompts/049-testdaten.md) |

## 3. Was ich nicht bauen würde

- **Cloud-Konto, Team-Sync, Lizenzserver** – widerspricht „schnell, lokal, frei“.
- **Notebooks** – Azure Data Studio wurde damit nicht glücklich; gespeicherte Abfragen mit Ergebnissen decken den
  Bedarf.
- **Visueller Abfrage-Baukasten** – viel Aufwand, wenig genutzt; gute Vervollständigung bringt mehr.
- **Debugger für Stored Procedures** – je Datenbank ein eigenes Projekt.
- **NoSQL** (MongoDB, Redis) – anderes Datenmodell, verwässert das Werkzeug.

## 4. Empfohlene Reihenfolge

**Stufe 1 – daraus wird ein benutzbares SQL-Tool** (in dieser Reihenfolge):

1. **G1** Aktionssystem und Befehlspalette (alles Weitere hängt seine Tastenkürzel daran)
2. **A1 + A2** Verbindungen und Schlüsselbund (PostgreSQL und SQLite zuerst, dann MySQL, SQL Server)
3. **C1 + C2** Abfrage-Tabs und Ausführen
4. **D1 + D2** große Ergebnisse und Zell-Darstellung
5. **B1** Schema-Baum
6. **D6**, **C6**, **F1** Kopieren als, Verlauf, Export

**Stufe 2 – macht es besser als die anderen:** A4 Schutz für Produktion · C3 Vervollständigung · E1/E2 Bearbeiten mit
Vorschau · D5 Filter · D10 Fremdschlüssel folgen · C10 Transaktionen · B2 Springen zu allem · dann der Rest.

**Stufe 3** nach Bedarf.

## 5. Was dafür in den eigenen Bausteinen fehlt

> Stand 11.11.2026: Die fünf Punkte zu editlicious sind mit `editlicious-editor` 1.2.0 erledigt (`scheme="none"` und
> alle Farben als Variablen, `getSelection`/`getRange`/`replaceRange`, `completionProvider`, `setMarkers`,
> `insertSnippet`/`snippets`).

| Baustein | Fehlt | Gebraucht für |
|---|---|---|
| editlicious-editor | markierten Text bzw. Auswahlbereich abfragen | C2 (Auswahl ausführen) |
| editlicious-editor | Vorschläge von außen (Anbieter für Vervollständigung) | C3 |
| editlicious-editor | Markierungen/Unterstreichungen von außen setzen (Fehlerstelle) | C4 |
| editlicious-editor | Farben vollständig von außen setzen (alle `--ed-*`), damit er jedem Schema folgt | G5 |
| editlicious-editor | Snippets mit Platzhaltern | C7 |
| GuiExpert Table | im Skeleton aufgefallen: Zeilenhöhe aus `defaultRowHeights` und Ausrichtung der Zellen prüfen | D2 |

Für editlicious gibt es dazu eigene Prompts (E1–E5, `prompts/done/editlicious/`). Die Punkte der GuiExpert Table werden
in den Design-Dokumenten geprüft und als Vorschläge fürs Mono-Repo formuliert.

## 6. Prompts

Alle Features sind freigegeben; die Prompts 001–049 liegen in `prompts/`, die Erweiterungen an editlicious als
E1–E5 in `prompts/done/editlicious/` (Index: [`prompts/README.md`](../prompts/README.md)). A1 und A2 teilen sich
Prompt 003. Prompt 001 ist auf Marcs Wunsch das Farbschema (G5).
