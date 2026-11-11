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
| 005 | [Anweisungen ausführen](005-ausfuehren.md) | C2 | 003, 004, E2 (editlicious: Auswahl abfragen) | M | offen |
| 006 | [Große Ergebnisse](006-grosse-ergebnisse.md) | D1 | 005 | L | offen |
| 007 | [Zellen richtig zeigen](007-zell-darstellung.md) | D2 | 003, 006 | M | offen |
| 008 | [Schema-Baum](008-schema-baum.md) | B1 | 002, 003 | L | offen |
| 009 | [Kopieren als …](009-kopieren-als.md) | D6 | 007 | S–M | offen |
| 010 | [Abfrage-Verlauf](010-verlauf.md) | C6 | 005 | M | offen |
| 011 | [Export](011-export.md) | F1 | 005, 009 | M | offen |
| | **Stufe 2 – macht es gut** | | | | |
| 012 | [Schutz für Produktion](012-produktionsschutz.md) | A4 | 003, 005 | M | offen |
| 013 | [Transaktionen sichtbar machen](013-transaktionen.md) | C10 | 005 | M | offen |
| 014 | [SSH-Tunnel und TLS](014-ssh-tls.md) | A3 | 003 | M | offen |
| 015 | [Verbindung aus URL und Import aus anderen Werkzeugen](015-verbindungs-import.md) | A5 | 003 (014 für SSH-Angaben) | S–M | offen |
| 016 | [Arbeitsbereich – geteilte Ansicht und Sitzung](016-arbeitsbereich.md) | G2 | 004 | M | offen |
| 017 | [Einstellungen und Sprache](017-einstellungen-sprache.md) | G3 | 002 | M | offen |
| 018 | [Menüleiste und Kontextmenüs](018-menues.md) | G4 | 002 (017 für Übersetzung) | S–M | offen |
| 019 | [Objekt-Details und DDL](019-objekt-details.md) | B3 | 008 | M | offen |
| 020 | [Springen zu allem](020-springen-zu-allem.md) | B2 | 002, 008 | M | offen |
| 021 | [Vervollständigung, die das Schema kennt](021-vervollstaendigung.md) | C3 | 008, E3 (editlicious: Vorschläge von außen), besser auch E5 | L | offen |
| 022 | [Fehler an der Stelle zeigen](022-fehler-im-editor.md) | C4 | 005, E4 (editlicious: Markierungen von außen) | M | offen |
| 023 | [SQL formatieren](023-sql-formatieren.md) | C5 | 002, E2 (editlicious: Bereich ersetzen) | S–M | offen |
| 024 | [Gespeicherte Abfragen und Snippets](024-snippets-gespeicherte-abfragen.md) | C7 | 004, E5 (editlicious: Snippets) | M | offen |
| 025 | [Parameter in Abfragen](025-parameter.md) | C8 | 005 | S–M | offen |
| 026 | [Wert-Ansicht](026-wert-ansicht.md) | D3 | 006, 007 | M | offen |
| 027 | [Sortieren und Filtern](027-sortieren-filtern.md) | D5 | 006, 007, 008 | M | offen |
| 028 | [Auswahl auswerten](028-auswahl-auswerten.md) | D7 | 007 | S | offen |
| 029 | [Spalten verwalten und im Ergebnis suchen](029-spalten-suche.md) | D8 | 006, 007 | S–M | offen |
| 030 | [Fremdschlüsseln folgen](030-fremdschluessel-folgen.md) | D10 | 008, 027 | M | offen |
| 031 | [Daten bearbeiten mit Änderungsvorschau](031-daten-bearbeiten.md) | E1 | 007, 012, 013, 027 | L | ✅ editlicious 026, in `editlicious-editor` 1.2.0 |
| 032 | [Zeilen einfügen, duplizieren, löschen, Block einfügen](032-zeilen-bearbeiten.md) | E2 | 031 | M | ✅ editlicious 027, in `editlicious-editor` 1.2.0 |
| 033 | [Import aus CSV und JSON](033-import.md) | F2 | 008, 011 | M–L | offen |
| 034 | [Release und Verteilung](034-release.md) | G6 | – (sinnvoll nach Stufe 1) | M | offen |
| | **Stufe 3 – nach Bedarf** | | | | |
| 035 | [Weitere Datenbanken](035-weitere-datenbanken.md) | A6 | 003, 008 | L (je Treiber S–M) | offen |
| 036 | [Suche auf dem Server](036-server-suche.md) | B4 | 008, 011 (Job-Engine) | M | offen |
| 037 | [ER-Diagramm](037-er-diagramm.md) | B5 | 008, 019 | L | offen |
| 038 | [Schema-Vergleich](038-schema-vergleich.md) | B6 | 019 | L | offen |
| 039 | [Ausführungsplan](039-ausfuehrungsplan.md) | C9 | 005, 012 | M–L | offen |
| 040 | [Zeile als Formular](040-zeilen-formular.md) | D4 | 007 (026 und 031 für Wert-Ansicht/Bearbeiten) | S–M | offen |
| 041 | [Mehrere Ergebnisse, Anpinnen, Vergleichen](041-ergebnisse-vergleichen.md) | D9 | 005, 006 | M | offen |
| 042 | [Diagramm aus dem Ergebnis](042-diagramme.md) | D11 | 006 | M | offen |
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
