# Roadmap

| Schritt | Inhalt | Status |
|---|---|---|
| 0 | Technischer Aufbau, Walking Skeleton (Editor → Rust → Gitter), Farbschemata, Best Practices | ✅ |
| 1 | Feature-Analyse der wichtigsten SQL-Tools (`docs/feature-analysis.md`) | ✅ alle Features freigegeben |
| 2 | Prompts 001–049 (`prompts/`) und E1–E5 für editlicious (`prompts/done/editlicious/`) | ✅ geschrieben |
| 3 | Umsetzung Prompt für Prompt in der Reihenfolge von `prompts/README.md` | 001–017 ✅, nächster: 018; E1–E5 erledigt mit `editlicious-editor` 1.2.0 |

Bekannte Lücken des Skeletons (werden von den ersten Prompts geschlossen):

- Das Gitter sortiert nicht mehr lokal (kommt mit 027); 10 Mio. Zeilen und ein Release-Build wurden nicht gemessen
  (Design 006).
- Sprache: Detailtexte aus Rust (`AppError.message`) sind weiter deutsch; Meldungen, die schon im Fenster stehen
  (Meldungsprotokoll, Export-Status), wechseln die Sprache nicht nachträglich; Speichergrenzen sind keine
  Einstellung; das native Menü wurde nicht im laufenden Programm umgeschaltet (Design 017).
- Arbeitsbereich: zwei Gruppen sind gleich groß (kein Splitter dazwischen), keine eigene Scrollposition, die
  Ansicht „gespeicherte Abfragen“ fehlt; im nativen Fenster nicht bedient (Design 016).
- Import: die Formate von DBeaver und DataGrip sind nicht an echten Dateien belegt; TablePlus fehlt (Design 015).
- SSH/TLS: kein `ProxyJump`, kein Hostname-Check des Zertifikats durch den Tunnel; Zertifikatsprüfung und Agent
  sind gegen keinen echten Server gelaufen (Design 014).
- Transaktionen: keine Isolationsstufe, kein Modus je Profil; Trennen einer Verbindung fragt nicht (Design 013).
- Produktionsschutz: eigene Funktionen gelten als lesend, SQL Server hat keine zweite Linie auf dem Server; die
  nach dem Review neu geschriebene Einstufung wurde nicht erneut angegriffen (Design 012).
- Binärwerte über 64 Bytes fehlen in Kopie und Export; `export_query` und 10 Mio. Zeilen sind gegen keinen
  echten Server gemessen (Design 011).
- Die Zwischenablage (`arboard`) ist übersetzt, aber auf keinem System ausgeführt worden (Design 009).
- Schema-Baum: keine Mehrfachauswahl, keine Favoriten, wartet hinter einer laufenden Anweisung (Design 008).
- Spaltenkopf ohne Schlüssel-Marken und Sortierzustand (008, 027); Datumsformat nicht einstellbar (017).
- Meldungen des Servers (NOTICE, PRINT) kommen nicht an (Treiber geben sie nicht weiter, Design 005).
- SQL Server: Ein Abbruch kostet die Verbindung (kein Attention-Signal in `tiberius`).
- Keine Menüleiste (018), keine Übersetzung (017).
- Die native App wurde gebaut und gestartet, ihr Fenster aber noch nicht von Hand durchgeklickt – auch nicht
  gegen einen echten Server und den echten Schlüsselbund (003).
