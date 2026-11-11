# Prompts für editlicious

> **Stand 11.11.2026: E1–E5 sind umgesetzt** (editlicious Prompts 026–030) und in `editlicious-editor` 1.2.0
> veröffentlicht. Die Dateien hier bleiben als Referenz, was Schema Commander vom Editor braucht.

Schema Commander nutzt `<editlicious-editor>` als SQL-Editor. Wo dem Editor etwas fehlt, wird es **in editlicious
ergänzt und als neue Version von `editlicious-editor` veröffentlicht**, nicht hier umgangen. Diese Prompts beschreiben
die Erweiterungen aus Sicht des Verbrauchers.

**Ausführen:** neue Sitzung im Repo `../editlicious` (nicht hier):
„Lies `prompts/000-arbeitsweise.md` (die von editlicious) und führe
`../schema-commander/prompts/editlicious/E1-farben-von-aussen.md` aus.“ Es gelten die Regeln, Phasen und Checks von
editlicious (`CLAUDE.md` dort); das Design-Dokument entsteht dort unter `prompts/`. Nach der Veröffentlichung hier
`editlicious-editor` in `package.json` anheben.

Für alle gilt: Die Erweiterung ist **allgemein** (kein SQL-Wissen im Editor), jede Editor-Instanz bleibt für sich
(Shadow DOM, nichts Globales), große Texte bleiben schnell (nichts, das den ganzen Text über die Grenze schickt),
`editlicious-editor.d.ts` und das README des Pakets werden mitgepflegt, die Desktop-App von editlicious verhält sich
unverändert.

| Nr. | Prompt | Inhalt | Gebraucht von |
|---|---|---|---|
| E1 | [E1-farben-von-aussen.md](E1-farben-von-aussen.md) | alle Farben des Editors als dokumentierte CSS-Variablen von außen setzbar | 001 |
| E2 | [E2-auswahl-abfragen.md](E2-auswahl-abfragen.md) | Auswahl und Textbereiche als Text abfragen, Bereich ersetzen | 005, 023 |
| E3 | [E3-vervollstaendigung-von-aussen.md](E3-vervollstaendigung-von-aussen.md) | Anbieter für Vorschläge, den die Seite liefert | 021 |
| E4 | [E4-markierungen-von-aussen.md](E4-markierungen-von-aussen.md) | Unterstreichungen, Randmarken und Hinweise von außen | 022, 012 |
| E5 | [E5-snippets.md](E5-snippets.md) | Textbausteine mit Platzhaltern und Tab-Stopps | 024 |
