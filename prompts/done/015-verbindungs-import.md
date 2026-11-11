# Prompt 015: Verbindung aus URL und Import aus anderen Werkzeugen

> **Slug:** `verbindungs-import` · **Feature:** A5 · **Braucht:** 003 (014 für SSH-Angaben) · **Umfang:** S–M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: TablePlus („Import from URL“).

## Ziel

Der Umstieg kostet Minuten: eine Verbindungs-URL einfügen, oder die vorhandenen Verbindungen aus anderen Werkzeugen
und Konfigurationsdateien übernehmen.

## Aufgaben

1. **URL einfügen**: `postgres://`, `postgresql://`, `mysql://`, `mariadb://`, `sqlserver://`/ADO-Zeichenkette,
   `sqlite:`/Dateipfad, JDBC-Formen (`jdbc:postgresql://…`). Füllt den Verbindungsdialog; ein Passwort in der URL geht
   in den Schlüsselbund oder wird verworfen, nie ins Profil. Auch per Zwischenablage erkannt („Verbindung aus
   Zwischenablage anlegen?“) und per Datei-Drop einer `.sqlite`/`.db`-Datei.
2. **Import** mit Vorschau (Liste, Häkchen, Konflikte): DBeaver (`data-sources.json`), DataGrip
   (`dataSources.xml`/`.local.xml`), TablePlus (Export-Datei), `~/.pgpass`, `pg_service.conf`, `~/.my.cnf`,
   Umgebungsvariablen `PG*`/`MYSQL_*`. Format je Quelle im Design aus echten Beispieldateien belegen.
3. **Passwörter**: nur übernehmen, wo sie im Klartext lesbar und vom Nutzer ausdrücklich angehakt sind (`.pgpass`);
   verschlüsselte Ablagen anderer Werkzeuge werden nicht geknackt – der Nutzer gibt das Passwort beim ersten
   Verbinden ein.
4. **Export/Import eigener Profile** als Datei (ohne Geheimnisse) für den Umzug auf einen anderen Rechner.
5. Fremde Dateien sind feindlich: Größe begrenzen, XML ohne externe Entitäten, nichts aus der Datei wird ausgeführt.

## Akzeptanzkriterien

- Jede URL-Form aus dem Testkatalog füllt den Dialog richtig (Sonderzeichen im Passwort, IPv6, Optionen, fehlender
  Port).
- Import aus mindestens DBeaver, DataGrip und `.pgpass` mit Beispieldateien im Test; doppelte Namen werden gemeldet.
- Nach dem Import steht in keiner unserer Dateien ein Passwort.

## Tests

Rein/Rust: Parser-Katalog je Quelle, kaputte und bösartige Dateien. Frontend: Vorschau-Dialog mit Fake.
