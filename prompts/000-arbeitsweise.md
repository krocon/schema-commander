# Prompt 000: Gemeinsame Arbeitsweise für alle Feature-Prompts

> Gilt für alle Prompts in `prompts/` (Index und Reihenfolge: `prompts/README.md`). Jeder Feature-Prompt verweist
> hierher und beschreibt nur, was für sein Feature dazukommt. **Zuerst diese Datei lesen, dann den Feature-Prompt.**
> Bei Widersprüchen gilt diese Datei, außer der Feature-Prompt weicht ausdrücklich ab.
> Übernommen aus `files-and-folders-tauri/prompts/000-arbeitsweise.md` und an Schema Commander angepasst.

---

## 1. Vor dem Start

- `CLAUDE.md` vollständig lesen, dazu `docs/best-practices.md`, `docs/architecture.md`, `docs/themes.md` und den im
  Feature-Prompt genannten Abschnitt aus `docs/feature-analysis.md` (dort steht, welches Werkzeug das Vorbild ist).
- **Abhängigkeiten prüfen:** Jeder Prompt nennt oben, welche Prompts vorher umgesetzt sein sollten
  (`prompts/README.md` → Status). Fehlt etwas: anhalten und fragen.
- Prüfen, ob es schon einen Stand gibt (Branch `feat/<slug>`, Design-Dokument, abgehakte Definition of Done).
- Toolchain prüfen (`node -v` ≥ 22.22.3, `pnpm -v`, `cargo -V`), `pnpm install`, einmal `pnpm check` – rote Checks
  vor dem Start sind ein eigener Befund, nicht stillschweigend „mitreparieren“.
- Branch **`feat/<slug>`** von `main`. Commits nach jeder grünen Phase (Conventional Commits). **Kein Push, kein
  Release, kein Force-Push** ohne ausdrückliche Anweisung.
- Taskliste mit einem Eintrag je Phase führen.

## 2. Phasen

| Phase | Ergebnis | Haltepunkt |
|---|---|---|
| 1 | Design-Dokument `prompts/NNN-<slug>.design.md` | 🛑 Freigabe abwarten |
| 2 | Rust: Specs zuerst (rot), dann Implementierung (grün) | Commit |
| 3 | Frontend: Specs zuerst, dann Implementierung | Commit |
| 4 | Ende-zu-Ende in der echten App | |
| 5 | Doku | Commit |
| 6 | Abschlussprüfung + Bericht | |

Kleine Features dürfen Phasen zusammenlegen (in Phase 1 entscheiden und im Design-Dokument festhalten). Reine
Frontend-Features lassen Phase 2 aus.

### Phase 1 – Bestand prüfen und entwerfen 🛑

- Die im Prompt genannten Code-Stellen lesen: das eigene Repo **und**, wo es um Tabelle oder Editor geht, die
  GuiExpert Table (`../video/2026/guiexpert-table/mono/llms.txt`, `instructions.md`) bzw. editlicious
  (`../editlicious/packages/editlicious-editor/README.md`). Tabelle „Baustein → wofür → passt / fehlt / muss erweitert
  werden“. Was in der Tabelle oder im Editor fehlt, wird als Vorschlag für deren Repo festgehalten, nicht umgangen.
- Verhalten des Vorbilds aus `docs/feature-analysis.md` übernehmen oder **begründet** abweichen.
- Für jede Entscheidungsfrage im Prompt: Optionen, Empfehlung, Begründung.
- **Verträge zuerst:** Rust-Commands (Name, Parameter, Rückgabe, Fehlercodes, Events/Channels) und die passenden
  TS-Typen; Tastenkürzel je OS; UI-Skizze (ASCII reicht) mit Fokus-Reihenfolge und ARIA-Rollen.
- **Dialekte:** für jede unterstützte Datenbank festhalten, was gleich ist und was abweicht (Quoting, Typen,
  Systemkatalog, Transaktionen, Limits).
- Tests planen: welche Fälle in Rust, welche im Frontend, welche gegen echte Server, welche nur Ende-zu-Ende.
- Ergebnis als `prompts/NNN-<slug>.design.md` (Kopf: Status, Datum, Entscheidungen; unten Abschnitt „Fortschritt“
  für Sitzungswechsel). **Danach anhalten** und bestätigen lassen.

### Phase 2 – Rust

- Logik in reinen Modulen ohne Tauri (testbar), Command-Schicht dünn.
- Tests: Normalfall, Unicode, `NULL`, leere und sehr große Ergebnisse, sehr breite Zeilen, Binärdaten, Fehler der
  Engine, Verbindungsabbruch, Abbruch mitten in der Abfrage. Treiber zusätzlich gegen echte Server (Container).
- Lange Arbeit: Fortschritt über `tauri::ipc::Channel`, Abbruch-Token, nie auf dem Async-Runtime-Thread blockieren.
  Zerstörendes und alles auf geschützten Verbindungen wird im Backend validiert.
- Geheimnisse nur im Schlüsselbund und mit `zeroize`; nie in Fehlern, Events oder Logs.
- `cargo fmt`, `cargo clippy --all-targets -D warnings`, `cargo test` grün → Commit.

### Phase 3 – Frontend

- Backend nur über die typisierte Fassade (`app/core/...Api`), Fake-Implementierung für Tests in `src/testing/`.
- Zustand mit Signals; Stores je Instanz (kein `providedIn: 'root'`), Globales in Root-Services. Zoneless.
- Tastatur und Funktionen über das Aktionssystem (sobald es da ist), nicht über verstreute `keydown`-Handler.
- **Barrierefreiheit:** sichtbarer Fokus, jede Funktion per Tastatur, Dialoge als `<dialog>` mit Fokusfalle und
  Rückgabe des Fokus, Menüs nach APG-Muster, Live-Region für Statusmeldungen, Kontraste in allen Schemata.
- Daten aus der Datenbank sind Nutzerdaten: nie unescaped in `innerHTML`.
- Styling nur über Tokens aus `src/styles.css` (neue Tokens dort für dark **und** light, im Katalog und in den
  Kontrastpaaren ergänzen; `pnpm contrast`).
- `pnpm format:check`, `pnpm lint`, `pnpm test`, `pnpm build` grün → Commit.

### Phase 4 – Ende-zu-Ende

- Die App wirklich starten (`pnpm tauri dev`) und jedes Akzeptanzkriterium des Prompts durchspielen – mit Daten, die
  Umlaute, Emoji, `NULL`, leere Strings, sehr lange Texte, Binärdaten und viele Zeilen/Spalten enthalten.
- Nur gegen eigens angelegte Testdatenbanken arbeiten, nie gegen echte Daten des Nutzers.
- In einem dunklen und einem hellen Farbschema ansehen.
- Nicht Prüfbares (z. B. Windows von macOS aus) im Bericht ausdrücklich nennen.

### Phase 5 – Doku

- `docs/architecture.md` (Entscheidungen, neue Abhängigkeiten mit Begründung), `docs/roadmap.md` (Status),
  `docs/feature-analysis.md` (Status des Features), README („What works“, Tastenkürzel).
- `CLAUDE.md`, wenn sich Regeln, Befehle oder Layout geändert haben.
- Im Prompt-Index `prompts/README.md` den Status abhaken; Design-Dokument „Fortschritt“ abschließen.
- **Fertige Prompts nach `prompts/done/` verschieben** (Auftrag, `*.design.md` und zugehörige Bilder; `git mv`, Links
  im Index auf `done/` umstellen) – in `prompts/` liegen nur offene Prompts.

### Phase 6 – Abschlussprüfung

```bash
pnpm check
pnpm tauri build --debug --no-bundle
```

Danach Ende-zu-Ende-Durchlauf (Phase 4) wiederholen. Bei Verbindungen, Geheimnissen, schreibenden Operationen und
allem Sicherheitsrelevanten: Review durch einen separaten Agenten, der den Code nicht geschrieben hat (Schwerpunkte
nennt der Feature-Prompt).

**Abschlussbericht** (kurz, konkret): Was wurde geändert? Welche Dateien? Welche Befehle liefen tatsächlich? Welche
Checks grün? Welche Probleme/Einschränkungen (inkl. nicht getesteter Plattformen und Datenbanken)? Nächster Schritt?
Commits (Hash + Titel). Gefundene Lücken in der GuiExpert Table oder in editlicious mit Vorschlag für deren Repo.

## 3. Definition of Done (zusätzlich zu der des Feature-Prompts)

- [ ] Design-Dokument freigegeben 🛑
- [ ] Rust- und Frontend-Specs grün, `pnpm check` grün, Debug-Build der App gebaut
- [ ] Akzeptanzkriterien Ende-zu-Ende geprüft (Testdaten mit Unicode, `NULL`, großen Mengen)
- [ ] Tastaturbedienung und Fokus geprüft, ein dunkles und ein helles Schema angesehen
- [ ] Doku aktuell, Prompt-Status abgehakt
- [ ] Commits auf `feat/<slug>`, kein Push/Release ohne Anweisung
