# Prompt 004: Abfrage-Tabs

> **Slug:** `abfrage-tabs` · **Feature:** C1 · **Braucht:** 002, 003 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DataGrip (Konsolen), TablePlus. Tab-Leiste:
> `log-commander/src/app/features/tabs/`, Sitzung: `files-and-folders-tauri/src-tauri/src/session.rs`.

## Ziel

Mehrere Abfragen nebeneinander: Jeder Tab hat seinen Text, seine Verbindung und sein Ergebnis. **Nichts geht
verloren und nichts fragt „Speichern?“**: Der Inhalt jedes Tabs wird laufend gesichert und ist nach einem Neustart
(auch nach einem Absturz) wieder da.

## Aufgaben

1. **Tab-Modell**: Id, Titel (automatisch aus der ersten Zeile oder Tabelle, umbenennbar), Verbindung, Text,
   Cursor, Ergebnis-Zustand. Store je Tab (`@Injectable()` ohne `providedIn`), ein Root-Store für die Liste. Tabs
   werden per Id adressiert. `QuerySession` aus dem Skeleton wird zum Store je Tab.
2. **Tab-Leiste** nach APG (Tabs): neu, schließen, schließen rückgängig, nächster/voriger, per Ziehen umsortieren,
   Farbmarke der Verbindung am Reiter, Kontextmenü (andere schließen, duplizieren).
3. **Laufende Sicherung**: Text je Tab als eigene Datei im Datenordner der App (atomar schreiben, gedrosselt);
   beim Start wiederherstellen. Große Texte (editlicious kann Millionen Zeilen) nicht bei jedem Tastendruck über die
   Brücke schicken – im Design lösen (`ed-change` liefert nur Revision und Größe).
4. **Dateien**: Tab als `.sql` speichern/öffnen (nativer Dialog, Kodierung und Zeilenenden erhalten), „geändert“-
   Marke nur für Tabs mit Datei. Datei per Drag & Drop öffnen.
5. **Verbindung je Tab** wählen/wechseln; Tab ohne Verbindung ist erlaubt (nur Editor).
6. Ein Editor-Element je Tab oder eines für alle? Fokus, Undo-Verlauf und Scroll-Position bleiben je Tab erhalten.

## Entscheidungsfragen (Design)

- Ein `<editlicious-editor>` je Tab (einfach, Undo bleibt) gegen ein gemeinsames Element mit Textwechsel
  (sparsamer)? Speicherbedarf messen.
- Wie viel Ergebnis bleibt bei einem Tab im Hintergrund im Speicher (Zusammenspiel mit Prompt 006)?
- Wiederherstellen: Tabs sofort alle laden oder erst beim Anklicken?

## Akzeptanzkriterien

- Zehn Tabs mit verschiedenen Verbindungen; App hart beenden (`kill -9`); nach dem Start sind alle Texte da.
- Tab schließen und mit „Schließen rückgängig“ zurückholen.
- Ein 200-MB-Skript in einem Tab bremst das Tippen in einem anderen nicht.

## Tests

Rein: Titelbildung, Reihenfolge, Wiederherstellen aus defekten/fehlenden Dateien. Rust: atomares Schreiben,
Aufräumen verwaister Dateien. Komponente: Tab-Leiste per Tastatur.
