# Prompt 014: SSH-Tunnel und TLS

> **Slug:** `ssh-tls` · **Feature:** A3 · **Braucht:** 003 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Erprobter Code: `log-commander/src-tauri/src/remote/` (russh,
> known_hosts-Parser, Schlüsselbund, Fehlercodes `host_key_unknown`/`host_key_changed`) und
> `log-commander/prompts/done/017-remote-sftp.design.md` samt Sicherheitsreview; fnf Design 034.

## Ziel

Datenbanken hinter einem Sprungserver erreichen und TLS richtig einstellen – ohne externe Programme und ohne
Abstriche bei der Prüfung von Host-Schlüsseln und Zertifikaten.

## Aufgaben

1. **SSH-Tunnel in Rust** (`russh`, `direct-tcpip`): je Profil Host, Port, Benutzer, Anmeldung über Agent,
   Schlüsseldatei (Passphrase im Schlüsselbund oder fragen), Passwort; Einträge aus `~/.ssh/config` übernehmen
   (Host-Alias, `IdentityFile`, `Port`, `User`; `ProxyJump` als zweite Stufe).
2. **Host-Schlüssel**: Prüfung gegen `known_hosts`; unbekannt → Fingerabdruck zeigen und bestätigen lassen;
   geändert → ablehnen, kein Weg daran vorbei.
3. **Treiber über den Tunnel**: Der Treiber spricht über den Kanal (lokaler Port nur an `127.0.0.1` mit Zufallsport
   oder direkt über den Strom). Tunnel lebt so lange wie die Sitzungen, Keep-alive, Wiederaufbau mit Meldung.
4. **TLS je Profil**: aus / bevorzugt / erforderlich / Zertifikat prüfen / Zertifikat und Hostname prüfen;
   eigene CA-Datei, Client-Zertifikat und -Schlüssel. „Nicht prüfen“ ist eine sichtbare, benannte Einstellung und
   wird in der Statuszeile angezeigt.
5. **Fehler**: eigene Codes und verständliche Texte für jede Stufe (SSH erreichbar? Anmeldung? Tunnelziel? TLS?
   Datenbank-Anmeldung?). „Testen“ im Dialog zeigt, welche Stufe scheitert.

## Entscheidungsfragen (Design)

- Lokaler Port gegenüber direktem Strom in den Treiber: Was unterstützen die gewählten Treiber-Krates?
- Wie viel aus log-commander wird als gemeinsames Modul kopiert (und wie halten wir beide gleich)?

## Akzeptanzkriterien

- PostgreSQL und MySQL hinter einem SSH-Server (Container) mit Schlüssel, Agent und Passwort.
- Geänderter Host-Schlüssel wird abgelehnt; abgelaufenes oder falsches Server-Zertifikat ebenso (je nach Modus).
- Kein Geheimnis in Dateien, Logs, Fehlertexten.

## Tests und Review

Rust: SSH-Server im Test (wie log-commander), TLS-Fälle mit selbst erzeugten Zertifikaten. **Sicherheitsreview durch
einen zweiten Agenten**: Host-Schlüssel, Zertifikatsprüfung, Tunnel-Bindung, Geheimnisse.
