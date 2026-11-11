# Roadmap

| Schritt | Inhalt | Status |
|---|---|---|
| 0 | Technischer Aufbau, Walking Skeleton (Editor → Rust → Gitter), Farbschemata, Best Practices | ✅ |
| 1 | Feature-Analyse der wichtigsten SQL-Tools (`docs/feature-analysis.md`) | ✅ alle Features freigegeben |
| 2 | Prompts 001–049 (`prompts/`) und E1–E5 für editlicious (`prompts/done/editlicious/`) | ✅ geschrieben |
| 3 | Umsetzung Prompt für Prompt in der Reihenfolge von `prompts/README.md` | 001–003 ✅, nächster: 004; E1–E5 erledigt mit `editlicious-editor` 1.2.0 |

Bekannte Lücken des Skeletons (werden von den ersten Prompts geschlossen):

- Ergebnis kommt komplett über die Brücke (Obergrenze 100 000 Zeilen bzw. 256 MB), kein Nachladen (006).
- `NULL` wird im Gitter leer angezeigt; Renderer je Typ fehlen (Prompt 007).
- „Ausführen“ nimmt die Anweisung unter dem Cursor; die Auswahl (`getSelection()` seit 1.2.0) nutzt erst Prompt 005.
- Keine Menüleiste (018), keine Übersetzung (017).
- Die native App wurde gebaut und gestartet, ihr Fenster aber noch nicht von Hand durchgeklickt – auch nicht
  gegen einen echten Server und den echten Schlüsselbund (003).
