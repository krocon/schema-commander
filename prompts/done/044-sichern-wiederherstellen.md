# Prompt 044: Sichern und Wiederherstellen

> **Slug:** `sichern-wiederherstellen` · **Feature:** F3 · **Braucht:** 003, 011 (Job-Engine), 012 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`, `docs/best-practices.md` §6. Vorbild: TablePlus, DBeaver, HeidiSQL
> (eigener Export als SQL). Externe Programme ohne Shell: fnf Prompt 011 (Argument-Arrays, `ProgramNotFound`).

## Ziel

Eine Datenbank als Datei sichern und wieder einspielen – mit den **Werkzeugen der Datenbank** (`pg_dump`/
`pg_restore`/`psql`, `mysqldump`/`mysql`, `sqlcmd`/`bcp`; SQLite: Kopie über die Backup-Schnittstelle), geführt durch
einen Dialog.

## Aufgaben

1. **Werkzeuge finden**: im `PATH` und an üblichen Orten je OS; Pfad einstellbar; Version prüfen und gegen die
   Serverversion warnen (`pg_dump` älter als der Server). Fehlt ein Werkzeug: klare Meldung mit Hinweis, wo man es
   bekommt – nichts wird heruntergeladen.
2. **Start ohne Shell**: Programm + Argument-Array; Passwort über Umgebungsvariable/temporäre Datei mit engen
   Rechten (`PGPASSWORD`/`.pgpass`-artig, `--defaults-extra-file`), **nie** als Argument (Prozessliste) und nie im
   Log; danach aufräumen. SSH-Tunnel aus Prompt 014 werden mitbenutzt.
3. **Sichern**: Umfang (Datenbank, Schemata, Tabellen aus dem Baum), nur Struktur/nur Daten, Format (SQL, Custom,
   Verzeichnis; gzip), Optionen (keine Besitzer/Rechte, `INSERT` statt `COPY`); Ziel über nativen Dialog.
4. **Wiederherstellen**: Datei wählen, Format erkennen, Ziel (vorhandene oder neue Datenbank), Optionen (vorher
   leeren, in einer Transaktion, bei Fehler anhalten). Schutzregeln aus Prompt 012; auf geschützten Verbindungen nur
   nach harter Bestätigung.
5. **Als Job**: Ausgabe des Werkzeugs gestreamt in den Meldungsbereich, Fortschritt soweit erkennbar, Abbruch beendet
   den Prozess (und seine Kinder) sauber; unvollständige Zieldatei wird entfernt.
6. **Ohne Werkzeuge**: einfacher eigener SQL-Export (Struktur aus 019, Daten über 011) als Rückfall, klar benannt als
   „einfacher Export“.

## Akzeptanzkriterien

- Rundreise je Datenbank: sichern → in leere Datenbank einspielen → Schema-Vergleich/Stichproben ohne Unterschied.
- Während des Laufs ist das Passwort weder in der Prozessliste noch in einer dauerhaften Datei noch in der Ausgabe.
- Abbruch hinterlässt keinen Prozess und keine halbe Datei.

## Tests und Review

Rust: Argumentbildung je Werkzeug (Katalog, böse Namen mit Leerzeichen/Anführungszeichen/`-`-Präfix), Finden der
Werkzeuge, Abbruch. **Sicherheitsreview**: kein Shell-Aufruf, Geheimnisse, Pfade nur aus Dialogen.
