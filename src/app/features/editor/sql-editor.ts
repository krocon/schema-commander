import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { language } from '../../core/i18n/i18n';
import { SettingsService } from '../../core/settings/settings.service';
import { ErrorDetails } from '../../core/errors/app-error';
import { Place, errorRange, placeOf } from '../../core/errors/error-position';
import { ThemeService } from '../../core/theme/theme.service';
import { FormatMode } from '../../core/format/format-api';
import { CompletionService, LINES_AFTER, LINES_BEFORE } from '../completion/completion.service';
import { FormatService } from '../format/format.service';
import { SchemaStore } from '../schema/schema.store';
import { snippetsFor } from '../snippets/snippet-logic';
import {
  EdPlace,
  FormatOutcome,
  mapOffset,
  offsetAt,
  placeIn,
  toggleComment,
  trimmedSpan,
} from '../format/format-logic';
import { EDITOR_COLORS } from './editor-colors';
import { EDITOR_TEXTS } from './editor-texts';
import {
  CompletionContext,
  EdCaret,
  Marker,
  EdChange,
  EditliciousEditorElement,
  loadEditlicious,
} from './editlicious';
import { Dialect, offsetOf, positionOf, splitForRun, statementAt } from './sql-split';

/** The owners of the marks the app sets in the text (prompt 022). */
const ERROR_MARKS = 'sql-error';
const RUNNING_MARKS = 'sql-running';

/**
 * The SQL editor: `<editlicious-editor>` with the SQL grammar, coloured by the app's tokens.
 * `runCurrent()` and `runScript()` ask to run statements (`run`); the keys for them are actions (prompt 002).
 */
@Component({
  selector: 'app-sql-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    @if (state() === 'ready') {
      <editlicious-editor
        #editor
        language="SQL"
        scheme="none"
        [attr.color-scheme]="dark() ? 'dark' : 'light'"
        [style]="colors"
        [attr.aria-label]="label() || t.label"
        [attr.readonly]="readonly() ? '' : null"
        [attr.ui-language]="uiLanguage()"
        [attr.font-family]="look().editorFontFamily || null"
        [attr.font-size]="look().editorFontSize"
        [attr.tab-width]="look().editorTabWidth"
        [attr.line-numbers]="look().editorLineNumbers"
        [attr.word-wrap]="look().editorWordWrap ? '' : null"
        [attr.word-suggest]="look().editorSuggest ? '' : null"
        (ed-caret)="onCaret($event)"
        (ed-change)="onChange($event)"
      />
    } @else if (state() === 'failed') {
      <p class="message error" role="alert">{{ t.loadFailed }}</p>
    } @else {
      <p class="message">{{ t.loading }}</p>
    }
  `,
  styles: `
    :host {
      display: block;
      min-height: 0;
      background: var(--bg-app);
    }
    /* the element lays itself out (flex column): only its size is ours */
    editlicious-editor {
      height: 100%;
    }
    .message {
      margin: 0;
      padding: 12px 16px;
      color: var(--text-dim);
    }
    .error {
      color: var(--error-fg);
    }
  `,
})
export class SqlEditor implements OnInit {
  protected readonly t = EDITOR_TEXTS;
  private readonly theme = inject(ThemeService);
  private readonly completion = inject(CompletionService);
  private readonly formatter = inject(FormatService);
  private readonly schema = inject(SchemaStore);
  /** Font, tab width, wrapping … of every editor are settings (prompt 017). */
  protected readonly look = inject(SettingsService).settings;
  /** The editor's own texts (search bar, menus) follow the language of the window. */
  protected readonly uiLanguage = language;

  /** Text the editor starts with. */
  readonly initialValue = input('');
  /** The accessible name; empty = "SQL editor" in the current language. */
  readonly label = input('');
  /** Shows text that cannot be changed (the preview of the history). */
  readonly readonly = input(false);
  /** The rules statements are split by. */
  readonly dialect = input<Dialect>('sqlite');
  /** The connection whose names the completion offers; `null` = keywords and the words of the text. */
  readonly connectionId = input<string | null>(null);
  /** The statements to run, in their order. */
  readonly run = output<readonly string[]>();
  readonly caret = output<EdCaret>();
  /** The text changed (revision, size – never the text itself). Not sent for the start text. */
  readonly changed = output<EdChange>();

  /** The start text is in the editor (the caret of the last run can be set now). */
  readonly seededText = output<void>();

  protected readonly state = signal<'loading' | 'ready' | 'failed'>('loading');
  /** All colours of the editor come from our tokens (design 001 E1). */
  protected readonly colors = EDITOR_COLORS;
  protected readonly dark = computed(() => this.theme.applied()?.dark ?? this.theme.systemDark());
  private readonly editor = viewChild<ElementRef<EditliciousEditorElement>>('editor');
  /** The last caret the editor reported; `null` = still at the start. */
  private lastCaret: EdCaret | null = null;
  /** The statements of the run started last and where each stands in the text. */
  private lastRun: { statements: readonly string[]; places: Place[] } | null = null;
  private errorMarks: Marker[] = [];
  /** The revision of the text the editor reported last: an answer for an older text is thrown away. */
  private revision = 0;
  private runningAsked = 0;
  private seeded = false;
  /** The start text is in the editor: changes from here on are the user's. */
  private seededDone = false;

  constructor() {
    // the element exists once the module is loaded and the view is rendered
    effect(() => {
      if (this.editor()) this.seed();
    });
    // snippets (prompt 024): the built-in ones of the dialect and the user's own; `$TABLE` and `$SCHEMA`
    // are what is under the cursor of the schema tree, as long as the tree shows this editor's connection
    effect(() => {
      const editor = this.editor()?.nativeElement;
      if (!editor) return;
      if (this.readonly()) {
        editor.snippets = null;
        return;
      }
      const row =
        this.schema.connectionId() === this.connectionId() ? this.schema.activeRow() : null;
      const table =
        row?.object && row.schema
          ? row.schema.current
            ? row.object.quoted
            : `${row.schema.quoted}.${row.object.quoted}`
          : null;
      editor.snippets = snippetsFor(this.dialect(), this.look().snippets, {
        table,
        schema: row?.schema?.quoted ?? null,
      });
    });
    // the completion that knows the schema (prompt 021): asked by the editor, answered by the service
    effect(() => {
      const editor = this.editor()?.nativeElement;
      if (!editor) return;
      if (this.readonly()) {
        editor.completionProvider = null;
        return;
      }
      const provider = (context: CompletionContext) =>
        this.completion.provide(this.connectionId(), this.dialect(), context);
      // a dot always asks; a blank, a comma and `(` only where a table or a column list is due
      provider.triggerCharacters = ['.', ' ', ',', '('];
      editor.completionProvider = provider;
    });
  }

  ngOnInit(): void {
    loadEditlicious().then(
      () => this.state.set('ready'),
      (e) => {
        console.warn('editlicious-editor could not be loaded', e);
        this.state.set('failed');
      },
    );
  }

  focus(): void {
    this.editor()?.nativeElement.focus();
  }

  /** The whole text; `''` while the editor is not there yet. */
  getText(): Promise<string> {
    const editor = this.editor()?.nativeElement;
    // before the start text is in, the start text is the text
    if (!editor || !this.seededDone) return Promise.resolve(this.initialValue());
    return editor.getValue();
  }

  /** The selected text; `''` when nothing is selected. */
  async selectedText(): Promise<string> {
    return (await this.editor()?.nativeElement.getSelection())?.text ?? '';
  }

  async setText(text: string): Promise<void> {
    await this.editor()?.nativeElement.setValue(text);
  }

  /** Puts the caret at a line and column (from 1) and shows the place. */
  async goTo(line: number, ch: number): Promise<void> {
    await this.editor()?.nativeElement.goTo(line, ch);
  }

  /** Text at the caret, over the selection; as a snippet its placeholders can be tabbed through. */
  async insert(text: string, snippet: boolean): Promise<void> {
    const editor = this.editor()?.nativeElement;
    if (!editor) return;
    if (snippet) await editor.insertSnippet(text);
    else await editor.replaceSelection(text);
  }

  /**
   * Asks to run the selection, when there is one, else the statement under the caret. A selection is taken
   * as it is marked and split into its statements.
   */
  async runCurrent(): Promise<void> {
    const editor = this.editor()?.nativeElement;
    if (!editor) return;
    const dialect = this.dialect();
    const selection = await editor.getSelection();
    if (selection.text.trim() !== '') {
      const parts = splitForRun(selection.text, dialect);
      // each statement starts somewhere inside the selection, which starts somewhere in the text
      this.emitRun(
        parts.map((s) => s.text),
        parts.map((s) => placeOf(selection.text, selection.start, s.start)),
      );
      return;
    }
    const script = await editor.getValue();
    const caret = this.lastCaret;
    const statement = statementAt(
      script,
      offsetOf(script, caret?.line ?? 1, caret?.ch ?? 1),
      dialect,
    );
    if (statement) this.emitRun([statement.text], [positionOf(script, statement.start)]);
  }

  /** Starts a run and remembers where each of its statements stands (for the marks of prompt 022). */
  private emitRun(statements: string[], places: Place[]): void {
    if (statements.length === 0) return;
    this.lastRun = { statements, places };
    this.run.emit(statements);
  }

  /** Where a statement of a run stands: as remembered, else found by its text. */
  private async placeOfStatement(
    statements: readonly string[],
    index: number,
  ): Promise<Place | null> {
    const known = this.lastRun;
    if (known?.statements === statements && known.places[index]) return known.places[index];
    // a run the editor did not start (open a table, the history): the text says where
    const editor = this.editor()?.nativeElement;
    const sql = statements[index];
    if (!editor || !sql) return null;
    const script = await editor.getValue();
    const at = script.indexOf(sql);
    return at < 0 ? null : positionOf(script, at);
  }

  clearMarks(): void {
    this.errorMarks = [];
    const editor = this.editor()?.nativeElement;
    void editor?.clearMarkers(ERROR_MARKS);
    void editor?.clearMarkers(RUNNING_MARKS);
  }

  /** Tints the statement that runs and puts a sign beside it; `null` ends that. */
  async markRunning(statements: readonly string[], index: number | null): Promise<void> {
    const editor = this.editor()?.nativeElement;
    if (!editor) return;
    const mine = ++this.runningAsked;
    if (index === null) {
      await editor.clearMarkers(RUNNING_MARKS);
      return;
    }
    const start = await this.placeOfStatement(statements, index);
    // a later call has decided already
    if (mine !== this.runningAsked) return;
    if (!start) {
      await editor.clearMarkers(RUNNING_MARKS);
      return;
    }
    const sql = statements[index];
    await editor.setMarkers(RUNNING_MARKS, [
      {
        start,
        end: placeOf(sql, start, sql.length),
        severity: 'running',
        lineBackground: true,
        gutter: '▶',
        message: this.t.running(index + 1, statements.length),
      },
    ]);
  }

  /**
   * Underlines where a statement failed – the place the database named, else the whole statement – with
   * the message as its tooltip. The mark follows the text and goes when its place is edited.
   */
  async markError(
    statements: readonly string[],
    index: number,
    message: string,
    details: ErrorDetails | null,
    jump: boolean,
  ): Promise<void> {
    const editor = this.editor()?.nativeElement;
    const start = await this.placeOfStatement(statements, index);
    if (!editor || !start) return;
    const range = errorRange(statements[index], start, details);
    const marks = [
      ...this.errorMarks,
      {
        start: range.start,
        end: range.end,
        severity: 'error',
        message,
        gutter: '!',
        onEdit: 'remove' as const,
      },
    ];
    this.errorMarks = marks;
    await editor.setMarkers(ERROR_MARKS, marks);
    if (jump) await editor.goTo(range.start.line, range.start.ch);
  }

  /** The caret goes to the first place that is still marked as an error. */
  async goToError(): Promise<void> {
    const editor = this.editor()?.nativeElement;
    if (!editor) return;
    const [first] = await editor.getMarkers(ERROR_MARKS);
    if (!first) return;
    await editor.goTo(first.start.line, first.start.ch);
    editor.focus();
  }

  /**
   * Writes out the `*` at or before the caret as the columns it stands for (prompt 021). Resolves with
   * whether something was replaced.
   */
  async expandStar(): Promise<boolean> {
    const editor = this.editor()?.nativeElement;
    const connection = this.connectionId();
    if (!editor || !connection || this.readonly()) return false;
    const caret = this.lastCaret ?? { line: 1, ch: 1 };
    const first = Math.max(1, caret.line - LINES_BEFORE);
    const text = await editor.getSlice(first, caret.line + LINES_AFTER);
    const offset = offsetOf(text, caret.line - first + 1, caret.ch);
    const statement = statementAt(text, offset, this.dialect());
    if (!statement) return false;
    const found = await this.completion.expandStar(
      connection,
      this.dialect(),
      statement.text,
      offset - statement.start,
    );
    if (!found) return false;
    const at = (index: number) => positionOf(text, statement.start + index, first);
    await editor.replaceRange(at(found.from), at(found.to), found.text);
    return true;
  }

  /**
   * Formats (prompt 023) the whole script, or the selection – without one the statement under the caret –
   * and puts the result in its place as one undo step. Only that range is replaced: carets and marks
   * elsewhere stay. Rejects with an `AppError` when the formatter refuses the text; then nothing changed.
   */
  async format(mode: FormatMode, whole: boolean): Promise<FormatOutcome> {
    const editor = this.editor()?.nativeElement;
    if (!editor || this.readonly()) return 'nothing';
    const revision = this.revision;
    const dialect = this.dialect();
    let text: string;
    let start: EdPlace;
    let crlf: boolean;
    /** The caret, counted from the start of `text`. */
    let caret: number;
    if (whole) {
      text = await editor.getValue();
      start = { line: 1, ch: 1 };
      crlf = text.includes('\r\n');
      caret = offsetAt(text, this.lastCaret ?? start);
    } else {
      const selection = await editor.getSelection();
      if (selection.text.trim() !== '') {
        // the blanks around the selected text stay where they are
        const span = trimmedSpan(selection.text);
        text = selection.text.slice(span.from, span.to);
        start = placeIn(selection.text, span.from, selection.start);
        crlf = selection.text.includes('\r\n');
        caret = text.length;
      } else {
        // Where a statement starts and ends only the whole text tells (a line above may open a string).
        // It is read, never written: the statement alone is replaced.
        const script = await editor.getValue();
        const at = offsetAt(script, this.lastCaret ?? { line: 1, ch: 1 });
        const statement = statementAt(script, at, dialect);
        if (!statement) return 'nothing';
        text = statement.text;
        start = placeIn(script, statement.start);
        crlf = script.includes('\r\n');
        caret = at - statement.start;
      }
    }
    if (text.trim() === '') return 'nothing';
    const formatted = await this.formatter.run(text, dialect, mode, crlf);
    if (formatted === null) return 'busy';
    if (this.revision !== revision) return 'stale';
    if (formatted === text) return 'unchanged';
    await editor.replaceRange(start, placeIn(text, text.length, start), formatted);
    // The caret goes where it stood in the text. First to the start of its line: the editor stays
    // scrolled to where a line ended that is gone now, and only showing column 1 brings the view back.
    const to = placeIn(formatted, mapOffset(text, formatted, caret), start);
    await editor.goTo(to.line, 1);
    await editor.goTo(to.line, to.ch);
    return 'done';
  }

  /** Comments the lines of the selection (or the line of the caret) out or in, as one undo step. */
  async toggleComment(): Promise<void> {
    const editor = this.editor()?.nativeElement;
    if (!editor || this.readonly()) return;
    const selection = await editor.getSelection();
    const first = selection.start.line;
    // a selection that ends at the start of a line does not mean that line
    const last =
      selection.end.line > first && selection.end.ch === 1
        ? selection.end.line - 1
        : selection.end.line;
    const lines = await editor.getSlice(first, last);
    // the break behind the last line is not part of it
    const text = lines.replace(/\r?\n$/, '');
    const out = toggleComment(text, this.dialect());
    if (out === text) return;
    const start = { line: first, ch: 1 };
    await editor.replaceRange(start, placeIn(text, text.length, start), out);
  }

  /** Asks to run the whole script, statement by statement (SQL Server: batch by batch). */
  async runScript(): Promise<void> {
    const editor = this.editor()?.nativeElement;
    if (!editor) return;
    const script = await editor.getValue();
    const parts = splitForRun(script, this.dialect());
    this.emitRun(
      parts.map((s) => s.text),
      parts.map((s) => positionOf(script, s.start)),
    );
  }

  protected onChange(event: Event): void {
    const detail = (event as CustomEvent<EdChange>).detail;
    if (detail) this.revision = detail.revision;
    // the start text is no change of the user
    if (detail && this.seededDone) this.changed.emit(detail);
  }

  protected onCaret(event: Event): void {
    const detail = (event as CustomEvent<EdCaret>).detail;
    if (!detail) return;
    this.lastCaret = detail;
    this.caret.emit(detail);
  }

  /** Puts the start text in (once). */
  private seed(): void {
    const editor = this.editor()?.nativeElement;
    if (this.seeded || !editor) return;
    this.seeded = true;
    const done = () => {
      this.seededDone = true;
      this.seededText.emit();
    };
    void editor.setValue(this.initialValue()).then(done, done);
  }
}
