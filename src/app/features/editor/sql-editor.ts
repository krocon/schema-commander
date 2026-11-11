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
import { ThemeService } from '../../core/theme/theme.service';
import { EDITOR_COLORS } from './editor-colors';
import { EdCaret, EdChange, EditliciousEditorElement, loadEditlicious } from './editlicious';
import { Dialect, offsetOf, splitForRun, statementAt } from './sql-split';

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
        [attr.aria-label]="label()"
        (ed-caret)="onCaret($event)"
        (ed-change)="onChange($event)"
      />
    } @else if (state() === 'failed') {
      <p class="message error" role="alert">Der Editor konnte nicht geladen werden.</p>
    } @else {
      <p class="message">Editor wird geladen …</p>
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
  private readonly theme = inject(ThemeService);

  /** Text the editor starts with. */
  readonly initialValue = input('');
  readonly label = input('SQL-Editor');
  /** The rules statements are split by. */
  readonly dialect = input<Dialect>('sqlite');
  /** The statements to run, in their order. */
  readonly run = output<readonly string[]>();
  readonly caret = output<EdCaret>();
  /** The text changed (revision, size – never the text itself). Not sent for the start text. */
  readonly changed = output<EdChange>();

  protected readonly state = signal<'loading' | 'ready' | 'failed'>('loading');
  /** All colours of the editor come from our tokens (design 001 E1). */
  protected readonly colors = EDITOR_COLORS;
  protected readonly dark = computed(() => this.theme.applied()?.dark ?? this.theme.systemDark());
  private readonly editor = viewChild<ElementRef<EditliciousEditorElement>>('editor');
  /** The last caret the editor reported; `null` = still at the start. */
  private lastCaret: EdCaret | null = null;
  private seeded = false;
  /** The start text is in the editor: changes from here on are the user's. */
  private seededDone = false;

  constructor() {
    // the element exists once the module is loaded and the view is rendered
    effect(() => {
      if (this.editor()) this.seed();
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

  async setText(text: string): Promise<void> {
    await this.editor()?.nativeElement.setValue(text);
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
      const statements = splitForRun(selection.text, dialect).map((s) => s.text);
      if (statements.length > 0) this.run.emit(statements);
      return;
    }
    const script = await editor.getValue();
    const caret = this.lastCaret;
    const statement = statementAt(
      script,
      offsetOf(script, caret?.line ?? 1, caret?.ch ?? 1),
      dialect,
    );
    if (statement) this.run.emit([statement.text]);
  }

  /** Asks to run the whole script, statement by statement (SQL Server: batch by batch). */
  async runScript(): Promise<void> {
    const editor = this.editor()?.nativeElement;
    if (!editor) return;
    const statements = splitForRun(await editor.getValue(), this.dialect()).map((s) => s.text);
    if (statements.length > 0) this.run.emit(statements);
  }

  protected onChange(event: Event): void {
    const detail = (event as CustomEvent<EdChange>).detail;
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
    void editor.setValue(this.initialValue()).then(
      () => (this.seededDone = true),
      () => (this.seededDone = true),
    );
  }
}
