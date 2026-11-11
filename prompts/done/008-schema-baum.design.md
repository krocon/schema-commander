# Design 008: Schema-Baum

> **Status:** umgesetzt am 11.11.2026 (ohne Freigabe-Halt, Marcs Anweisung vom 11.11.2026) · **Branch:**
> `feat/schema-baum` · Auftrag: [008-schema-baum.md](008-schema-baum.md) · Feature B1

## Entscheidungen

| Nr. | Frage | Entscheidung | Grund |
|---|---|---|---|
| E1 | Katalogabfragen | neue Methode `Session::ask(sql, params, …)` in allen vier Treibern: **gebundene** Textparameter (`$1`, `?`, `@P1`, `?1`), jede Spalte kommt als Text oder NULL. `db/meta.rs` baut darauf `schemas`, `objects`, `table`, `search` | kein Name wird in SQL geklebt. Einzige Ausnahme: `"schema".sqlite_schema` für die Trigger einer SQLite-Datei – ein Schema lässt sich dort nicht binden; der Name kommt aus `pragma_database_list` und geht durch `quote_always` (Test mit Injektionsversuch) |
| E2 | Ebenen | Verbindung → **Schemata** → Arten (Tabellen, Views, materialisierte Views, Routinen, Sequenzen, Typen) → Objekt → Spalten, dann „Indizes“, „Schlüssel“, „Trigger“. Schema heißt: Schemata der verbundenen Datenbank (PostgreSQL, SQL Server), Datenbanken des Servers (MySQL/MariaDB), angehängte Dateien (SQLite) | über eine Sitzung erreicht PostgreSQL nur seine Datenbank; eine Ebene „Datenbanken“ bräuchte eigene Verbindungen (später) |
| E3 | Quoting | reine Funktion `meta::quote(name, kind)` in Rust; jeder Knoten bringt seinen Namen **fertig gequotet** mit (`quoted`). Gequotet wird nur, wo nötig: Leerzeichen, Umlaute, Ziffer vorn, Großbuchstaben in PostgreSQL, reservierte Wörter (eine gemeinsame, großzügige Liste) | eine Wahrheit, kein Aufruf über die Brücke fürs Einfügen; zu oft gequotet schadet nicht |
| E4 | Zeilenzahlen | **Schätzung aus der Statistik** (`reltuples`, `TABLE_ROWS`, `sys.partitions`), gerundet mit `~`; SQLite hat keine; nie gezählt | kostet nichts; exakt zählt man mit einer Abfrage |
| E5 | Wie viel vorab? | strikt **bei Bedarf**: Schemata beim Verbinden, die Objekte eines Schemas beim Aufklappen (das aktuelle Schema klappt von selbst auf), die Teile einer Tabelle beim Aufklappen – in einem Aufruf | 50 000 Objekte sollen nicht beim Verbinden geladen werden; was die Vervollständigung braucht, entscheidet Prompt 021 |
| E6 | Ein Baum für alle? | **nur die aktive Verbindung** (die des Tabs vorn); was aufgeklappt war, bleibt je Verbindung im Speicher | die Verbindungsliste steht darüber; ein Baum über alle Verbindungen wäre vor allem lang |
| E7 | Zwischenspeicher | im **Frontend** (`SchemaStore`, Root), nicht in Rust: die Commands sind zustandslos. Verworfen beim Trennen, bei „Aktualisieren“ (`F5`) und nach einer Anweisung, die das Schema ändert (`CREATE`, `ALTER`, `DROP`, `RENAME`, `TRUNCATE`, `USE` …) – dann wird neu gelesen, was offen war. Antworten von vor einem Aktualisieren werden verworfen (Zähler je Verbindung) | der Baum zeigt aus Signals; ein zweiter Speicher in Rust wäre nur eine zweite Wahrheit |
| E8 | Baum-Widget | **eigene virtuelle Liste** (`role="tree"`, `aria-activedescendant`, `aria-level/-expanded/-selected`), nicht die GuiExpert Table | die Tabelle ist ein Gitter: Rollen und Tasten eines Baums nach APG gäbe es nur gegen sie. Im DOM stehen nur die sichtbaren Zeilen (35 bei 20 000) |
| E9 | Filter | auf Geladenes sofort (Teilwort oder Buchstaben in Reihenfolge), Treffer mit Schema und Art, alles aufgeklappt. Für nie geöffnete Schemata fragt der Store 300 ms nach dem letzten Tastendruck `meta_search` (LIKE mit gebundenem Muster, höchstens 200 Tabellen/Views) | – |
| E10 | Aktionen | je Knoten als Aktionen der App (Gruppe „Schema“, auch in der Palette): Daten öffnen (neuer Tab, `SELECT … LIMIT 200` bzw. `TOP 200`, läuft sofort), Name einfügen (Enter, Doppelklick), Name / qualifizierten Namen kopieren, SELECT-, INSERT-, UPDATE-Vorlage (INSERT/UPDATE als Snippet mit Platzhaltern), Aktualisieren, Systemschemata ein/aus, Filter (`Mod+Shift+O`). Kontextmenü (`shared/context-menu.ts`, APG) per Rechtsklick, Kontextmenü-Taste, `Umschalt+F10` | – |
| E11 | Qualifizieren | Objekte des aktuellen Schemas ohne Schema, alle anderen mit | so schreibt man es selbst |
| E12 | Sitzung | Metadaten laufen auf **derselben Sitzung** wie die Anweisungen (eine je Profil) | läuft gerade eine Anweisung, wartet der Baum; eine zweite Verbindung nur für den Katalog wäre der Ausweg (offen) |

## Objektart × Datenbank

| | PostgreSQL | MySQL / MariaDB | SQL Server | SQLite |
|---|---|---|---|---|
| Schemata | `pg_namespace` | `SCHEMATA` | `sys.schemas` | `pragma_database_list` |
| Tabellen, Views | `pg_class` (auch partitioniert, fremd) | `TABLES` | `sys.objects` U, V | `pragma_table_list` |
| Materialisierte Views | `pg_class` m | – | – | – |
| Routinen | `pg_proc` mit Argumenten | `ROUTINES` | `sys.objects` P, FN, IF, TF | – |
| Sequenzen | `pg_class` S | MariaDB: `TABLES` | `sys.objects` SO | – |
| Typen | `pg_type` (enum, domain, range, composite) | – | `sys.types` (eigene) | – |
| Spalten | `pg_attribute`, `format_type` | `COLUMNS` | `sys.columns`, `sys.types` | `pragma_table_info` |
| Indizes | `pg_index`, `pg_get_indexdef` | `STATISTICS` | `sys.indexes` | `pragma_index_list/_info` |
| Schlüssel | `pg_constraint` | `TABLE_CONSTRAINTS`, `KEY_COLUMN_USAGE` | `sys.key_constraints`, `foreign_keys`, `check_constraints` | Primärschlüssel, `pragma_foreign_key_list` |
| Trigger | `pg_trigger` | `TRIGGERS` | `sys.triggers` | `sqlite_schema` |

SQL Server braucht `STRING_AGG` (ab 2017).

## Geprüft

- Rust: Quoting-Katalog (17 Namen × 4 Dialekte), Demo-Datenbank, Injektionsversuche; gegen die Container
  PostgreSQL 17, MySQL 8, MariaDB, SQL Server 2022 je ein Test mit Tabellen, View, Routine, Index, Schlüsseln,
  Trigger, Namen mit Leerzeichen/Umlaut/Schlüsselwort und Namenssuche (`pnpm rust:test:db`, 16 Tests grün).
- Frontend: Baum-Logik, Store mit Fake (Laden, Fehler am Knoten, veraltete Antworten, Filter, Neuladen nach DDL).
- Im Browser mit nachgebildetem Backend, Schema mit 20 000 Tabellen: Aufklappen sofort, 35 Zeilen im DOM, Filter
  je Tastendruck 4–35 ms, Rechtefehler am Knoten bei benutzbarem Rest, Tasten (Pfeile, Ende), Kontextmenü,
  UPDATE-Vorlage als Snippet im Editor, „Daten öffnen“ in neuem Tab.

## Nicht umgesetzt, nicht geprüft

- **Mehrfachauswahl**, **Favoriten**, einzelne Schemata an-/abwählen; der aufgeklappte Zustand überlebt keinen
  Neustart. **DDL anzeigen**: Prompt 019.
- **Ziehen in den Editor**: die Zeilen sind ziehbar (Text = gequoteter Name), ob der Editor den Text annimmt, ist
  ungeprüft; unter Windows fängt Tauris Datei-Drop HTML5-Drag & Drop ab.
- „Aktualisieren“ liest den ganzen Baum der Verbindung neu, nicht einen Ast.
- Das Akzeptanzkriterium „20 000 Tabellen unter 1 s“ ist nur mit nachgebildetem Backend gemessen, nicht gegen
  einen Server mit so vielen Tabellen. Rechtefehler eines echten Servers wurden nicht provoziert.
- Kopieren nutzt `navigator.clipboard` – im nativen Fenster ungeprüft (Prompt 009 regelt die Zwischenablage).
- Das native Fenster wurde nicht von Hand geprüft.
