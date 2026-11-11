# Design 017: Einstellungen und Sprache

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/einstellungen-sprache` · Auftrag: [017-einstellungen-sprache.md](017-einstellungen-sprache.md) · Feature G3

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Sprachkern | `core/i18n/i18n.ts` aus files-and-folders-tauri übernommen (gleicher Autor, MIT): `translatable(name, en, { de })` liefert einen Proxy, der bei jedem Zugriff das Sprach-Signal liest; `phrasebook` für lange Listen (Farb-Tokens); `locale()` für `Intl` | keine Bibliothek; Templates und `computed`s folgen einem Wechsel ohne Neustart |
| E2 | Kataloge | je Feature `*-texts.ts` (Englisch, Quelle) und `*-texts.de.ts` (`Translation<typeof …_EN>`, typgeprüft); Allgemeines in `core/i18n/common-texts.ts`; Aktionsnamen in `action-catalog.ts` (englisch) + `action-catalog.de.ts` | wie fnf; ein fehlender oder falsch gebauter deutscher Eintrag ist ein Übersetzungsfehler des Compilers |
| E3 | Nie beim Laden kopieren | Kein `const X = TEXTS.y` auf Modulebene; Tabellen halten Schlüssel oder Funktionen, gelesen wird beim Aufruf | sonst bliebe der Text nach einem Sprachwechsel stehen |
| E4 | Was erzwingt die Regel? | `scripts/check-texts.mjs` (`pnpm texts`, Teil von `pnpm check`): schlägt an bei Text in einem Inline-Template (Textknoten, statisches `title`/`aria-label`/`placeholder`/`label`/`alt`, Zeichenkette in Bindung oder Interpolation, die wie ein Text aussieht) und bei Umlauten/ß außerhalb von `*.de.ts`. Ausnahme je Zeile mit `texts-ok: Grund`. Dazu `catalogs.spec.ts`: jeder Katalog ist registriert, Deutsch hat jeden Schlüssel mit gleicher Signatur und ist übersetzt | eine ESLint-Regel für Angular-Templates hätte ein Plugin gebraucht; das Skript ist 150 Zeilen und hat eigene Tests |
| E5 | Grenze des Prüfers | Deutsche Zeichenketten **ohne Umlaut** im TypeScript-Code (nicht im Template) erkennt er nicht | ein Wörterbuch wäre nötig; die Umstellung wurde Datei für Datei gelesen |
| E6 | Sprache der Tests | Die Specs laufen deutsch (`src/testing/setup.ts` setzt vor jedem Test `de`): Sie waren vor den Katalogen da und prüfen so die Übersetzung; das Englische prüft `catalogs.spec.ts` auf Vollständigkeit | 500 Erwartungen umzuschreiben hätte nichts geprüft, was der Katalogtest nicht prüft |
| E7 | Fehlertexte | `errorText(code)`/`describeError` lesen den Katalog; die Meldung des Datenbankservers bleibt unübersetzt und wird angehängt | Auftrag |
| E8 | Einstellungsmodell | `Settings` bleibt ein flaches, von Hand geprüftes Objekt (`mergeSettings`: jeder Wert einzeln, defekt = Vorgabe). Neu: Sprache, Editor (Schrift, Größe, Tab-Breite, Umbruch, Zeilennummern, Vorschläge), Ergebnis (Schriftgröße, Zeilenhöhe, NULL-Darstellung), Auto-Commit für neue Tabs. Der Dialog hat ein eigenes Schema (`settings-logic.ts`: Schlüssel, Gruppe, Art, Grenzen); ein Test hält Schema und `mergeSettings` zusammen | das Umstellen aller Leser auf Punkt-Schlüssel wie in fnf hätte jede Datei berührt, ohne etwas zu gewinnen |
| E9 | Dialog | Gruppen links als senkrechte Tab-Liste (APG), Suche über Namen, Hilfe, Gruppe und Auswahlwerte in der Sprache auf dem Bildschirm; jede Änderung wirkt sofort; „↺“ je Wert, „Alle zurücksetzen“ mit Rückfrage. **Keine Signal Forms**: es gibt nichts abzuschicken oder zu verwerfen, jeder Wert ist schon ein Signal des `SettingsService` | Abweichung vom Auftrag, begründet: eine Formularschicht hielte eine zweite Kopie der Werte |
| E10 | Export/Import | JSON `{ format, version, settings }`; ohne `activeConnection`, `historyOff`, `recentActions` (benennen Dinge dieses Rechners). Import: jeder Wert einzeln durch `mergeSettings`; ein abgelehnter oder unbekannter Wert lässt stehen, was gilt. Geheimnisse gibt es in den Einstellungen nicht | Auftrag |
| E11 | Editor | `SqlEditor` reicht Schrift, Größe, Tab-Breite, Umbruch, Zeilennummern, Vorschläge und `ui-language` als Attribute an `<editlicious-editor>` | Auftrag |
| E12 | Native Teile | macOS: `set_language` baut die Menüleiste mit den Wörtern der Sprache neu (`menu.rs`). Datei-Dialoge zeigt das System in seiner Sprache; ihre Titel kommen aus den Katalogen. Windows/Linux haben noch kein Menü (018) | – |
| E13 | Systemsprache | `language: 'system'` (Vorgabe): Deutsch, wenn die erste bevorzugte Sprache des Systems Deutsch ist, sonst Englisch | wie fnf |

## Nicht umgesetzt, nicht geprüft

- **Texte aus Rust**: Die Detailtexte, die das Backend selbst schreibt (`AppError.message`, z. B. bei ungültigen
  Profilen, Import, Sitzung), sind weiter deutsch und werden an den übersetzten Text des Codes angehängt. Sie
  müssten zu Codes mit Werten werden.
- **Speichergrenzen** des Ergebnisspeichers sind keine Einstellung (feste Grenzen in `results.rs`).
- Vervollständigung: nur „beim Tippen vorschlagen“ (Wörter des Textes); mehr kommt mit Prompt 021.
- Formate von Zahlen und Datum im Gitter sind keine Einstellung (nur Tausendertrennung).
- Das native Menü wurde übersetzt und getestet (Wörter), aber nicht im laufenden Programm umgeschaltet.
