<p align="center"><img src="public/icon.svg" width="112" alt=""></p>

<h1 align="center">Schema Commander</h1>

<p align="center"><b>A fast, keyboard-driven SQL client for macOS, Windows and Linux.</b></p>

---

Built with [Tauri 2](https://tauri.app), Angular 22 (zoneless, signals) and Rust. The SQL editor is
[editlicious](https://krocon.de/products/editlicious/), the grids are the [GuiExpert Table](https://gui.expert).

> Status: **early development**. Connections, an SQL editor, a result grid and colour schemes work; the schema
> tree, tabs, editing and everything else are planned – see
> [`docs/feature-analysis.md`](docs/feature-analysis.md) and [`prompts/README.md`](prompts/README.md).

## What works

- Connections to PostgreSQL, MySQL/MariaDB, SQL Server and SQLite files: profiles in folders with colour tags,
  passwords only in the keychain of your OS; a demo database in memory to try things out.
  Servers that speak PostgreSQL's protocol work as PostgreSQL connections – tested with CockroachDB and
  TimescaleDB: the app finds out who answers and adapts (cancel, transaction state, catalog)
- Query tabs, each with its own connection and result. Nothing ever asks „save?“: every text is backed up a
  moment after you type and is there again after a restart or a crash; `.sql` files keep their encoding
- SQL editor with syntax highlighting; <kbd>Ctrl/⌘</kbd>+<kbd>Enter</kbd> runs the selection or the statement
  under the caret, <kbd>Ctrl/⌘</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> the whole script – split by the rules of
  the database (dollar quoting, `DELIMITER`, `GO`), one result tab per statement, messages with timings
- Cancel (<kbd>Ctrl/⌘</kbd>+<kbd>.</kbd>) ends a statement on the server and keeps the session; optional time limit
- Result grid with virtual scrolling, sortable and resizable columns
- 17 colour schemes (dark, light, One Dark, Solarized Light, Matrix, Amber …), fixed or following the system –
  and your own: a live editor for every colour with contrast hints, import and export
- Editor and grid follow every scheme
- Every function is an action: command palette (<kbd>Ctrl/⌘</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>), a keymap per
  OS and an editor for your own shortcuts (<kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> <kbd>Ctrl/⌘</kbd>+<kbd>S</kbd>)
- Split view: two tab groups side by side or stacked, each tab on its own connection; the result below or beside
  the editor, hidden or maximised; the sidebar shows connections and schema or the history; a zen mode
- Tables as tables: open one and filter it with conditions (column, operator, value – always bound, never
  written into the SQL), sort by a click on a column head, add a condition from the cell under the cursor
  (<kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> <kbd>Ctrl/⌘</kbd>+<kbd>E</kbd>); the filter of a table is remembered. Any other
  result is filtered and sorted in the backend's store without running the query again
- Edit data: change cells of a table (<kbd>F2</kbd> or a double click; NULL and default at hand) – nothing is
  sent while you type. Changes are collected and shown in colour, can be undone, previewed as SQL, and are
  written together in one transaction with <kbd>Ctrl/⌘</kbd>+<kbd>S</kbd>: all rows or none, values bound, and
  a row somebody else changed in the meantime is reported instead of overwritten
- Rows too: add a row (<kbd>Ctrl/⌘</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd>), duplicate rows, mark rows to delete
  (<kbd>Ctrl/⌘</kbd>+<kbd>⌫</kbd>), paste a block of cells from a spreadsheet (<kbd>Ctrl/⌘</kbd>+<kbd>V</kbd>
  in the grid – over the rows below the cursor and on into new rows), fill down
  (<kbd>Ctrl/⌘</kbd>+<kbd>D</kbd>). Everything is written together: deletes, then changes, then inserts
- A row as a form beside the grid (<kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> <kbd>Ctrl/⌘</kbd>+<kbd>L</kbd>): every column a line, filter by column
  name, step through the rows, marked rows side by side with what differs
- Results of a script as sub-tabs with title and row count; pin a result so the next run keeps it, move it into a
  tab of its own, and compare two results (<kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> <kbd>Ctrl/⌘</kbd>+<kbd>B</kbd>; run again and
  compare: <kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> <kbd>Ctrl/⌘</kbd>+<kbd>Y</kbd>) by key columns or position, with tolerances –
  worked out in Rust, also for millions of rows
- A chart of the result (<kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> <kbd>Ctrl/⌘</kbd>+<kbd>T</kbd>): lines over time, bars, scatter plots – suggested
  from the column types, grouped and aggregated, with zoom, tooltip and legend; millions of points are thinned in Rust
  without losing a peak; export as SVG
- Edit the structure of a table as a form – columns, indexes, foreign keys, checks – with the statements shown
  before they run, steps that may lose data marked, and one transaction where the database allows it; new table,
  duplicate, empty, drop; the definition of a view or routine opens as a statement that replaces it
- Back up and restore with the tools of the database (`pg_dump`, `pg_restore`, `psql`, `mysqldump`, `mysql`) – found on
  the machine, started without a shell, the password never an argument; a copy of a SQLite file; and a simple SQL
  export where there is no tool
- Copy tables from one connection to another, also across databases (PostgreSQL → MySQL, SQL Server, SQLite …): as a
  stream without a file in between, types mapped with every loss named before it runs, tables in the order of their
  foreign keys
- Execution plans (<kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> <kbd>Ctrl/⌘</kbd>+<kbd>X</kbd>) as a tree table for every database: rows estimated and
  actual, own and total time, cost – the expensive operations and wrong estimates stand out. „With execution“
  runs the statement inside a transaction that is rolled back
- Compare two schemas (or a schema with a saved snapshot): what is only on one side, what differs, both
  definitions side by side – and a migration script as a proposal in a tab, with every step that may lose data
  commented out
- ER diagram of a schema, or of a table with its neighbours: arranged by itself, tables can be moved, zoom,
  search, three levels of detail; the same as lists beside it; export as SVG, Mermaid or DBML
- Users and rights: users, roles and memberships, what each may do and through which role, a matrix of
  tables × rights; changes are collected, shown as statements with what is dangerous marked, and run after
  asking – a password is never shown, never in the history
- Server monitor: sessions and running statements, who blocks whom, a few figures; reads again on a beat,
  cancels a statement or ends a session after asking
- Search on the server (<kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> <kbd>Ctrl/⌘</kbd>+<kbd>G</kbd>): where does a text stand – in the rows of all tables (one
  after the other, with limits of hits and time, the text always bound) and in the definitions of views,
  routines, triggers, checks and defaults; a hit opens the table filtered, or the definition
- Import a file into a table: CSV/TSV, JSON or NDJSON (also gzip, any common encoding), read as a stream. The
  dialog shows the start of the file as it is read, maps columns by name, proposes a `CREATE TABLE` for a new
  table, and writes with bound values – all or nothing, or block by block with the refused rows in an error file
- Follow foreign keys in a table: <kbd>F4</kbd> on `customer_id = 42` shows the customer (in the tab, in a new
  one, or as a quick look with <kbd>Shift</kbd>+<kbd>F4</kbd>); <kbd>Alt</kbd>+<kbd>F7</kbd> lists the tables
  that point to the row, with counts. Several marked rows at once, composite keys, a path with back and forward
  (<kbd>Alt</kbd>+<kbd>←/→</kbd>), and relations of your own where the database defines none
- Wide results: keep columns at the left, hide them, move them (drag, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>←/→</kbd>),
  fit widths; the column list (<kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> <kbd>Ctrl/⌘</kbd>+<kbd>C</kbd>) finds one of 500
  columns by name. The layout is remembered per table
- Search in the result (<kbd>Ctrl/⌘</kbd>+<kbd>F</kbd> in the grid): text, whole word, regular expression, one
  column – searched in the backend, first hits at once, <kbd>F3</kbd> from hit to hit; go to row
  (<kbd>Ctrl/⌘</kbd>+<kbd>G</kbd>), next other value (<kbd>Alt</kbd>+<kbd>↓</kbd>), next NULL
- Figures of the selection: mark cells and the status line shows count, sum, mean, smallest and largest –
  added up exactly in the backend (a `NUMERIC(38,10)` sum is right to the last digit), for dates the span, for
  text the lengths; a click copies a figure. "Summarize the column"
  (<kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> <kbd>Ctrl/⌘</kbd>+<kbd>A</kbd>) adds the ten most frequent values
- Value panel (<kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> <kbd>Ctrl/⌘</kbd>+<kbd>V</kbd>): the whole value of the cell
  under the cursor beside the grid – long text, JSON and XML laid out (without changing a digit), binary data
  as hex or as a picture, numbers in hex and binary, instants in UTC. 50 MB in one cell stay usable; a value is
  copied or saved whole by the backend
- Parameters: `WHERE customer_id = :kunde AND id IN (:ids)` asks for the values when it runs, remembers them per
  tab and sends them bound – a value never becomes part of the SQL text. `:name`, `${name}`, `?`, `$1` …, set per
  connection; run again with the same values with <kbd>Ctrl/⌘</kbd>+<kbd>Alt</kbd>+<kbd>Enter</kbd>
- Saved queries: plain `.sql` files in a folder of your choice (share them with Git, edit them anywhere), with
  name, description and tags in a comment header; a sidebar view with folders, search over names and texts and a
  preview; `q:` in “go to anything”. Snippets: `sel` + <kbd>Tab</kbd> becomes a statement with placeholders to
  tab through – a set per database, and your own
- Format SQL (<kbd>Ctrl/⌘</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>): the selection, the statement under the caret or
  the whole script, as one undo step; keyword case, indentation, line width, commas and `AND`/`OR` are settings
  with a live preview. Strings, comments and quoted names are never touched – the formatter checks every result
  against the tokens of your text and leaves the text alone if they differ. Also: join into one line, keywords
  to upper or lower case, toggle line comment (<kbd>Ctrl/⌘</kbd>+<kbd>/</kbd>)
- Errors where they happen: the place the database names is underlined in the editor and the caret jumps
  there; code, detail and hint of the server are shown apart; the running statement is highlighted
- Completion that knows the schema: tables behind `FROM`, the columns of an alias behind `o.`, the join
  condition from a foreign key behind `JOIN`, keywords and types per database
- Go to anything (<kbd>Ctrl/⌘</kbd>+<kbd>P</kbd>): a few letters find a table, view, routine, column, open tab
  or connection across all schemas – by word starts (`ord_it`), with typos, ranked
- Object details for every table, view, routine, sequence and type: columns, indexes, constraints, relations,
  privileges, statistics – and the DDL to read, copy or open in a tab
- A menu bar (native on macOS, drawn by the window on Windows and Linux) and context menus on tabs, results
  and connections – all made of the same actions, with their current shortcuts
- English and German, switchable while the app runs; a settings dialog with search, reset per value, export
  and import (<kbd>Ctrl/⌘</kbd>+<kbd>,</kbd>)
- Layout, tab groups, caret positions, colour scheme and window position survive a restart

## Releases

There is no published release yet. Packages for macOS, Windows and Linux are built by a GitHub workflow from a
tag (`docs/release.md`); until certificates are set up they are unsigned. Every package carries
`THIRD-PARTY-NOTICES.txt` with the licences of everything inside; *Help → About Schema Commander* shows it,
together with version and build.

## Development

```bash
pnpm install
pnpm tauri dev      # app with hot reload (Angular on port 1460)
pnpm check          # contrast, format, lint, tests, build, cargo fmt/clippy/test
```

Requirements: Node ≥ 22.22.3, pnpm 10, Rust stable ≥ 1.93 and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) of your OS.

Rules and layout for contributors (and AI assistants): [`CLAUDE.md`](CLAUDE.md),
[`docs/best-practices.md`](docs/best-practices.md), [`docs/architecture.md`](docs/architecture.md).

## License

MIT © 2026 Marc Kronberg
