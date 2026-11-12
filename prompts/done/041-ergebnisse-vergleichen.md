# Prompt 041: Mehrere Ergebnisse, Anpinnen, Vergleichen

> **Slug:** `ergebnisse-vergleichen` · **Feature:** D9 · **Braucht:** 005, 006 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DataGrip (Result-Tabs, Pin, Compare Data).

## Ziel

Ein Skript liefert viele Ergebnisse, und manches Ergebnis will man behalten: Ergebnisse als **Unter-Reiter**,
**anpinnen**, und **zwei Ergebnisse vergleichen**.

## Aufgaben

1. **Unter-Reiter** je Abfrage-Tab: ein Reiter je Ergebnis plus „Meldungen“; Titel aus der Anweisung (Tabelle bzw.
   Anfang), Zeilenzahl, umbenennbar; Obergrenze mit „ältere schließen“. Der einfache Stand aus Prompt 005 wird
   hier ausgebaut.
2. **Anpinnen**: Ein angepinntes Ergebnis wird vom nächsten Lauf nicht ersetzt; ungepinnte werden wiederverwendet
   (Einstellung: immer neuer Reiter). Speicher: angepinnte Ergebnisse halten ihren Platz im Ergebnisspeicher –
   Anzeige des Verbrauchs, Freigeben.
3. **Ergebnis ablösen**: in einen eigenen Tab oder neben das aktuelle legen (geteilte Ansicht aus Prompt 016).
4. **Vergleichen** zweier Ergebnisse (Rust, über den Speicher): Zuordnung der Zeilen über gewählte Schlüsselspalten
   (Vorschlag: Primärschlüssel bzw. erste Spalten) oder nach Position; Ergebnis: nur links, nur rechts, geändert
   (mit den geänderten Zellen), gleich. Toleranzen: Leerraum, Groß-/Kleinschreibung, Zahlengenauigkeit, Spalten
   ignorieren.
5. **Vergleichsansicht**: zwei Gitter nebeneinander mit gekoppeltem Scrollen oder ein zusammengeführtes Gitter mit
   Zustands-Spalte; Farben über Tokens (geändert/neu/gelöscht aus Prompt 031); Filter „nur Unterschiede“; Sprung zum
   nächsten Unterschied; Zusammenfassung in Zahlen; Export der Unterschiede.
6. Typischer Ablauf als Aktion: „Erneut ausführen und mit vorherigem Ergebnis vergleichen“.

## Akzeptanzkriterien

- Skript mit 20 `SELECT`s: 20 Reiter, per Tastatur wechselbar; angepinnte bleiben über den nächsten Lauf.
- Zwei Ergebnisse mit je 1 Mio. Zeilen vergleichen: läuft im Hintergrund, abbrechbar, Zahlen stimmen (Test mit
  bekannten Abweichungen).
- Doppelte Schlüssel in einer Seite werden gemeldet statt falsch zugeordnet.

## Tests

Rust: Vergleichs-Katalog (Schlüssel, Duplikate, NULL, Toleranzen), große Mengen. Frontend: Reiter und Ansicht mit
Fake.
