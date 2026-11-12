# Design 044: Sichern und Wiederherstellen

> **Status:** umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/sichern-wiederherstellen` · Auftrag: [044-sichern-wiederherstellen.md](044-sichern-wiederherstellen.md) ·
> Feature F3

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Welche Werkzeuge | PostgreSQL: `pg_dump`, `pg_restore`, `psql`. MySQL/MariaDB: `mysqldump`/`mariadb-dump`, `mysql`/`mariadb`. **SQL Server: keines** – `sqlcmd`/`bcp` sichern keine Datenbank (`BACKUP DATABASE` schreibt auf den Server, nicht auf diesen Rechner); dort gibt es den einfachen Export. **SQLite**: Kopie der Datei mit `VACUUM INTO` (konsistent, auch während sie benutzt wird) | Aufgabe 1; nichts versprechen, was das Werkzeug nicht leistet |
| E2 | Finden | `backup::find`: der eingestellte Pfad (muss absolut sein und genau dieses Programm heißen), sonst `PATH` (relative Einträge werden nie durchsucht), sonst die üblichen Orte je Betriebssystem (Homebrew, `libpq`, Postgres.app, `/usr/lib/postgresql/N/bin`, `Program Files`). Version aus `--version`; ist das Werkzeug älter als der Server, warnt der Dialog. Fehlt es: Meldung mit Hinweis, woher es kommt – nichts wird heruntergeladen | Aufgabe 1 |
| E3 | Start | `std::process::Command` mit Argument-Liste, **nie eine Shell**. Jeder Wert hängt an seiner Option (`--file=…`) oder steht hinter `--`: ein Name, der mit `-` beginnt, wird nie eine Option. Namen für `pg_dump --table/--schema` stehen in doppelten Anführungszeichen (das sind Muster) | Aufgabe 2 |
| E4 | Passwort | nie ein Argument (die Prozessliste zeigt Argumente), nie in der Ausgabe: PostgreSQL bekommt es in der Umgebung **des einen Prozesses** (`PGPASSWORD`), MySQL in einer Datei, die nur der Nutzer lesen kann (`--defaults-extra-file`, mit `create_new` und 0600 in einem Ordner der App mit 0700), die mit dem Prozess verschwindet. Jede Zeile des Werkzeugs läuft durch `scrub` | Aufgabe 2, Akzeptanzkriterium 2 |
| E5 | Wohin es sich verbindet | `ConnectionManager::external`: der Server des Profils – oder das lokale Ende des SSH-Tunnels der offenen Verbindung (014), der genau diese eine Verbindung mehr durchlässt; mit dem Passwort, mit dem die Verbindung geöffnet wurde. Das Werkzeug meldet sich an wie die App | Aufgabe 2 |
| E6 | Text-Sicherungen | Die Ausgabe von `pg_dump`/`mysqldump` schreibt die App selbst in die Datei (auf Wunsch gzip); beim Wiederherstellen füttert sie die Datei dem Werkzeug (entpackt, wenn gzip). So gibt es Fortschritt in Bytes, gzip auch für MySQL, und die Datei gehört uns – bei Fehler oder Abbruch wird sie entfernt. Archiv und Verzeichnis schreibt `pg_dump` selbst | Aufgabe 3 und 5 |
| E7 | Wiederherstellen | Format aus den ersten Bytes (`PGDMP`, gzip, sonst Text; ein Ordner mit `toc.dat`): Archiv/Verzeichnis → `pg_restore`, Text → `psql` bzw. `mysql`. Optionen: vorher leeren (`--clean --if-exists`), eine Transaktion, beim ersten Fehler anhalten, ohne Besitzer | Aufgabe 4 |
| E8 | Schutz | im Backend: eine Verbindung „nur lesen“ lehnt ab; eine, die fragt, will den **Namen der Verbindung getippt**; eine freie verlangt im Dialog einen Haken. Der Dialog sagt, in welche Datenbank geschrieben wird | Aufgabe 4, Regel „das Fenster fragt nur“ |
| E9 | Job | einer zur Zeit; was das Werkzeug sagt, kommt zeilenweise in den Dialog (die letzten 500 Zeilen); „Anhalten“ beendet die Prozessgruppe (`SIGTERM`, nach einer Sekunde `SIGKILL`) und entfernt, was geschrieben wurde. `pg_restore`, das nach übergangenen Fehlern mit 1 endet, gilt als „erledigt mit Fehlern“ | Aufgabe 5, Akzeptanzkriterium 3 |
| E10 | Einfacher Export | ohne Werkzeuge, für jede Datenbank: die Tabellen eines Schemas als `CREATE` (aus dem Erzeuger des Schema-Vergleichs gegen ein leeres Schema – in tragfähiger Reihenfolge) und ihre Zeilen als `INSERT` (Export aus 011), in einer Datei; im Kopf steht, was fehlt | Aufgabe 6 |
| E11 | Pfade | Ziel und Quelle kommen aus den nativen Dialogen; der Pfad eines Werkzeugs ist eine Einstellung (`toolPaths`), geprüft wie in E2 | Regel „Pfade nur aus Dialogen“ |

## Geprüft

- **Rust** (22 Tests in `backup_tests.rs`, sechs davon aus dem Review): Finden (PATH, übliche Orte, MariaDB-Namen, relative PATH-Einträge
  nie); ein eingestellter Pfad muss dieses Programm sein; Versionen; Argumente von `pg_dump` mit bösen Namen
  (`-evil`, `--table`, `t; rm -rf /`, Anführungszeichen) – jeder Wert an seiner Option, das Passwort in keinem
  Argument; Text-Sicherung schreibt die App; `mysqldump` mit Namen hinter `--` und dem Passwort in der
  Options-Datei (mit `"` und `\`); Steuerzeichen abgelehnt; Wiederherstellen wählt das Programm nach der Datei;
  Dateiart aus den ersten Bytes; **mit echten Prozessen** (Unix): Ausgabe in die Datei, auch gzip; Datei wird
  gefüttert, auch aus gzip; Abbruch beendet den Prozess in unter 5 s und entfernt die halbe Datei; ein Fehler
  hinterlässt keine Datei und keinen begonnenen Ordner; `pg_restore` mit Status 1; das Passwort ist in keiner
  Ausgabe (`env` druckt die Umgebung: `PGPASSWORD=***`) und die MySQL-Datei ist 0600 und danach weg;
  einfacher Export → in leere SQLite-Datenbank → Schema-Vergleich ohne Unterschied, Zeilen gleich (auch BLOB,
  Zeilenumbruch, `'`).
- **Gegen den PostgreSQL-Container** (`a_backup_restored_into_an_empty_database_is_the_same`, `pg_dump` 18 gegen
  Server 17): Archiv → `pg_restore` in eine leere Datenbank → Schema-Vergleich ohne Unterschied, Stichproben
  gleich; Text gzip → `psql` → ebenso; zweites Einspielen scheitert mit der Meldung des Werkzeugs; falsches
  Passwort → Meldung, keine Datei; Abbruch → keine Datei; das Passwort steht in keiner Zeile; im Ordner bleiben
  nur die zwei Sicherungen.
- **Fenster** (19 Tests): Logik (Werkzeug je Datenbank, Werkzeug je Datei, älter als der Server, Spec je
  Datenbank, Dateiname ohne Pfadanteile, Schutz vor dem Wiederherstellen, Zeilenpuffer, Größen); Dialog
  (gefundenes Werkzeug, Sichern über den Speichern-Dialog, Auswahl aus dem Baum, abgebrochener Dialog, fehlendes
  Werkzeug mit Hinweis und Pfad, ältere Version, Fehler als Text, Anhalten, einfacher Export und SQLite-Kopie,
  Wiederherstellen erst nach dem Haken, Name tippen / nur lesen, unpassende Datei).
- **Im Browser** mit nachgebildetem Backend: Dialog mit `pg_dump` 16 gegen Server 17 (Warnung), nur das Schema
  aus dem Baum, gzip → Speichern-Dialog mit `public-2026-11-12.sql.gz`, Lauf mit Zeilen des Werkzeugs (ein
  `<img …>` darin bleibt Text), „Erledigt: 5,0 MB“. **Nicht bedient:** das native Fenster.
- `pnpm check` grün.

## Review

Sicherheitsreview durch einen zweiten Agenten (kein Shell-Aufruf, Geheimnisse, Pfade, Werkzeugpfad, Schutz,
Prozesse). Nichts gefunden bei: Argumenten (jeder Wert an seiner Option oder hinter `--`), den Mustern von
`pg_dump`, dem Passwort in Argumenten und Ausgaben, der Options-Datei, der PATH-Suche, dem Abbruch unter Unix.
Behoben – mit Tests:

| Nr. | Befund | Behebung |
|---|---|---|
| H1 | Ein gescheiterter oder angehaltener Lauf **löschte, was vorher da war**: die Sicherung der letzten Woche (schon beim Start geleert), oder – im Verzeichnis-Format – einen gewählten, nicht leeren Ordner mit allem darin | Geschrieben wird **neben** das Ziel (`<ziel>.sc-part`); erst eine ganze Sicherung nimmt den Platz des Ziels ein. Ein Ordner, der etwas enthält, wird als Ziel abgelehnt. Gilt auch für den einfachen Export und die SQLite-Kopie |
| H2 | Die SQLite-Kopie konnte die Datenbank selbst zum Ziel haben und sie löschen | abgelehnt; die Kopie entsteht daneben und wird dann umbenannt |
| M1 | Eine importierte Einstellungsdatei konnte den Pfad eines Werkzeugs setzen – ein Programm, das dann mit dem Passwort in der Umgebung läuft | `toolPaths` wird weder exportiert noch importiert; der Dialog zeigt immer den Pfad des Programms, nicht nur, was es über sich sagt |
| M2 | Die MySQL-Werkzeuge bekamen den TLS-Modus des Profils nicht (außer „aus“): Passwort und Sicherung über eine Leitung, die die App selbst abgelehnt hätte | TLS-Modus je Werkzeugfamilie (`--ssl-mode=…` bzw. `--ssl`/`--ssl-verify-server-cert`), eigene CA und Client-Zertifikat für beide Datenbanken |
| M3 | Eine Sicherung als Text kann Befehle des Werkzeugs enthalten, die Programme starten (`\!` in `psql`, `system` in `mysql`) – der Dialog sagte es nicht | Der Dialog sagt es vor dem Wiederherstellen |
| M4 | Ausgabe, die kein UTF-8 ist, beendete das Zuhören – und damit den Lauf | wird ersetzt statt abgebrochen; überlange Zeilen werden geteilt |
| L1 | `--dbname` nimmt auch eine Verbindungszeichenkette | ein Name mit `=` oder `postgresql://` wird abgelehnt |
| L2 | Ein Passwort mit Zeilenumbruch hätte der Options-Datei weitere Optionen gegeben | abgelehnt |
| L3 | Nach einem harten Ende der App blieb die Options-Datei liegen | der private Ordner wird vor jedem Lauf geleert |
| L6 | Ein eingestellter Pfad `pg_dump.cmd` liefe über die Shell | nur ohne Endung oder `.exe` |

Offen gelassen: `--loose-skip-system-command`/`--loose-sandbox` für die MySQL-Clients und `\restrict` für `psql`
(hier nicht gegen echte Werkzeuge prüfbar); ein Programm, das eine feindliche Datei startet und das die Ausgabe
offen hält, lässt den Lauf hängen (L7); eine freie Verbindung fragt nur im Fenster (L8 – wie bei jeder Anweisung
dort, im Code vermerkt).

## Nicht geprüft

- **MySQL/MariaDB mit echtem Werkzeug**: `mysqldump`/`mysql` sind auf diesem Rechner nicht installiert (nur in
  den Containern). Geprüft sind ihre Argumente, die Options-Datei und der Lauf mit Ersatzprozessen – nicht die
  Rundreise, und nicht, ob jede Version die TLS-Optionen kennt (`--ssl-mode` ab MySQL 5.7.11).
- **Windows**: das Beenden von Kindprozessen (`child.kill()` trifft dort nur den Prozess selbst) und die Rechte
  der Options-Datei (dort gelten die des Profilordners).
- **SSH-Tunnel** mit einem Werkzeug: `external` ist geschrieben, aber nicht gegen einen Tunnel gelaufen.

## Nicht umgesetzt

- `sqlcmd`/`bcp` (E1); Wiederherstellen für SQL Server und SQLite: die Datei des einfachen Exports in einem Tab
  ausführen.
- **Neue Datenbank als Ziel**: wiederhergestellt wird in die Datenbank der Verbindung.
- Fortschritt in Prozent: `pg_dump` sagt keinen; gezeigt werden seine Zeilen und am Ende die Größe.
- Parallele Jobs (`--jobs`), Auswahl mehrerer Schemata/Tabellen im Dialog (übernommen wird, was im Baum gewählt
  war), `--exclude-table`, Rollen (`pg_dumpall`).
- Der einfache Export schreibt keine Views, Routinen, Trigger-Rechte, Sequenzen, Identity – er sagt es im Kopf.
