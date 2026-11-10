# Prompt 017: Einstellungen und Sprache

> **Slug:** `einstellungen-sprache` · **Feature:** G3 · **Braucht:** 002 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild und Quelle: `files-and-folders-tauri` Prompt 015
> (`src/app/core/i18n/`, `src/app/core/settings/`, `features/settings/`, Text-Kataloge `*-texts.ts` + `*.de.ts`).

## Ziel

Ein Einstellungsdialog für alles Verstreute und eine Oberfläche in **Englisch und Deutsch**, umschaltbar zur Laufzeit.

## Aufgaben

1. **Text-Kataloge** nach fnf: Englisch ist die Quelle, Deutsch die typgeprüfte Übersetzung; Signale, damit der
   Wechsel ohne Neustart wirkt. Alle heute deutschen Texte (App-Rahmen, Farbschema-Galerie, Token-Namen,
   Statuszeile) umziehen. Test: kein Katalogeintrag fehlt in einer Sprache.
2. **Regeln** übernehmen: Texte nie beim Laden eines Moduls in Konstanten kopieren; Fehler im UI über eine
   `errorText(code)`-Funktion, nicht über Rusts `message` (die Meldung des Datenbankservers bleibt unübersetzt und
   wird als solche gekennzeichnet).
3. **Einstellungsmodell** mit Schema und Vorgaben (`settings.models.ts` ausbauen): Gruppen Allgemein (Sprache,
   Farbschema), Editor (Schrift, Größe, Tab-Breite, Umbruch, Zeilennummern, Vervollständigung), Ergebnis (Schrift,
   Zeilenhöhe, Formate, `NULL`-Darstellung, Speichergrenzen), Ausführen (bei Fehler anhalten, Zeitlimit, Vorgabe
   Auto-Commit), Verlauf, Sicherheit.
4. **Dialog**: Gruppen links, Suche über alle Einstellungen, Wirkung sofort, „Zurücksetzen“ je Wert und gesamt;
   Signal Forms. Export/Import der Einstellungen als Datei (ohne Geheimnisse).
5. Editor-Einstellungen an `<editlicious-editor>` durchreichen (Attribute), inklusive `ui-language`.
6. Sprache der nativen Teile (Menü, Dialoge) folgt.

## Akzeptanzkriterien

- Sprache wechseln ändert jede sichtbare Zeichenkette sofort, auch in offenen Dialogen und im Editor.
- Eine defekte oder ältere Einstellungsdatei führt zu Vorgaben für die betroffenen Werte, nicht zum Absturz.
- `pnpm lint`/Test schlägt an, wenn ein Text fest im Template steht (Regel oder Test im Design festlegen).

## Tests

Rein: Kataloge vollständig, Platzhalter gleich in beiden Sprachen, Einstellungs-Migration. Komponente: Dialog per
Tastatur, Suche.
