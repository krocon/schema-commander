# Design 040: Zeile als Formular

> **Status:** umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/zeilen-formular` · Auftrag: [040-zeilen-formular.md](040-zeilen-formular.md) · Feature D4

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Wo | als **Seitenfeld neben dem Gitter** (die Alternative des Prompts), an der Stelle der Wert-Ansicht (026): `TOGGLE_ROW_FORM` (`Mod+K Mod+L`) zeigt das Formular, `TOGGLE_VALUE_PANEL` die Wert-Ansicht – eines von beiden. Gitter und Formular sind so zugleich da | Aufgabe 1; das Gitter bleibt der Ort der Zeilen |
| E2 | Welche Zeile | die Zeile des Cursors im Gitter. Das Formular liest sie mit `result_window(…, 1)` aus dem Ergebnisspeicher – nur, wenn die Zeile wechselt (nicht bei jedem Spaltenwechsel) | Zeilenwechsel ohne Verzögerung |
| E3 | Navigation | ⏮ ◀ ▶ ⏭ und „Gehe zu Zeile“ bewegen den **Cursor des Gitters** (`ResultGridHandle.goTo`) – die Spalte bleibt, das Formular folgt. Ein Klick auf einen Namen setzt den Cursor auf dieses Feld | Aufgabe 3; ein Zustand statt zwei |
| E4 | Darstellung | Tabelle „Spalte – Typ – Wert“; Werte über `showCell` (007), höchstens fünf Zeilen hoch; ab 300 Zeichen „mehr“ → die Wert-Ansicht übernimmt den Platz | Aufgabe 2; siehe „Nicht umgesetzt“ |
| E5 | Filter | über Spaltennamen (Teil des Namens), „nur mit Wert“, „nur geänderte“ | Aufgabe 4, Akzeptanzkriterium 1 |
| E6 | Nebeneinander | „Markierte Zeilen nebeneinander“: bis zu acht markierte Zeilen als Spalten, eine Zeile je Spalte des Ergebnisses; wo sich die Werte unterscheiden, ist die Zeile farbig (`--cell-changed-*`). „Nur geänderte“ heißt dort: nur Unterschiede | Aufgabe 5, Akzeptanzkriterium 2 |
| E7 | Bearbeiten | „Bearbeiten“ an einem Feld setzt den Cursor auf die Zelle und ruft `EditService.begin` – derselbe Puffer, dieselbe Eingabezeile wie im Gitter. Was im Puffer wartet, zeigt das Formular (farbig) | Aufgabe 6 |
| E8 | Kopieren | Feld, „Name: Wert“-Liste, JSON-Objekt der Zeile – im Fenster aus der gelesenen Zeile gebaut (eine Zeile; die Extraktoren aus 009 sind für Auswahlen im Speicher). Dezimalzahlen bleiben im JSON der Text, der sie sind | Aufgabe 7 |

## Geprüft

- **Rein** (5 Tests): Felder samt Puffer; Filter (auch 300 Spalten); transponiert mit Unterschieden, Auswahl
  höchstens acht Zeilen; Liste und JSON; Schritte und Zeilennummer.
- **Komponente** (6 Tests): Zeile als Text (ein `<b>` im Wert bleibt Text), nur bei Zeilenwechsel neu gelesen;
  Navigation bewegt den Cursor des Gitters und hält das Feld; Filter und Puffer; drei Zeilen nebeneinander mit
  Unterschieden; Kopieren; langer Wert → Wert-Ansicht; ohne Zeile.
- **Im Browser** mit nachgebildetem Backend: Ergebnis mit 40 Zeilen, Formular neben dem Gitter, Cursor auf Zeile 4
  → „Zeile 4 von 40“ mit ihren Feldern. **Nicht bedient:** das native Fenster; Bearbeiten aus dem Formular nur über
  die Tests.
- `pnpm check` grün.

## Nicht umgesetzt

- **GuiExpert Table** für das Formular: Es ist eine einfache Tabelle (eine Zeile hat so viele Einträge wie das
  Ergebnis Spalten – auch 300 sind keine Last).
- „Je Ergebnis gemerkt“: Sichtbarkeit ist eine Einstellung der App (wie die Wert-Ansicht), nicht je Ergebnis.
- Kein eigenes Kürzel für vorige/nächste Zeile im Formular: Im Gitter sind es die Pfeiltasten; die Knöpfe des
  Formulars sind mit Tab erreichbar.
- Screenreader: Zeilenkopf ist der Spaltenname (`th scope="row"`), der Wert folgt – nicht mit einem Screenreader
  geprüft.
