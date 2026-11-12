# Design 041: Mehrere Ergebnisse, Anpinnen, Vergleichen

> **Status:** umgesetzt am 12.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/ergebnisse-vergleichen` · Auftrag: [041-ergebnisse-vergleichen.md](041-ergebnisse-vergleichen.md) · Feature D9

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Unter-Reiter | Ein Reiter je Anweisung des Laufs mit **Titel** (Tabelle der Anweisung, sonst ihr Anfang), **Zeilenzahl** und Zustand; umbenennen mit Doppelklick oder `F2`; `Mod+Alt+←/→` wechselt (Aktionen), in der Leiste die Pfeiltasten (APG). Die Leiste rollt, was daneben steht (Verbrauch, Anpinnen) bleibt sichtbar | Aufgabe 1, Akzeptanzkriterium 1 |
| E2 | Gehaltene Ergebnisse | Neben den Anweisungen des letzten Laufs (`runs`, wie bisher über den Index) hat ein Tab **gehaltene Ergebnisse** (`kept`, Schlüssel `k1` …): angepinnte und die Ergebnisse von Vergleichen. Anpinnen nimmt das Ergebnis aus dem Lauf heraus (`moved`), der Lauf selbst bleibt unberührt – alles, was über den Index einer Anweisung läuft (Fehlermarken, Meldungen, Parameter), ändert sich nicht | Aufgabe 2; kleinster Eingriff in den Lauf |
| E3 | Nächster Lauf | Angepinnte bleiben; gelöste (`pinned: false`) gehen mit dem nächsten Lauf. Einstellung **„Ergebnisse früherer Läufe behalten“**: jeder Lauf bekommt neue Reiter, die alten bleiben ungepinnt – höchstens 20, die ältesten gehen | Aufgabe 2 („immer neuer Reiter“), Aufgabe 1 („Obergrenze“) |
| E4 | Speicher | Die Leiste zeigt „n gehaltene Ergebnisse · Größe“ (`result_usage` aus dem Ergebnisspeicher) und „Gehaltene Ergebnisse schließen“; ein einzelnes schließt `×` oder `Entf` | Aufgabe 2 |
| E5 | Ablösen | `RESULT_DETACH` / `RESULT_DETACH_BESIDE`: neuer Tab mit der Anweisung als Text, das Ergebnis dort gehalten (im Speicher bleibt es, wo es ist); „daneben“ = in die andere Tab-Gruppe (016) | Aufgabe 3 |
| E6 | Vergleich | In Rust über den Ergebnisspeicher (`result_compare.rs`), als Job mit Fortschritt und Abbruch. Über Schlüssel: jede Seite wird der Reihe nach gelesen (links zweimal, rechts zweimal); gemerkt wird je Zeile der rechten Seite ein Fingerabdruck des Schlüssels (128 Bit), ihre Stelle und einer ihrer Zellen (64 Bit) – nie die Zeilen selbst. Nach Position: beide Seiten im Gleichschritt | Aufgabe 4, Akzeptanzkriterium 2 |
| E7 | Ergebnis des Vergleichs | ein **Ergebnis im Speicher**: Spalte `Δ` (Zustand), Spalte `≠` (Namen der geänderten Spalten), dann die gepaarten Spalten. Zustände als Zeichen (`≡ ← → ≠← ≠→ ‼← ‼→`): gleich in jeder Sprache, und keines beginnt in einer Tabellenkalkulation eine Formel. Eine geänderte Zeile steht zweimal da (Werte links, Werte rechts). Dazu eine **Sicht** nur der Unterschiede (`ResultStore::subset`) – „nur Unterschiede“ wechselt nur die Id. So funktionieren Gitter, Kopieren, Export, Suche, Wert-Ansicht und Formular ohne eigene Wege | Aufgabe 5; zusammengeführtes Gitter statt zweier gekoppelter |
| E8 | Doppelte Schlüssel | Ein Schlüssel, der auf **einer** Seite mehrfach vorkommt, ordnet nichts zu: alle Zeilen mit ihm – beider Seiten – stehen als `‼`, werden gezählt, und bis zu zehn solcher Schlüssel nennt der Bericht | Akzeptanzkriterium 3 |
| E9 | Toleranzen | Leerraum am Rand, Groß-/Kleinschreibung, Zahlen gerundet auf n Stellen (als Text gerundet, kaufmännisch; `1.50` = `1.5` erst mit dieser Toleranz), Spalten ignorieren. Sie gelten auch für die Schlüssel. NULL ist gleich NULL und sonst nichts | Aufgabe 4 |
| E10 | Lange Werte | Eine Zelle, von der die Zeile nur den Anfang zeigt (026), wird **ganz** verglichen: ihr ganzer Wert wird stückweise gelesen und als Fingerabdruck verglichen (Toleranzen greifen dort nicht) | sonst wären zwei Texte gleich, die sich nach 32 000 Zeichen unterscheiden |
| E11 | Spalten | Gepaart nach Namen (ohne Groß/Klein), ohne einen gemeinsamen Namen nach Position; was nur eine Seite hat, wird genannt und nicht verglichen. Der Dialog fragt das Backend (`compare_columns`) – eine Regel an einer Stelle | Aufgabe 4 |
| E12 | Schlüssel-Vorschlag | die Schlüssel des letzten Vergleichs dieses Tabs (nach Namen), sonst eine Spalte, die wie ein Schlüssel heißt (`id`, `…_id`), sonst die erste | Aufgabe 4; den Primärschlüssel kennt ein beliebiges Ergebnis nicht |
| E13 | Ansicht | Zeile über dem Gitter: Zahlen, „Nur Unterschiede“, voriger/nächster Unterschied, „Unterschiede exportieren“ (der Export-Dialog aus 011 über die Sicht), Hinweise (doppelte Schlüssel, Unterschiede je Spalte, nicht verglichene Spalten). Farben über die Tokens aus 031 (`--cell-deleted-*`, `--cell-new-*`, `--cell-changed-*`) – keine neuen Tokens | Aufgabe 5 |
| E14 | Nächster Unterschied | Die Sicht der Unterschiede ist eine sortierte Liste von Zeilennummern: `result_neighbour` sucht darin binär | kein Durchlauf durch das Ergebnis |
| E15 | „Erneut ausführen und vergleichen“ | hält das Ergebnis auf dem Schirm, führt den Lauf erneut aus (Parameter wie zuletzt) und vergleicht alt gegen neu – sofort so, wie der Tab zuletzt verglichen hat, sonst fragt der Dialog | Aufgabe 6 |
| E16 | Tabellen-Ansichten | Solange ein gehaltenes Ergebnis auf dem Schirm ist, liest sich `tab.tableView()` als `null`: Bearbeiten, Schlüssel folgen und der Filter der Tabelle fassen es nicht an. Das Ergebnis einer Tabellen-Ansicht selbst lässt sich nicht anpinnen | ein gehaltenes Ergebnis ist kein Stand der Tabelle |

## Geprüft

- **Rust** (13 Tests in `result_compare_tests.rs`): Zuordnung über Schlüssel in beliebiger Reihenfolge; doppelte
  Schlüssel; NULL als Schlüssel und Wert; nach Position (beide Richtungen); Toleranzen einzeln und zusammen;
  Runden als Text (18 Fälle, auch 30 Stellen und Exponenten); Spalten paaren; ein Schlüssel muss in beiden
  Ergebnissen sein; lange Texte und Binärwerte ganz; eine Sicht als Seite; Abbruch lässt nichts zurück; nächster
  Unterschied; **zwei Ergebnisse mit je 1 Mio. Zeilen** in umgekehrter Reihenfolge mit bekannten Abweichungen
  (1 000 fehlen, 1 287 geändert, 500 neu) – die Zahlen stimmen, Fortschritt wird gemeldet (≈ 16 s im Debug-Build).
- **Fenster** (47 Tests): Logik der Reiter (Titel, Reihenfolge, Lauf, Grenze, Schließen, Größen); Logik der
  Ansicht (Farben, Vorschlag, Prüfung, Zahlen); Tab (20 Anweisungen → 20 Reiter; angepinnt bleibt, der Rest wird
  freigegeben; gelöst geht; behalten-Einstellung; Umbenennen; Übergabe an einen anderen Tab; Vergleich mit
  Fortschritt, Abbruch, Fehler; erneut ausführen; nächster Unterschied); Dialog (Spalten, Schlüssel, ohne
  Schlüssel gesperrt, zweimal dasselbe, Fortschritt und Anhalten, sofortiger Vergleich beim zweiten Mal); Zeile
  über dem Gitter (Zahlen, doppelte Schlüssel als Text – ein `<img …>` im Schlüssel bleibt Text –, Umschalten,
  Export); Ablösen im `TabsStore`.
- **Im Browser** mit nachgebildetem Backend: Skript mit drei Anweisungen → drei Reiter mit Titel und Zeilenzahl;
  angepinnt, neuer Lauf → angepinnter Reiter bleibt, Verbrauch steht in der Leiste; „Erneut ausführen und
  vergleichen“ → Dialog mit Vorschlag `id`, Fortschritt, dann das zusammengeführte Gitter farbig; beim zweiten Mal
  ohne Dialog; alle Zeilen ↔ nur Unterschiede; nächster Unterschied setzt den Cursor; `<b>` in einem Wert bleibt
  Text. **Nicht bedient:** das native Fenster; Ablösen in die andere Gruppe und der Export der Unterschiede nur
  über die Tests.
- `pnpm check` grün.

## Review

Kein zweiter Review: Der Vergleich liest nur aus dem Ergebnisspeicher, baut kein SQL und schreibt nichts in eine
Datenbank.

## Nicht umgesetzt

- **Zwei Gitter nebeneinander mit gekoppeltem Scrollen**: gewählt ist das zusammengeführte Gitter (die Alternative
  des Prompts).
- **Primärschlüssel als Vorschlag**: Ein Ergebnis kennt seine Tabelle nicht sicher; vorgeschlagen wird nach Namen
  (E12).
- **Tabellen-Ansichten** anpinnen oder „erneut ausführen und vergleichen“ (E16): dafür die Tabelle mit
  `SELECT` in einem Abfrage-Tab lesen.
- **Lange Werte im Ergebnis des Vergleichs**: Die Zeilen des Vergleichs zeigen von langen Werten den Anfang; den
  ganzen Wert zeigt die Wert-Ansicht am ursprünglichen Ergebnis.
- Gehaltene Ergebnisse überleben keinen Neustart (wie alle Ergebnisse), und die Einstellungen des letzten
  Vergleichs je Tab stehen nur im Speicher.
- Der Vergleich über Schlüssel hält je Zeile der rechten Seite rund 50 Byte im Speicher (1 Mio. Zeilen ≈ 50 MB);
  mehr als 4 Mrd. Zeilen rechts lehnt er ab.
