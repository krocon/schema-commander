# Prompt 030: Fremdschlüsseln folgen

> **Slug:** `fremdschluessel-folgen` · **Feature:** D10 · **Braucht:** 008, 027 · **Umfang:** M
> Lies zuerst `prompts/000-arbeitsweise.md`. Vorbild: DataGrip (Navigate → Related Rows), DbGate (Master-Detail),
> Beekeeper Studio.

## Ziel

Von einer Zeile zu ihren Verwandten: Klick auf `customer_id = 42` zeigt den Kunden; an einer Kundenzeile sieht man,
welche Bestellungen auf sie zeigen.

## Aufgaben

1. **Fremdschlüssel kennen**: aus den Metadaten (Prompt 008), auch zusammengesetzte Schlüssel und Verweise über
   Schemagrenzen. Bei Abfrage-Ergebnissen die Herkunft der Spalten nutzen (Tabelle/Spalte aus den Metadaten des
   Treibers), sonst ist die Funktion aus.
2. **Vorwärts** (Zelle mit Fremdschlüssel): Marke in der Zelle; Aktion „Zur referenzierten Zeile“ öffnet die
   Zieltabelle gefiltert (Tabellen-Ansicht aus Prompt 027) – im selben Tab, neuen Tab oder als **Vorschau-Popover**
   mit der Zielzeile (Modifier/Einstellung).
3. **Rückwärts** (Zeile mit Primärschlüssel): Liste „wird referenziert von“ mit Tabelle, Spalte und – auf Wunsch –
   Anzahl; Auswahl öffnet die gefilterten Zeilen.
4. **Mehrere Zeilen** markiert: Filter als `IN (…)` bzw. Verbund, gebunden; Obergrenze mit Hinweis.
5. **Pfad und Zurück**: Brotkrumen („orders → customer → country“), Zurück/Vor wie im Browser.
6. **Virtuelle Beziehungen**: Wo kein Fremdschlüssel definiert ist, kann der Nutzer selbst eine Beziehung anlegen
   (Spalte → Tabelle.Spalte), gespeichert je Verbindung. Vorschläge aus Namensmustern (`*_id`) nur als Angebot.
7. Optional: **Master-Detail** – untere Tabelle zeigt die abhängigen Zeilen zur aktuellen Zeile oben.

## Akzeptanzkriterien

- Zusammengesetzter Fremdschlüssel, `NULL` im Schlüssel, Verweis auf sich selbst (Baum) funktionieren.
- Alle erzeugten Anweisungen binden ihre Werte; Bezeichner sind gequotet.
- Vollständig per Tastatur (Kürzel für vorwärts, Menü für rückwärts, Zurück).

## Tests

Rust gegen Container: Beziehungen je Dialekt, SQL-Erzeugung. Frontend: Navigation und Verlauf mit Fake.
