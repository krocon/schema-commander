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
- Layout, colour scheme and window position survive a restart

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
