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
  passwords only in the keychain of your OS; a demo database in memory to try things out
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
