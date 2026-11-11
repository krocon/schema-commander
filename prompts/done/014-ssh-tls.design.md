# Design 014: SSH-Tunnel und TLS

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/ssh-tls` · Auftrag: [014-ssh-tls.md](014-ssh-tls.md) · Feature A3

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Lokaler Port oder Strom in den Treiber? | **lokaler Port**: Listener auf `127.0.0.1` mit Zufallsport, je Verbindung ein `direct-tcpip`-Kanal (`russh`) | `sqlx` und `tiberius` nehmen keinen fremden Strom an; ein Weg für alle Treiber |
| E2 | Wer darf den Port benutzen? | nur **angekündigte** Verbindungen: `Tunnel::permit()` vor jedem eigenen Connect, eine Freigabe = eine Verbindung, gültig 10 s; alles andere wird aufgelegt | ein lokales Programm, das den Port findet, bekommt nichts. Rest: siehe „Was bleibt“ |
| E3 | Host-Schlüssel | gegen `~/.ssh/known_hosts` (nur lesen) und die eigene Datei neben den Profilen. Unbekannt → `host_key_unknown` mit Typ und Fingerabdruck; nur ein Connect, der **genau diesen Fingerabdruck** nennt, merkt ihn. Geändert oder widerrufen → `host_key_changed`, kein Weg daran vorbei. Erst der Schlüssel, dann das Passwort | Auftrag; wie log-commander |
| E4 | Anmeldung | Agent (höchstens 6 Schlüssel, die der `IdentityFile`s zuerst), Schlüsseldatei (Passphrase), Passwort. Was den Tunnel öffnet, liegt wie das DB-Passwort im Schlüsselbund (wenn „merken“) und für die Dauer der Verbindung im Speicher | Auftrag |
| E5 | Übernommen aus log-commander | `trust.rs` (known_hosts-Parser) und `ssh_config.rs` **unverändert kopiert** (Kopfzeile nennt die Herkunft); Client und Anmeldung nachgebaut. Kein gemeinsames Crate | zwei Dateien; ein drittes Repo wäre mehr Pflege als das Gleichhalten |
| E6 | Lebensdauer | der Tunnel gehört der Verbindung; jede Sitzung (auch die der Tabs) hält ihn fest. Bricht er, baut ihn die nächste Sitzung mit dem gemerkten Geheimnis neu auf; scheitert das, sagt der Fehler die Stufe | – |
| E7 | TLS-Modi | `off`, `prefer`, `require` (beide: **nichts wird geprüft**, so benannt, mit Hinweis im Dialog und „TLS ungeprüft“ in der Toolbar), `verify-ca`, `verify`; CA-Datei nur in den prüfenden Modi, Client-Zertifikat + Schlüssel (nicht SQL Server) | Auftrag |
| E8 | TLS durch den Tunnel | `verify` wird abgelehnt: der Treiber spricht mit `127.0.0.1`, der Name im Zertifikat kann nicht passen. Höchstens `verify-ca` | `sqlx` kennt keinen abweichenden Servernamen |
| E9 | Stufen | Fehlercodes je Stufe: `connection_failed` (SSH oder Datenbank), `host_key_unknown`, `host_key_changed`, `ssh_secret_required`, `auth_failed`, `tls_failed`, `secret_required`. „Testen“ zeigt die Stufe; es merkt nichts im Schlüsselbund | Auftrag |

## Sicherheitsreview durch einen zweiten Agenten

Kein schwerer Fund. Eingearbeitet:

- **M1/M2** Die zweite Verbindung zum Abbrechen einer Anweisung ging am Tunnel vorbei: ohne Freigabe (Abbruch
  wirkungslos) und, nach dem Schließen, an einen Port, den ein fremdes Programm hätte übernehmen können – mit dem
  Passwort. Jetzt hält jede Sitzung ihren Tunnel (`Session::via_tunnel`), und die Nebenverbindung wird angekündigt.
  Test gegen PostgreSQL: Abbruch durch den Tunnel in unter 6 s, die Sitzung bleibt.
- **M3** Eine CA-Datei in `prefer`/`require` wurde still ignoriert → jetzt abgelehnt.
- **M5** Freigaben verfallen nach 10 s.
- **L1** `PG*`-Umgebungsvariablen (auch `PGPASSWORD`, `PGOPTIONS`) erreichten den Treiber → beim Start entfernt.
- **L2** Das SSH-Geheimnis blieb nach dem Löschen eines Profils im Schlüsselbund; „Testen“ merkte es → behoben.
- **L4** SQLite-Profile übersprangen die SSH-Prüfung → ein Dateiprofil mit Tunnel wird abgelehnt.

## Was bleibt

- **M4** `verify-ca` mit eigener CA-Datei vertraut **zusätzlich** allen Zertifikaten des Systems (`sqlx` und
  `tiberius` laden sie immer). Da der Hostname in diesem Modus nicht geprüft wird, besteht dort jedes Zertifikat
  jeder öffentlichen CA. Der Dialog sagt „zusätzlich“; abstellen ließe es sich nur mit einem eigenen TLS-Strom.
- **M5, Rest** Zwischen Freigabe und Connect des Treibers kann ein lokales Programm die Verbindung nehmen: Es
  erreicht dann den Datenbank-Port (nicht die Zugangsdaten), unser Connect scheitert. Ein Unix-Socket in einem
  privaten Ordner wäre dicht, geht aber nicht für alle Treiber und nicht unter Windows.
- **L3** SQL Server mit `verify-ca` durch den Tunnel scheitert immer (der Treiber prüft den Namen gegen
  `127.0.0.1`) – es scheitert zur sicheren Seite.
- **`ProxyJump`** als zweite Stufe fehlt; Hosts mit Proxy aus `~/.ssh/config` sind in der Auswahl gesperrt.
- Wird der Sprungserver eines Profils geändert, bleibt das alte SSH-Geheimnis im Schlüsselbund.

## Geprüft

- Rust mit einem SSH-Server im Testprozess: unbekannter, bestätigter, geänderter Host-Schlüssel; Passwort erst nach
  dem Schlüssel; Schlüsseldatei mit und ohne Passphrase; nur angekündigte Verbindungen, verfallene Freigabe.
- Gegen die Container (`pnpm rust:test:db`): **PostgreSQL und MySQL hinter dem SSH-Server** – Stufe für Stufe, eigene
  Sitzung eines Tabs durch denselben Tunnel, Abbruch durch den Tunnel, kein Geheimnis in `connections.json`;
  `prefer` fällt zurück, `require`/`verify-ca`/`verify` verweigern einen Server ohne TLS.
- Frontend: Verbindungsablauf mit Fake (Host-Schlüssel bestätigen/ablehnen, geändert, SSH-Geheimnis, dann
  DB-Passwort), Prüfungen des Profils. Im Browser: Dialog und „Testen“ über die Stufen.

## Nicht geprüft

- **Zertifikatsprüfung gegen einen echten TLS-Server** (eigene CA, abgelaufenes oder falsches Zertifikat,
  Client-Zertifikat): die Container sprechen kein TLS. Das Akzeptanzkriterium dazu ist nur für „kein TLS“ belegt.
- **Agent-Anmeldung** (braucht einen laufenden Agenten), SQL Server und MariaDB hinter dem Tunnel, Windows.
- Das native Fenster und der echte Schlüsselbund.
