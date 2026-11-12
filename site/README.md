# Produktseite Schema Commander

Statische Seite auf Englisch, fünf HTML-Dateien mit einem gemeinsamen Stylesheet und einem Skript – aufgebaut wie
die Seite von Log Commander (`../log-commander/site`).
**Keine Webfonts, keine Tracker, keine Anfragen an fremde Server, keine Cookies.** Ohne JavaScript bleibt alles
lesbar; das Skript liefert nur Bewegung und die Live-Demo.

| Datei | Inhalt |
|---|---|
| `index.html` | Start: Live-Demo im Hero (Anweisungen, sortierbares Gitter, Filter, Kennzahlen der Auswahl), Zahlen, Tour mit angeheftetem Fenster, Datenbanken, KI, Farbschemata, Plattformen |
| `features.html` | alle Funktionen in sechs Kapiteln (Write, Read, Change, Understand, Operate, The app) |
| `databases.html` | Datenbanken, Verbinden (Schlüsselbund, SSH-Tunnel, TLS, Import), Schutzstufen, Unterschiede je Dialekt |
| `ai.html` | KI-Steuerung über MCP: vier Stufen, acht Werkzeuge, Grenzen, Einrichtung (Fakten aus `docs/mcp.md`) |
| `keyboard.html` | alle Kürzel je System (erzeugt aus Katalog und Keymaps), wo eine Taste wirkt, Fragen |
| `site.css`, `site.js` | Design-Tokens der App (dark/light nach System), Bewegung, Demo |
| `img/icon.png`, `favicon.png` | das App-Icon, kopiert vom Build |

## Bauen

```bash
node site/build.mjs
```

Schreibt, was die Seite aus dem Repository nimmt:

- `favicon.png` und `img/icon.png` aus `src-tauri/icons/`,
- die Schalter der Farbschemata in `index.html` aus `src/app/core/theme/themes/*.json` (die echten Farbwerte),
- die Kürzel-Tabelle in `keyboard.html` aus `action-catalog.ts` und `keymaps/*.json`, dazu die Zahl der Aktionen
  auf der Startseite.

`node site/build.mjs --check` schreibt nichts und scheitert, wenn eine Datei veraltet wäre. Nach geänderten
Keymaps, Aktionen oder Farbschemata erneut bauen.

## Ansehen und hochladen

Lokal `site/index.html` im Browser öffnen (geht auch über `file://`). Zum Veröffentlichen den **Inhalt** von `site/`
ohne `build.mjs` und `README.md` auf den Webspace kopieren; alle Pfade sind relativ. `og:image` ist ebenfalls relativ
und sollte nach dem Hochladen auf die absolute Adresse gesetzt werden.

## Hinweise

- **Keine Screenshots:** Die Bilder sind kleine Szenen aus HTML (`.scene`, `.code`, `.grid`, `.plan`, `.er` in
  `site.css`), gezeichnet mit den Tokens der App. Darum folgen sie dem hellen und dunklen Schema – und die
  Farbschema-Auswahl setzt einfach die Tokens der Szene auf die Werte des gewählten Schemas. Echte Screenshots
  können später dazukommen (`docs/screenshots/` gibt es noch nicht).
- **Aussagen wie in der README und in `docs/`:** Datenbanken, Grenzen der KI-Steuerung, Plattformen und „nicht
  signiert“ stammen von dort. Ändert sich das, die Seite mitziehen. Messwerte nennt die Seite keine: Es gibt noch
  keine veröffentlichten.
- **Download:** Die Knöpfe zeigen auf die Release-Seite bei GitHub (`/releases`), nicht auf `/releases/latest` –
  solange ein Release nur als Entwurf besteht, liefe der zweite ins Leere.
- **Motion:** Jede Bewegung hat eine Fassung für `prefers-reduced-motion` (die Demo tippt dann nicht, sie zeigt
  das Ergebnis sofort).
- **Die Seite als Skript:** Jeder Abschnitt beginnt mit einer Zeilennummer und einem Schlüsselwort (`.eyebrow`,
  `.kw`) in den Farben des Editors.
- **Demo:** rein im Browser (`sqlDemo` in `site.js`): feste Daten, vorbereitete Anweisungen, kein SQL-Parser. Sie
  liest nichts und sendet nichts. Summen rechnet sie in ganzen Cent, wie die App exakt rechnet.
