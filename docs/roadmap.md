# Roadmap

| Schritt | Inhalt | Status |
|---|---|---|
| 0 | Technischer Aufbau, Walking Skeleton (Editor → Rust → Gitter), Farbschemata, Best Practices | ✅ |
| 1 | Feature-Analyse der wichtigsten SQL-Tools (`docs/feature-analysis.md`) | ✅ alle Features freigegeben |
| 2 | Prompts 001–049 (`prompts/`) und E1–E5 für editlicious (`prompts/done/editlicious/`) | ✅ geschrieben |
| 3 | Umsetzung Prompt für Prompt in der Reihenfolge von `prompts/README.md` | 001–010 ✅, nächster: 011; E1–E5 erledigt mit `editlicious-editor` 1.2.0 |

Bekannte Lücken des Skeletons (werden von den ersten Prompts geschlossen):

- Das Gitter sortiert nicht mehr lokal (kommt mit 027); 10 Mio. Zeilen und ein Release-Build wurden nicht gemessen
  (Design 006).
- Die Zwischenablage (`arboard`) ist übersetzt, aber auf keinem System ausgeführt worden (Design 009).
- Schema-Baum: keine Mehrfachauswahl, keine Favoriten, wartet hinter einer laufenden Anweisung (Design 008).
- Spaltenkopf ohne Schlüssel-Marken und Sortierzustand (008, 027); Datumsformat nicht einstellbar (017).
- Meldungen des Servers (NOTICE, PRINT) kommen nicht an (Treiber geben sie nicht weiter, Design 005).
- SQL Server: Ein Abbruch kostet die Verbindung (kein Attention-Signal in `tiberius`).
- Keine Menüleiste (018), keine Übersetzung (017).
- Die native App wurde gebaut und gestartet, ihr Fenster aber noch nicht von Hand durchgeklickt – auch nicht
  gegen einen echten Server und den echten Schlüsselbund (003).
