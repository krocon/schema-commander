# Prompt 008: Schema-Baum

> **Slug:** `schema-baum` · **Feature:** B1 · **Braucht:** 002, 003 · **Umfang:** L
> Lies zuerst `prompts/000-arbeitsweise.md`, `llms.txt` der GuiExpert Table (Baum: `table-tree.css`, Tree-Modell).
> Vorbild: DataGrip (Filter, Tiefe), HeidiSQL (Tempo).

## Ziel

Die Seitenleiste zeigt, was in der Datenbank ist: Verbindung → Datenbanken → Schemata → Tabellen, Views,
materialisierte Views, Routinen, Sequenzen, Typen → Spalten, Indizes, Schlüssel, Trigger. Schnell auch bei 50 000
Objekten, mit **Filter beim Tippen**.

## Aufgaben

1. **Metadaten je Treiber** (Erweiterung des Treiber-Traits): Listen der Objektarten aus dem Systemkatalog
   (`pg_catalog`/`information_schema`, MySQL `information_schema`, SQL Server `sys.*`, SQLite `sqlite_schema` +
   Pragmas). Tabelle „Objektart × Datenbank“ im Design. Abfragen parametrisiert, mit Zeitlimit, abbrechbar.
2. **Laden bei Bedarf**: Äste erst beim Aufklappen; Spalten/Indizes einer Tabelle zusammen. Zwischenspeicher je
   Verbindung in Rust mit „Aktualisieren“ (Ast oder alles); nach DDL aus dem Editor den betroffenen Ast als veraltet
   markieren.
3. **Baum als GuiExpert Table** (virtuell, Tastatur nach APG „tree“): Icons je Art, Zusatzspalte/Detail (Typ,
   Zeilenzahl geschätzt), Mehrfachauswahl.
4. **Filter**: Feld über dem Baum, unscharf, zeigt Treffer mit ihren Eltern; auf bereits Geladenes sofort, für
   Ungeladenes eine Namenssuche auf dem Server.
5. **Aktionen** am Knoten (Kontextmenü + Kürzel): Daten öffnen (`SELECT * … LIMIT`), Name in den Editor einfügen
   (richtig gequotet), Name/qualifizierten Namen kopieren, `SELECT`/`INSERT`/`UPDATE`-Vorlage erzeugen, DDL anzeigen
   (ausführlich in Prompt 019), Aktualisieren. Doppelklick und Ziehen in den Editor.
6. **Sichtbarkeit**: Systemschemata ausblenden (Vorgabe), Schemata an-/abwählen, Favoriten; Zustand (aufgeklappt,
   Auswahl) je Verbindung merken.
7. **Quoting je Dialekt** als reine Funktion in Rust (Bezeichner, Schlüsselwörter, Groß-/Kleinschreibung) – wird von
   allen späteren Prompts benutzt.

## Entscheidungsfragen (Design)

- Zeilenzahlen: Schätzung aus der Statistik, exakt auf Wunsch, oder gar nicht?
- Wie viel wird vorab geladen (für Vervollständigung, Prompt 021) gegenüber strikt bei Bedarf?
- Ein Baum für alle Verbindungen oder nur die aktive?

## Akzeptanzkriterien

- Schema mit 20 000 Tabellen: Aufklappen unter 1 s (lokaler Server), Filter reagiert beim Tippen, Scrollen flüssig.
- Bezeichner mit Leerzeichen, Großbuchstaben, Umlauten, Schlüsselwörtern und Anführungszeichen werden richtig
  gequotet eingefügt (Katalog je Dialekt).
- Fehlende Rechte auf einen Ast zeigen eine Meldung am Knoten, der Rest bleibt benutzbar.

## Tests und Review

Rust gegen Container: Metadaten je Objektart, Quoting-Katalog, Rechtefehler. Frontend: Baum-Store mit Fake (Laden,
Filter, veraltete Antworten). Review: alle Katalogabfragen parametrisiert, kein Bezeichner per Verkettung.
