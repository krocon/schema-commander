# Prompt 047: Benutzer und Rechte

> **Slug:** `benutzer-rechte` · **Feature:** H2 · **Braucht:** 012, 019 · **Umfang:** L
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: HeidiSQL (Benutzerverwaltung), Navicat, pgAdmin.

## Ziel

Benutzer/Rollen und ihre Rechte **ansehen** und – mit DDL-Vorschau – **ändern**: Wer darf was auf welchem Objekt?

## Aufgaben

1. **Lesen je Datenbank**: PostgreSQL (Rollen, Mitgliedschaften, Attribute, Rechte auf Datenbank/Schema/Tabelle/
   Spalte/Sequenz/Funktion, Default-Privilegien, Besitzer), MySQL/MariaDB (`mysql.user`, `SHOW GRANTS`, Rollen ab 8),
   SQL Server (Logins, Benutzer, Rollen, Berechtigungen). SQLite: entfällt.
2. **Zwei Sichten**: je **Benutzer/Rolle** (was darf er, direkt und geerbt, mit Herkunft) und je **Objekt** (wer darf
   was – auch als Reiter in den Objekt-Details aus Prompt 019). Rechte-Matrix als GuiExpert Table (Objekte × Rechte).
3. **Ändern mit Vorschau**: Benutzer/Rolle anlegen, Attribute, Mitgliedschaften, `GRANT`/`REVOKE` über Häkchen in der
   Matrix; gesammelt, als DDL angezeigt, nach Bestätigung ausgeführt (Regeln aus Prompt 012).
4. **Passwörter**: Eingabe nur im Dialog, sofort als gebundener Wert bzw. über die sichere Form des Dialekts
   gesendet; nie im DDL-Text der Vorschau (dort maskiert), nie im Verlauf, nie im Log; im Speicher mit `zeroize`.
   Hinweis, falls der Server Anweisungen protokolliert.
5. **Vergleichen/Kopieren**: Rechte eines Benutzers als Skript; „Rechte wie Benutzer X“.
6. Gefährliches markieren: Superuser/`ALL PRIVILEGES`/`WITH GRANT OPTION`, Rechte entziehen, die die eigene Sitzung
   aussperren würden.

## Entscheidungsfragen (Design)

- Erste Fassung nur lesend (mit DDL-Export) und Ändern in einem zweiten Schritt?
- Umfang je Datenbank; was bewusst fehlt (Row-Level-Security-Richtlinien, Azure-AD-Benutzer …).

## Akzeptanzkriterien

- Für die Test-Rollen jeder Datenbank stimmt die angezeigte Matrix mit dem tatsächlichen Verhalten überein
  (Stichprobe: Anmeldung als Rolle, erlaubte/verbotene Anweisung).
- Ein gesetztes Passwort taucht in keiner Vorschau, keinem Verlaufseintrag und keinem Log auf (Test).
- Ohne Verwaltungsrechte ist die Sicht lesbar, soweit erlaubt, und Ändern ist aus.

## Tests und Review

Rust gegen Container: Lesen und DDL-Katalog je Datenbank. **Sicherheitsreview durch einen zweiten Agenten**:
Passwörter, Quoting von Rollennamen, Selbst-Aussperren.
