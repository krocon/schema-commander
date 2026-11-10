# Prompt E4 (editlicious): Markierungen von außen

> **Repo:** `../editlicious` · **Gebraucht von:** Schema Commander 022, 012 · **Umfang:** M
> Lies `prompts/editlicious/README.md` hier; in editlicious die Wort-Marker und die Übersichtsleiste als Bestand.

## Ziel

Die Seite kann Stellen im Text **kennzeichnen**: Fehler unterstreichen, eine Randmarke setzen, einen Hinweis beim
Überfahren zeigen, die laufende Anweisung hervorheben. Markierungen wandern mit dem Text mit.

## Aufgaben

1. `setMarkers(owner, markers)` ersetzt alle Markierungen eines Besitzers (`'sql-error'`, `'running'` …);
   `clearMarkers(owner)`. Markierung: Bereich, `severity` (`error`/`warning`/`info`/`hint`) oder freie Klasse,
   `message`, optional Randsymbol und Zeilenhintergrund.
2. Darstellung: Wellenlinie bzw. Hintergrund, Symbol im Gutter, Strich in der Übersichtsleiste, Tooltip mit der
   Meldung (auch per Tastatur erreichbar), Farben als CSS-Variablen (s. E1).
3. **Mitwandern**: Einfügen/Löschen davor verschiebt die Markierung; Text innerhalb ändern → nach festgelegter Regel
   anpassen oder entfernen (Option je Markierung).
4. Navigation: Aktionen „nächste/vorige Markierung“ und ein Ereignis `ed-marker-click`.
5. Menge und Leistung: 100 000 Markierungen in einer großen Datei dürfen Scrollen und Tippen nicht bremsen (nur
   Sichtbares rendern).

## Akzeptanzkriterien

- Fehler in Zeile 3, Spalten 8–13: Unterstreichung sitzt nach Einfügen von Zeilen davor immer noch am selben Wort.
- Zwei Besitzer stören sich nicht; `clearMarkers('a')` lässt die von `b` stehen.
- Ohne Markierungen ist nichts langsamer als vorher (Messung).
