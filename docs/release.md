# Release und Verteilung

> Stand: Prompt 034 (Design: `prompts/done/034-release.design.md`). **Releases, Tags, Signierung und
> Veröffentlichung nur mit Marcs ausdrücklicher Freigabe.** Lizenz: **MIT** (`LICENSE`, `license` in `Cargo.toml`
> und `package.json`, `bundle.license` in `tauri.conf.json`). Paketquellen: [`distribution.md`](distribution.md),
> macOS-Signierung Schritt für Schritt: [`macos-signing.md`](macos-signing.md).

## Version – eine Quelle

| Datei | Version |
|---|---|
| `package.json` | **Quelle** (`"version"`) |
| `src-tauri/tauri.conf.json` | `"version": "../package.json"` – Tauri liest sie dort (App, Pakete, About) |
| `src-tauri/Cargo.toml`, `Cargo.lock` | Kopie, gesetzt von `scripts/version.mjs` |

```bash
pnpm version:set 0.2.0      # schreibt package.json, Cargo.toml, Cargo.lock (kein Commit, kein Tag)
pnpm version:check          # Teil von `pnpm check` und der CI; der Rust-Test in `about.rs` prüft dasselbe
```

Sichtbar ist die Version im Dialog **Über Schema Commander** (Aktion `SHOW_ABOUT`: Menü Hilfe, unter macOS im
App-Menü) mit Build-Art, Plattform, Tauri- und WebView-Version. „Diagnose kopieren“ legt diese Zeilen für einen
Fehlerbericht in die Zwischenablage – keine Pfade, keine Verbindungen, nichts vom Nutzer.

## Ablauf eines Releases (Checkliste)

1. `main` ist grün (CI auf allen drei Systemen).
2. `pnpm version:set X.Y.Z`, `pnpm notices` (falls sich Abhängigkeiten geändert haben), `pnpm check`, Commit
   `chore: release X.Y.Z`.
3. Notizen: `pnpm release:notes` (Conventional Commits seit dem letzten Tag, gruppiert: Breaking, Features, Fixes,
   Performance, Doku; `chore`/`test`/`ci` ausgeblendet).
4. Tag `vX.Y.Z` pushen **oder** Actions → Release → Run workflow. Der Workflow prüft, dass Tag und Version
   übereinstimmen, baut auf allen drei Systemen und legt einen **Entwurf** an; ein letzter Job hängt
   `SHA256SUMS.txt` mit den Prüfsummen aller Pakete an.
5. Pakete aus dem Entwurf auf je einem Rechner je System installieren und starten (siehe „Prüfen“), Notizen
   einfügen, Entwurf veröffentlichen.

## Pakete je System (`tauri.conf.json` → `bundle`)

| System | Pakete | Einstellungen |
|---|---|---|
| macOS | `.app`, `.dmg` (universal: Apple Silicon + Intel) | `minimumSystemVersion` 12.0, `hardenedRuntime`, Kategorie `DeveloperTool` |
| Windows | `.msi` (WiX), `-setup.exe` (NSIS) | NSIS `installMode: currentUser` (keine Admin-Rechte), Englisch/Deutsch; WebView2 per Bootstrapper |
| Linux | `.deb`, `.rpm`, `.AppImage` | Abhängigkeiten (`libwebkit2gtk-4.1-0`, `libgtk-3-0`) ergänzt Tauri |

In jedem Paket liegt `THIRD-PARTY-NOTICES.txt` (`bundle.resources`); der About-Dialog zeigt die Datei.

## Signierung (vorbereitet, **nicht eingerichtet**)

Ohne Secrets baut `release.yml` **unsignierte** Pakete: macOS warnt über Gatekeeper (Rechtsklick → Öffnen),
Windows über SmartScreen. Geheimnisse stehen nur als Secrets des Repositories, nie in einer Datei.

### macOS – Developer ID und Notarisierung

| Secret | Inhalt |
|---|---|
| `APPLE_CERTIFICATE` | `.p12` des Zertifikats „Developer ID Application“, base64 (`base64 -i cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | Passwort des `.p12` |
| `APPLE_SIGNING_IDENTITY` | z. B. `Developer ID Application: Name (TEAMID)` |
| `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_PRIVATE_KEY` | App-Store-Connect-API-Schlüssel für die Notarisierung (empfohlen): Issuer-Id, Schlüssel-Id, Inhalt der `.p8` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | stattdessen: Apple-Id, app-spezifisches Passwort, Team-Id |

Tauri signiert mit Hardened Runtime und reicht zur Notarisierung ein, sobald die Angaben gesetzt sind.

**Entitlements:** keine gesetzt. Die App hat keine Sandbox; JavaScript und **WebAssembly** (die Engine des Editors
im Worker) laufen im WebContent-Prozess von WKWebView, der Apples eigene JIT-Rechte hat – der App-Prozess braucht
dafür nach unserem Verständnis kein `com.apple.security.cs.allow-jit`. **Nicht geprüft:** ein signiertes,
notarisiertes Paket gab es noch nicht (kein Zertifikat). Erster Punkt der Prüfung nach dem Einrichten: Editor
öffnen, tippen, eine Abfrage ausführen. Scheitert der Worker, ist `bundle.macOS.entitlements` die Stelle
(`macos-signing.md`).

**Schlüsselbund:** Die Passwörter der Verbindungen liegen im Schlüsselbund des Systems. macOS bindet den Zugriff an
die Code-Signatur – ein unsigniertes Paket fragt nach jedem neuen Build einmal; mit Developer-ID-Signatur bleibt
die Erlaubnis über Updates erhalten.

### Windows – Code Signing

| Secret | Inhalt |
|---|---|
| `WINDOWS_CERTIFICATE` | `.pfx`, base64 |
| `WINDOWS_CERTIFICATE_PASSWORD` | Passwort des `.pfx` |

Der Workflow importiert das Zertifikat und setzt `bundle.windows.certificateThumbprint`; Tauri signiert `.exe`,
`.msi` und den NSIS-Installer. Neue OV/EV-Schlüssel liegen meist auf Hardware oder in einem HSM – dann über
`bundle.windows.signCommand` (z. B. Azure Trusted Signing). Entscheidung offen (Kosten).

### Linux

Keine Signatur. `SHA256SUMS.txt` liegt am Release.

## Auto-Update (`tauri-plugin-updater`) – bewertet, **nicht aufgenommen**

| Punkt | Bewertung |
|---|---|
| Nutzen | Updates ohne erneuten Download für Windows, macOS und AppImage (`.deb`/`.rpm`: Paketverwaltung) |
| Voraussetzung | ein eigenes Schlüsselpaar (`pnpm tauri signer generate`): öffentlicher Schlüssel in `tauri.conf.json` (`plugins.updater.pubkey`), privater als Secret `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`); `bundle.createUpdaterArtifacts: true`; Endpunkt `latest.json` der GitHub-Releases (erzeugt `tauri-action`) |
| Sicherheit | Signaturprüfung im Plugin; eine weitere Capability (`updater:default`). **Wer den privaten Schlüssel verliert, kann installierte Versionen nie mehr aktualisieren** – er gehört Marc, nicht in dieses Repository |
| macOS | nur sinnvoll mit signierter und notarisierter App |
| Entscheidung | **nicht jetzt.** Ohne Schlüsselpaar, ohne Signatur und ohne ein erstes öffentliches Release wäre das Plugin eine Abhängigkeit, die nichts tut und nicht geprüft werden kann. Die Stellen sind vorbereitet (Kommentar in `release.yml`) |

So wird es eingeschaltet, wenn es so weit ist: Schlüsselpaar erzeugen und sicher verwahren; `tauri-plugin-updater`
aufnehmen (Begründung in `architecture.md`), `updater:default` in die Capability; Einstellung „beim Start nach
Updates suchen“ (abschaltbar, Vorgabe an) und Aktion „Nach Updates suchen“; gefundene Updates werden **gemeldet**
(Version, Notizen, „Jetzt installieren“/„Später“), nie still installiert; Kanal „stable“ = veröffentlichte
Releases (Entwürfe und Vorabversionen zählen nicht).

## Lizenzhinweise

`THIRD-PARTY-NOTICES.txt` im Wurzelordner, erzeugt mit `pnpm notices` (`scripts/notices.mjs`, ohne weitere
Werkzeuge): die Lizenztexte aller ausgelieferten Teile – Rust-Crates über normale Abhängigkeiten aller
Zielplattformen (`cargo metadata`, also eine Obergrenze) und npm-Laufzeitpakete (`pnpm licenses list --prod`),
darunter `editlicious-editor` mit seiner eigenen `THIRD-PARTY-NOTICES.txt` für die Crates in seinem WebAssembly.
Gleiche Texte stehen einmal mit allen Komponenten; Crates ohne Lizenzdatei bekommen den Standardtext einer
angebotenen Lizenz. `pnpm check`, die CI und der Release-Workflow prüfen mit `pnpm notices:check`, dass die Datei
zu den Abhängigkeiten passt – nach jeder Änderung an `Cargo.lock` oder `pnpm-lock.yaml`: `pnpm notices`.

Stand 034: fast alles MIT, Apache-2.0, BSD, ISC, Zlib, Unicode. **MPL-2.0** in `cssparser`, `cssparser-macros`,
`dtoa-short`, `selectors` (Tauris HTML-Verarbeitung) und `option-ext` (über `dirs`): Copyleft auf Dateiebene,
unverändert genutzt genügt der Hinweis samt Bezugsquelle. **BSL-1.0** (`clipboard-win`, `error-code`) verlangt den
Text nur in Quelltext-Weitergaben; die Crates liefern keine Lizenzdatei mit und stehen deshalb in der Liste „ohne
Lizenzdatei“.

## Prüfen (Akzeptanz)

| System | Was | Stand 034 |
|---|---|---|
| macOS | `.dmg` öffnen, App nach Programme ziehen, starten (unsigniert: Rechtsklick → Öffnen); Editor tippt, Abfrage läuft, About zeigt die Version; App löschen | **offen** – es wurde kein Paket gebaut und kein Tag gesetzt |
| Windows | `-setup.exe` ohne Admin installieren, starten, deinstallieren; `.msi` ebenso | **offen** |
| Linux | `.deb` installieren (`apt install ./…deb`), starten, entfernen; AppImage starten | **offen** |

Der Workflow selbst lief noch nie: Er entsteht aus dem von `files-and-folders-tauri`, wo er Pakete baut; hier
wartet er auf den ersten Tag.
