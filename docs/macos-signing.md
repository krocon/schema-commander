# macOS: signieren und notarisieren

> Ergänzt [`release.md`](release.md). Nichts davon ist eingerichtet; die Schritte beschreiben, was Marc braucht.

## Was man braucht

1. Mitgliedschaft im **Apple Developer Program**.
2. Zertifikat **Developer ID Application** (Xcode → Settings → Accounts → Manage Certificates, oder
   developer.apple.com → Certificates). Aus dem Schlüsselbund als `.p12` mit Passwort exportieren.
3. Für die Notarisierung einen **App-Store-Connect-API-Schlüssel** (Users and Access → Integrations → Team Keys,
   Rolle „Developer“): Issuer-Id, Schlüssel-Id, Datei `AuthKey_<id>.p8` (nur einmal ladbar).

## Lokal bauen und prüfen

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)"
export APPLE_API_ISSUER=…  APPLE_API_KEY=…  APPLE_API_KEY_PATH=$HOME/keys/AuthKey_….p8
pnpm tauri build --target universal-apple-darwin
```

```bash
codesign --verify --deep --strict --verbose=2 "src-tauri/target/universal-apple-darwin/release/bundle/macos/Schema Commander.app"
```

```bash
spctl --assess --type execute --verbose "src-tauri/target/universal-apple-darwin/release/bundle/macos/Schema Commander.app"
```

```bash
xcrun stapler validate src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg
```

`spctl` muss „accepted, source=Notarized Developer ID“ sagen.

## In der CI

Die Secrets aus `release.md` setzen. `release.yml` exportiert nur, was gesetzt ist, und schreibt den `.p8` in das
temporäre Verzeichnis des Runners.

## Entitlements

Keine. `bundle.macOS.hardenedRuntime` ist an; die App hat keine Sandbox.

| Fähigkeit | Entitlement nötig? |
|---|---|
| WebView mit JavaScript-JIT und WebAssembly (Editor-Engine im Worker) | nach unserem Verständnis nein – das läuft im WebContent-Prozess von WKWebView. **Im signierten Paket noch nicht geprüft** |
| Netzwerk zu Datenbanken, SSH-Tunnel | nein (keine Sandbox) |
| Schlüsselbund | nein; der Zugriff hängt an der Signatur |
| Dateien lesen/schreiben über die Dialoge des Systems | nein |

Scheitert der Editor im signierten Paket (Worker startet nicht, WebAssembly wird abgelehnt): eine Datei
`src-tauri/entitlements.plist` mit `com.apple.security.cs.allow-jit` anlegen, in `tauri.conf.json` unter
`bundle.macOS.entitlements` eintragen, erneut bauen und prüfen – und das Ergebnis hier festhalten.
