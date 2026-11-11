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
import { offsetOf, statementAt } from './sql-split';

/**
 * The SQL editor: `<editlicious-editor>` with the SQL grammar, coloured by the app's tokens.
 * `runCurrent()` asks to run the statement under the caret (`run`); the key for it is an action (prompt 002).
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
  /** The statement to run. */
  readonly run = output<string>();
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

  /** Asks to run the statement under the caret. */
  async runCurrent(): Promise<void> {
    const editor = this.editor()?.nativeElement;
    if (!editor) return;
    const script = await editor.getValue();
    const statement = statementAt(
      script,
      offsetOf(script, this.lastCaret?.line ?? 1, this.lastCaret?.ch ?? 1),
    );
    if (statement) this.run.emit(statement.text);
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
