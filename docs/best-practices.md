# Best Practices – Schema Commander

Verbindliche Regeln für Code in diesem Repo. Zusammengeführt aus den Vorgängerprojekten
(`files-and-folders-tauri`, `log-commander`, `editlicious`: jeweils `CLAUDE.md` und `prompts/000-arbeitsweise.md`)
und Angulars eigenen Vorgaben ([`angular-best-practices.upstream.md`](angular-best-practices.upstream.md), Stand
10.11.2026). Wo sich beide widersprechen, steht es unten ausdrücklich.

## 1. TypeScript

- `strict` mit allem, was `tsconfig.json` einschaltet (`noImplicitOverride`, `noPropertyAccessFromIndexSignature`,
  `noImplicitReturns`, `strictTemplates`).
- Kein `any`; Unbekanntes ist `unknown` und wird geprüft, bevor es benutzt wird (Beispiel: `toAppError`,
  `mergeSettings`). Typ-Inferenz, wo der Typ offensichtlich ist.
- Daten sind `readonly` (Interfaces, Arrays). Zustand ändert sich nur über `set`/`update` eines Signals, nie durch
  Mutation.
- **Reine Logik gehört in eigene Dateien ohne Angular und ohne DOM** (`sql-split.ts`, `result-model.ts`,
  `theme-logic.ts`) mit einer `*.spec.ts` daneben. Komponenten und Stores bleiben dünn.

## 2. Angular 22

Von Angular übernommen:

- Standalone-Komponenten, **kein** `standalone: true` im Decorator (Default).
- Signals für Zustand: `signal`, `computed`, `linkedSignal`, `effect` nur für Seiteneffekte nach außen (DOM,
  Backend), nie um ein Signal aus einem anderen zu füllen.
- `input()`, `output()`, `model()`, `viewChild()` statt Decorators; `inject()` statt Konstruktor-Injektion.
- Host-Bindings im `host`-Objekt, kein `@HostBinding`/`@HostListener`.
- Native Kontrollfluss-Syntax (`@if`, `@for` mit `track`, `@switch`, `@defer`), kein `ngClass`/`ngStyle`, kein
  `CommonModule`.
- Neue Formulare mit Signal Forms (`@angular/forms/signals`), sonst Reactive Forms.
- Kleine Komponenten mit Inline-Template; externe Dateien mit relativem Pfad (`styleUrl: './app.css'`).
- Seltene Dialoge laden mit `@defer (on immediate)` erst bei Bedarf (Startbundle klein halten, Budget in
  `angular.json`).

Unsere Ergänzungen und Abweichungen:

- **Zoneless.** Es gibt kein `zone.js` im Projekt. Nichts verlässt sich auf automatische Change Detection nach
  Timern, Promises oder Events von außen: Der Zustand liegt in Signals, dann stimmt die Anzeige.
- **`changeDetection: ChangeDetectionStrategy.OnPush`**: Angular 22 macht es zum Default und rät, es wegzulassen. Der
  aus den Vorgängern übernommene Code setzt es noch ausdrücklich; das ist unschädlich und bleibt. **Neuer Code lässt
  es weg.**
- **`@Service`**: erst verwenden, wenn die installierte Angular-Version den Decorator exportiert (22.2.5 tut es
  nicht). Bis dahin `@Injectable({ providedIn: 'root' })` für Globales.
- **Tastatur nur über das Aktionssystem** (`core/actions/`, Design 002): keine verstreuten `keydown`-Handler für
  Funktionen; Tooltips zeigen das Kürzel über `actions.hint(id)`.
- **Kein Router**, solange die App ein Fenster mit Tabs ist. „Lazy loading“ heißt hier `@defer` und dynamisches
  `import()` (Farbschemata, Editor).
- **Stores je Instanz**: Was es mehrfach gibt (Abfrage-Tab, Ergebnis, Verbindung), ist ein `@Injectable()` ohne
  `providedIn` und wird im `providers` der Komponente erzeugt. Globales (Einstellungen, Farbschema, Verbindungsliste)
  in Root-Services.
- **Backend nur über typisierte Fassaden**: abstrakte Klasse `*Api` in `app/core/`, Implementierung `Tauri*Api`,
  bereitgestellt in `app.config.ts`. Komponenten rufen nie `invoke()`; die einzige Stelle ist
  `core/backend/call.ts`. Tests ersetzen die Fassade (`src/testing/fake-apis.ts`).
- **Veraltete Antworten verwerfen**: Wer asynchron lädt, zählt seine Anfragen (`QuerySession.run`), die Antwort einer
  überholten Anfrage wird ignoriert.
- **Keine UI-Frameworks** (Material o. ä.). Tabellen sind die GuiExpert Table, der Editor ist editlicious, der Rest
  ist HTML + CSS.
- `NgOptimizedImage` nur für echte statische Bilder; Icons sind Text/SVG.

## 3. CSS und Farbschemata

- **Farben nur als Tokens** (`var(--…)`), nie feste Werte in Komponenten. Quelle ist `src/styles.css` (Blöcke
  `@theme dark` / `@theme light`); jeder neue Token steht in beiden Blöcken, im Katalog `core/theme/tokens.ts` und,
  wenn er Text oder Grafik trägt, in `core/theme/contrast-pairs.json`. `pnpm contrast` prüft WCAG AA für alle
  17 Schemata. Details: [`themes.md`](themes.md).
- Reines CSS mit nativem Nesting, kein SCSS. Komponenten-Styles bleiben unter dem Budget (8 kB Warnung).
- `--ge-table-*` kennt nur `src/styles/ge-table-theme.css`, und nur als `var(--token)` oder `transparent`.
- Der Editor hat eigene Schemata im Shadow DOM; `features/editor/editlicious.ts` ordnet sie unseren zu.

## 4. Barrierefreiheit (WCAG AA)

- Jede Funktion per Tastatur, sichtbarer Fokus (`:focus-visible`), sinnvolle Fokus-Reihenfolge.
- Dialoge als `<dialog>` (modal, Fokusfalle, Fokus zurück), Menüs und Tabs nach den APG-Mustern, Statusmeldungen in
  einer Live-Region (`role="status"`), Fehler mit `role="alert"`.
- Jedes Bedienelement hat einen Namen (`aria-label`, wenn nur ein Symbol zu sehen ist).
- `prefers-reduced-motion` wird beachtet (global in `styles.css`).
- `pnpm lint` enthält die Accessibility-Regeln von angular-eslint für Templates.

## 5. Rust und Tauri 2

- **Logik in reinen Modulen ohne Tauri** (testbar), die Command-Schicht ist dünn (`commands.rs`, später
  `commands/<bereich>.rs`).
- **Commands nie synchron**: `async fn` oder `#[tauri::command(async)]`. Synchrone Commands laufen in Tauri 2 auf dem
  Main-Thread und frieren das Fenster ein. Ausnahme: reine Fenster-/Menü-Commands (`set_window_chrome`).
- **Blockierendes nie auf dem Async-Runtime-Thread** (`spawn_blocking` oder eigene Worker). Lange Arbeit meldet
  Fortschritt über `tauri::ipc::Channel` und ist abbrechbar.
- **Fehler** immer als `AppError { code: snake_case, message }` (`error.rs` ↔ `core/errors/app-error.ts`, von Hand
  synchron, mit Test auf beiden Seiten). Kein `unwrap()`/`expect()` außerhalb von Tests und `run()`.
- **DTO-Vertrag** Rust ↔ TypeScript von Hand synchron (`#[serde(rename_all = "camelCase")]`); jede Änderung auf beiden
  Seiten plus Test.
- **Das Fenster zeigt nur einen Ausschnitt**: große Ergebnisse bleiben in Rust, das Frontend holt Seiten. (Der
  Walking Skeleton schickt noch das ganze Ergebnis mit einer Obergrenze; das ändert der Prompt zum Ergebnisgitter.)
- **Plattformcode** hinter `#[cfg(...)]` bzw. einem Modul `platform/` mit gleicher Signatur je OS. Pfade über
  `std::path`, keine Annahmen über Trennzeichen. CI baut und testet auf Linux, macOS und Windows.
- `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, `cargo test` sind grün, bevor etwas fertig heißt.

## 6. Sicherheit

- **Schmale Commands statt breiter Plugins**: kein `tauri-plugin-fs`, `-shell`, `-sql`. Jede Fähigkeit ist ein
  eigener, validierter Command; `capabilities/default.json` bleibt minimal.
- **CSP strikt** (`tauri.conf.json`). Ausnahmen mit Grund: `style-src 'unsafe-inline'` (Angulars Laufzeit-Styles),
  `'wasm-unsafe-eval'` und `worker-src` (die Engine von editlicious).
- **Geheimnisse** (Passwörter, Schlüssel-Passphrasen, Tokens) nur im Schlüsselbund des Betriebssystems, nie in
  Dateien, Einstellungen, Events oder Logs; im Speicher mit `zeroize`. Nichts verbindet sich ohne Zutun des Nutzers.
  In Rust ist ein Geheimnis ein `db::secrets::Secret` (kein `Serialize`, `Debug` zeigt `***`); im Frontend geht ein
  Passwort nur vom Eingabefeld zur Fassade, wird nie in einem Signal oder Store gehalten und das Feld danach geleert.
  Fehlertexte dürfen nie ein Passwort enthalten (Tests prüfen das).
- **SQL des Nutzers ist Nutzerdaten**: Anweisungen und Ergebnisse nie loggen. Dauerhaft liegen Anweisungstexte nur
  an zwei Stellen, beide in der Hand des Nutzers: in den Sicherungen seiner Tabs und im **Verlauf**
  (`history.sqlite`, abschaltbar, endgültig löschbar) – nie Ergebnisse, nie Parameterwerte. Werte, die die App selbst in SQL
  einsetzt (Filter, Bearbeiten im Gitter), immer als gebundene Parameter, Bezeichner über die Quoting-Funktion des
  Dialekts, nie per String-Verkettung.
- **Jeder Command, der SQL des Nutzers oder der App ausführt, geht durch `ConnectionManager::admit`** (Design 012);
  ein neuer Weg zur Datenbank ohne ihn ist ein Fehler.
- **Zerstörendes braucht eine Bestätigung im Backend-Vertrag** (z. B. `UPDATE`/`DELETE` ohne `WHERE`, alles auf einer
  als „Produktion“ markierten Verbindung), nicht nur einen Dialog im Frontend.
- Daten aus der Datenbank sind fremd: nie unescaped in `innerHTML`.
- TLS-Zertifikate prüft das Betriebssystem (rustls + Plattform-Verifier); „Zertifikat nicht prüfen“ ist eine
  ausdrückliche, sichtbare Einstellung je Verbindung.

## 7. Tests

- **Rust**: Unit-Tests neben dem Code (`#[cfg(test)]`): Normalfall, Unicode, `NULL`, leere und sehr große Ergebnisse,
  Fehler der Engine, Abbruch. Treiber gegen echte Server in Containern (Skript nach dem Vorbild
  `log-commander/scripts/db-test-servers.sh`), in CI nur, wo Docker verfügbar ist.
- **Angular**: Vitest (`*.spec.ts` neben dem Code, `pnpm test`). Reine Logik direkt, Stores mit Fake-Fassaden,
  Komponenten für ihre Zustände (Laden, leer, Fehler, Tastatur). Die GuiExpert Table und der Editor rendern in jsdom
  nur eingeschränkt: Verhalten im echten Fenster prüfen.
- **Nie eine feste Pause und danach eine Annahme.** Auf den Zustand selbst warten; die Bedingung muss vor der Aktion
  falsch sein. Ein flackernder Test wird nicht abgeschwächt, sondern seine Ursache gesucht.
- Jeder Bugfix bekommt zuerst einen roten Test.
- **Ende-zu-Ende**: die echte App starten und die Akzeptanzkriterien durchspielen. Was nicht prüfbar war, steht im
  Bericht.

## 8. Abhängigkeiten, Texte, Git

- Neue Abhängigkeiten (npm oder crates) nur mit Begründung in der Tabelle in [`architecture.md`](architecture.md).
  Reines Rust ohne Systembibliotheken bevorzugen (kein OpenSSL: rustls mit `ring`).
- **Texte stehen in Katalogen** (Prompt 017): je Feature `*-texts.ts` (Englisch, die Quelle) und `*-texts.de.ts`
  (Deutsch, typgeprüft gegen das Englische), gebaut mit `translatable()` aus `core/i18n/i18n.ts`. Kein Text im
  Template, kein deutscher Text außerhalb von `*.de.ts` – `pnpm texts` prüft das.
- **Texte nie beim Laden eines Moduls kopieren** (`const X = TEXTS.y`, Tabellen mit `label: TEXTS.y`): Die Sprache
  wechselt zur Laufzeit. Gelesen wird im Template, in `computed`s oder in Funktionen; Tabellen halten Schlüssel,
  Getter oder Funktionen. Zahlen und Datum über `locale()`.
- **Fehler** zeigt das Fenster über `errorText`/`describeError` (Text zum Code); die Meldung eines
  Datenbankservers bleibt unübersetzt.
- Ein neuer Katalog wird in `core/i18n/catalogs.spec.ts` importiert (Vollständigkeit beider Sprachen); die Specs
  der App laufen deutsch (`src/testing/setup.ts`).
- Pro Prompt ein Branch `feat/<slug>`, Commits nach jeder grünen Phase (Conventional Commits). Push, Release und
  alles Zerstörende (`reset --hard`, Force-Push) nur auf ausdrückliche Anweisung.
