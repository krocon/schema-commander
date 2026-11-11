# Verteilung über Paketquellen (Anleitung, nichts eingerichtet)

> Ergänzt [`release.md`](release.md). Voraussetzung für alles hier: ein veröffentlichtes Release mit Paketen und
> `SHA256SUMS.txt`. Einreichen und Veröffentlichen sind Marcs Schritte.

| Quelle | System | Was man einreicht | Voraussetzung |
|---|---|---|---|
| GitHub Releases | alle | die Pakete des Workflows | – (der Grundweg) |
| Homebrew Cask | macOS | eine Cask-Datei (`version`, `sha256`, `url` der `.dmg`, `app "Schema Commander.app"`) als Pull Request an `homebrew/homebrew-cask` oder in einem eigenen Tap `krocon/homebrew-tap` | **signiert und notarisiert** – unsignierte Apps nimmt homebrew-cask nicht; ein eigener Tap geht auch ohne |
| winget | Windows | Manifest (`wingetcreate new <url der setup.exe>`) als Pull Request an `microsoft/winget-pkgs` | stabile Download-URL, SHA-256; signiert empfohlen (sonst SmartScreen) |
| Scoop | Windows | JSON-Manifest in einem eigenen Bucket | – |
| AUR | Arch Linux | `PKGBUILD` (`schema-commander-bin`, entpackt das `.deb` oder nutzt das AppImage) | AUR-Konto |
| Flatpak / Flathub | Linux | Manifest, das aus dem Quelltext baut | Flathub baut selbst und ohne Netz: Cargo- und npm-Quellen müssen als Listen vorliegen – eigener Aufwand |

## Homebrew, eigener Tap (der kürzeste Weg)

```ruby
cask "schema-commander" do
  version "X.Y.Z"
  sha256 "…"            # aus SHA256SUMS.txt
  url "https://github.com/krocon/schema-commander/releases/download/v#{version}/Schema.Commander_#{version}_universal.dmg"
  name "Schema Commander"
  desc "Keyboard-driven SQL client"
  homepage "https://github.com/krocon/schema-commander"
  app "Schema Commander.app"
end
```

Der Dateiname der `.dmg` steht erst nach dem ersten Lauf des Workflows fest – vor dem Einreichen gegen das Release
prüfen.

## Nach jedem Release

Version und Prüfsumme in den Manifesten erhöhen (winget: `wingetcreate update`, Homebrew: `brew bump-cask-pr`).
Automatisieren lohnt erst, wenn es regelmäßige Releases gibt.
