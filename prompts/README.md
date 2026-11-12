# Feature-Prompts – Schema Commander

Arbeitsaufträge für die Weiterentwicklung, jeweils für **eine neue Claude-Sitzung** im Repo. Jeder Prompt führt in
Phasen vom Design über Rust- und Frontend-Tests bis zur Ende-zu-Ende-Prüfung und hält nach dem Design an (Freigabe).
Gemeinsame Regeln: [000-arbeitsweise.md](000-arbeitsweise.md).

**So startet man einen Prompt:** neue Sitzung im Repo, dann z. B.
„Lies `prompts/000-arbeitsweise.md` und führe `prompts/002-aktionen-tastatur.md` aus.“

**Erledigte Prompts** wandern samt `*.design.md` nach [`done/`](done/).

Herkunft: [`docs/feature-analysis.md`](../docs/feature-analysis.md) (Ids A1–H4, von Marc am 10.11.2026 alle
freigegeben). **Die Nummern sind die Ausführungsreihenfolge**: Jeder Prompt braucht nur Prompts mit kleinerer Nummer
(Spalte „Braucht“). Innerhalb einer Stufe kann vorgezogen werden, was seine Abhängigkeiten erfüllt.

**Erweiterungen an editlicious** (E1–E5) sind eigene Prompts unter [`done/editlicious/`](done/editlicious/README.md) und
wurden im Repo `../editlicious` umgesetzt (dort Prompts 026–030) und sind seit `editlicious-editor` **1.2.0**
verfügbar. Die Schnittstellen stehen in `node_modules/editlicious-editor/README.md` und `editlicious-editor.d.ts`.

| Nr. | Prompt | Feature | Braucht | Umfang | Status |
|---|---|---|---|---|---|
| 000 | [Gemeinsame Arbeitsweise](000-arbeitsweise.md) | – | – | – | – |
| | **Stufe 1 – daraus wird ein benutzbares SQL-Tool** | | | | |
| 001 | [Farbschemata fertig machen](done/001-theme.md) ([Design](done/001-theme.design.md)) | G5 | E1 (editlicious: Farben von außen) | S–M | ✅ 11.11.2026 |
| 002 | [Aktionssystem, Tastatur, Befehlspalette](done/002-aktionen-tastatur.md) ([Design](done/002-aktionen-tastatur.design.md)) | G1 | – | M | ✅ 11.11.2026 |
| 003 | [Verbindungen und Schlüsselbund](done/003-verbindungen.md) ([Design](done/003-verbindungen.design.md)) | A1, A2 | 002 | L | ✅ 11.11.2026 |
| 004 | [Abfrage-Tabs](done/004-abfrage-tabs.md) ([Design](done/004-abfrage-tabs.design.md)) | C1 | 002, 003 | M | ✅ 11.11.2026 |
| 005 | [Anweisungen ausführen](done/005-ausfuehren.md) ([Design](done/005-ausfuehren.design.md)) | C2 | 003, 004, E2 (editlicious: Auswahl abfragen) | M | ✅ 11.11.2026 |
| 006 | [Große Ergebnisse](done/006-grosse-ergebnisse.md) ([Design](done/006-grosse-ergebnisse.design.md)) | D1 | 005 | L | ✅ 11.11.2026 |
| 007 | [Zellen richtig zeigen](done/007-zell-darstellung.md) ([Design](done/007-zell-darstellung.design.md)) | D2 | 003, 006 | M | ✅ 11.11.2026 |
| 008 | [Schema-Baum](done/008-schema-baum.md) ([Design](done/008-schema-baum.design.md)) | B1 | 002, 003 | L | ✅ 11.11.2026 |
| 009 | [Kopieren als …](done/009-kopieren-als.md) ([Design](done/009-kopieren-als.design.md)) | D6 | 007 | S–M | ✅ 11.11.2026 |
| 010 | [Abfrage-Verlauf](done/010-verlauf.md) ([Design](done/010-verlauf.design.md)) | C6 | 005 | M | ✅ 11.11.2026 |
| 011 | [Export](done/011-export.md) ([Design](done/011-export.design.md)) | F1 | 005, 009 | M | ✅ 11.11.2026 |
| | **Stufe 2 – macht es gut** | | | | |
| 012 | [Schutz für Produktion](done/012-produktionsschutz.md) ([Design](done/012-produktionsschutz.design.md)) | A4 | 003, 005 | M | ✅ 11.11.2026 |
| 013 | [Transaktionen sichtbar machen](done/013-transaktionen.md) ([Design](done/013-transaktionen.design.md)) | C10 | 005 | M | ✅ 11.11.2026 |
| 014 | [SSH-Tunnel und TLS](done/014-ssh-tls.md) ([Design](done/014-ssh-tls.design.md)) | A3 | 003 | M | ✅ 11.11.2026 |
| 015 | [Verbindung aus URL und Import aus anderen Werkzeugen](done/015-verbindungs-import.md) ([Design](done/015-verbindungs-import.design.md)) | A5 | 003 (014 für SSH-Angaben) | S–M | ✅ 11.11.2026 |
| 016 | [Arbeitsbereich – geteilte Ansicht und Sitzung](done/016-arbeitsbereich.md) ([Design](done/016-arbeitsbereich.design.md)) | G2 | 004 | M | ✅ 11.11.2026 |
| 017 | [Einstellungen und Sprache](done/017-einstellungen-sprache.md) ([Design](done/017-einstellungen-sprache.design.md)) | G3 | 002 | M | ✅ 11.11.2026 |
| 018 | [Menüleiste und Kontextmenüs](done/018-menues.md) ([Design](done/018-menues.design.md)) | G4 | 002 (017 für Übersetzung) | S–M | ✅ 11.11.2026 |
| 019 | [Objekt-Details und DDL](done/019-objekt-details.md) ([Design](done/019-objekt-details.design.md)) | B3 | 008 | M | ✅ 11.11.2026 |
| 020 | [Springen zu allem](done/020-springen-zu-allem.md) ([Design](done/020-springen-zu-allem.design.md)) | B2 | 002, 008 | M | ✅ 11.11.2026 |
| 021 | [Vervollständigung, die das Schema kennt](done/021-vervollstaendigung.md) ([Design](done/021-vervollstaendigung.design.md)) | C3 | 008, E3 (editlicious: Vorschläge von außen), besser auch E5 | L | ✅ 11.11.2026 |
| 022 | [Fehler an der Stelle zeigen](done/022-fehler-im-editor.md) ([Design](done/022-fehler-im-editor.design.md)) | C4 | 005, E4 (editlicious: Markierungen von außen) | M | ✅ 11.11.2026 |
| 023 | [SQL formatieren](done/023-sql-formatieren.md) ([Design](done/023-sql-formatieren.design.md)) | C5 | 002, E2 (editlicious: Bereich ersetzen) | S–M | ✅ 11.11.2026 |
| 024 | [Gespeicherte Abfragen und Snippets](done/024-snippets-gespeicherte-abfragen.md) ([Design](done/024-snippets-gespeicherte-abfragen.design.md)) | C7 | 004, E5 (editlicious: Snippets) | M | ✅ 11.11.2026 |
| 025 | [Parameter in Abfragen](done/025-parameter.md) ([Design](done/025-parameter.design.md)) | C8 | 005 | S–M | ✅ 11.11.2026 |
| 026 | [Wert-Ansicht](done/026-wert-ansicht.md) ([Design](done/026-wert-ansicht.design.md)) | D3 | 006, 007 | M | ✅ 11.11.2026 |
| 027 | [Sortieren und Filtern](done/027-sortieren-filtern.md) ([Design](done/027-sortieren-filtern.design.md)) | D5 | 006, 007, 008 | M | ✅ 11.11.2026 |
| 028 | [Auswahl auswerten](done/028-auswahl-auswerten.md) ([Design](done/028-auswahl-auswerten.design.md)) | D7 | 007 | S | ✅ 11.11.2026 |
| 029 | [Spalten verwalten und im Ergebnis suchen](done/029-spalten-suche.md) ([Design](done/029-spalten-suche.design.md)) | D8 | 006, 007 | S–M | ✅ 11.11.2026 |
| 030 | [Fremdschlüsseln folgen](done/030-fremdschluessel-folgen.md) ([Design](done/030-fremdschluessel-folgen.design.md)) | D10 | 008, 027 | M | ✅ 11.11.2026 |
| 031 | [Daten bearbeiten mit Änderungsvorschau](done/031-daten-bearbeiten.md) ([Design](done/031-daten-bearbeiten.design.md)) | E1 | 007, 012, 013, 027 | L | ✅ 11.11.2026 |
| 032 | [Zeilen einfügen, duplizieren, löschen, Block einfügen](done/032-zeilen-bearbeiten.md) ([Design](done/032-zeilen-bearbeiten.design.md)) | E2 | 031 | M | ✅ 11.11.2026 |
| 033 | [Import aus CSV und JSON](done/033-import.md) ([Design](done/033-import.design.md)) | F2 | 008, 011 | M–L | ✅ 12.11.2026 |
| 034 | [Release und Verteilung](done/034-release.md) ([Design](done/034-release.design.md)) | G6 | – (sinnvoll nach Stufe 1) | M | ✅ 12.11.2026 (vorbereitet; kein Tag, kein Paket) |
| | **Stufe 3 – nach Bedarf** | | | | |
| 035 | [Weitere Datenbanken](035-weitere-datenbanken.md) ([Design 035a](035a-postgres-protokoll.design.md)) | A6 | 003, 008 | L (je Treiber S–M) | teilweise: 035a ✅ 12.11.2026 (CockroachDB, TimescaleDB, Flags); übrige Datenbanken offen |
| 036 | [Suche auf dem Server](done/036-server-suche.md) ([Design](done/036-server-suche.design.md)) | B4 | 008, 011 (Job-Engine) | M | ✅ 12.11.2026 |
| 037 | [ER-Diagramm](done/037-er-diagramm.md) ([Design](done/037-er-diagramm.design.md)) | B5 | 008, 019 | L | ✅ 12.11.2026 |
| 038 | [Schema-Vergleich](done/038-schema-vergleich.md) ([Design](done/038-schema-vergleich.design.md)) | B6 | 019 | L | ✅ 12.11.2026 |
| 039 | [Ausführungsplan](done/039-ausfuehrungsplan.md) ([Design](done/039-ausfuehrungsplan.design.md)) | C9 | 005, 012 | M–L | ✅ 12.11.2026 |
| 040 | [Zeile als Formular](done/040-zeilen-formular.md) ([Design](done/040-zeilen-formular.design.md)) | D4 | 007 (026 und 031 für Wert-Ansicht/Bearbeiten) | S–M | ✅ 12.11.2026 |
| 041 | [Mehrere Ergebnisse, Anpinnen, Vergleichen](done/041-ergebnisse-vergleichen.md) ([Design](done/041-ergebnisse-vergleichen.design.md)) | D9 | 005, 006 | M | ✅ 12.11.2026 |
| 042 | [Diagramm aus dem Ergebnis](done/042-diagramme.md) ([Design](done/042-diagramme.design.md)) | D11 | 006 | M | ✅ 12.11.2026 |
| 043 | [Struktur bearbeiten](043-struktur-bearbeiten.md) | E3 | 012, 019 | L | ✅ editlicious 028, in `editlicious-editor` 1.2.0 |
| 044 | [Sichern und Wiederherstellen](044-sichern-wiederherstellen.md) | F3 | 003, 011 (Job-Engine), 012 | M | offen |
| 045 | [Daten zwischen Datenbanken kopieren](045-daten-kopieren.md) | F4 | 011, 033, 043 | L | offen |
| 046 | [Server-Monitor](046-server-monitor.md) | H1 | 003, 012 | M | offen |
| 047 | [Benutzer und Rechte](047-benutzer-rechte.md) | H2 | 012, 019 | L | offen |
| 048 | [KI-Anbindung über MCP](048-mcp-ki.md) | H3 | 005, 008, 012 | M–L | offen |
| 049 | [Testdaten erzeugen](049-testdaten.md) | H4 | 008, 012, 033 | M | offen |

## editlicious

| Nr. | Prompt | Gebraucht von | Status |
|---|---|---|---|
| E1 | [Farben von außen](done/editlicious/E1-farben-von-aussen.md) | 001 | ✅ editlicious 026, in `editlicious-editor` 1.2.0 |
| E2 | [Auswahl und Bereiche abfragen](done/editlicious/E2-auswahl-abfragen.md) | 005, 023 | ✅ editlicious 027, in `editlicious-editor` 1.2.0 |
| E3 | [Vervollständigung von außen](done/editlicious/E3-vervollstaendigung-von-aussen.md) | 021 | ✅ editlicious 028, in `editlicious-editor` 1.2.0 |
| E4 | [Markierungen von außen](done/editlicious/E4-markierungen-von-aussen.md) | 022 | ✅ editlicious 029, in `editlicious-editor` 1.2.0 |
| E5 | [Textbausteine mit Platzhaltern](done/editlicious/E5-snippets.md) | 024 | ✅ editlicious 030, in `editlicious-editor` 1.2.0 |
