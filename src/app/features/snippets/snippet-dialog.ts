import {
  Component,
  ElementRef,
  OnInit,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { COMMON_TEXTS } from '../../core/i18n/common-texts';
import { MAX_SNIPPETS, MAX_SNIPPET_BODY, OwnSnippet } from '../../core/settings/settings.models';
import { SettingsService } from '../../core/settings/settings.service';
import { SnippetRow, snippetProblem, snippetRows, withSnippet } from './snippet-logic';
import { SNIPPET_TEXTS } from './snippet-texts';

/**
 * The snippets (prompt 024): the built-in ones to read, own ones to write. An own snippet with the prefix
 * of a built-in one replaces it. Every change is stored at once; the editors take it up as they are.
 */
@Component({
  selector: 'app-snippet-dialog',
  template: `
    <dialog #dialog aria-labelledby="snippet-title" (cancel)="$event.preventDefault(); close()">
      <header>
        <h2 id="snippet-title">{{ t.title }}</h2>
        <button type="button" class="x" [attr.aria-label]="common.close" (click)="close()">
          ×
        </button>
      </header>
      <p class="intro">{{ t.intro }}</p>
      <div class="body">
        <div class="side">
          <ul
            #list
            class="list"
            role="listbox"
            tabindex="0"
            [attr.aria-label]="t.list"
            [attr.aria-activedescendant]="selectedKey() ? 'sn-' + selectedKey() : null"
            (keydown)="onKey($event)"
            (click)="onClick($event)"
          >
            @for (row of rows(); track key(row)) {
              <li
                role="option"
                [id]="'sn-' + key(row)"
                [attr.data-key]="key(row)"
                [attr.aria-selected]="key(row) === selectedKey()"
              >
                <code>{{ row.prefix }}</code>
                <span class="what">{{ row.description }}</span>
                <small>{{
                  row.builtin ? (row.where ? t.onlyFor(row.where) : t.builtin) : t.own
                }}</small>
              </li>
            }
          </ul>
          <button type="button" (click)="startNew()">{{ t.newSnippet }}</button>
        </div>
        <form class="form" (submit)="$event.preventDefault(); save()">
          <label for="snippet-prefix">{{ t.prefix }}</label>
          <input
            #prefix
            id="snippet-prefix"
            type="text"
            autocomplete="off"
            spellcheck="false"
            maxlength="32"
            aria-describedby="snippet-prefix-hint"
            [readOnly]="readonly()"
            [value]="draft().prefix"
            (input)="set('prefix', $any($event.target).value)"
          />
          <p class="hint" id="snippet-prefix-hint">{{ t.prefixHint }}</p>
          <label for="snippet-description">{{ t.description }}</label>
          <input
            id="snippet-description"
            type="text"
            autocomplete="off"
            maxlength="200"
            [readOnly]="readonly()"
            [value]="draft().description"
            (input)="set('description', $any($event.target).value)"
          />
          <label for="snippet-body">{{ t.body }}</label>
          <textarea
            id="snippet-body"
            rows="9"
            spellcheck="false"
            aria-describedby="snippet-body-hint"
            [maxLength]="maxBody"
            [readOnly]="readonly()"
            [value]="draft().body"
            (input)="set('body', $any($event.target).value)"
          ></textarea>
          <p class="hint" id="snippet-body-hint">{{ t.bodyHint }}</p>
          @if (readonly()) {
            <p class="hint">{{ t.builtinNote }}</p>
          }
          @if (message(); as m) {
            <p class="problem" role="alert">{{ m }}</p>
          }
          <footer>
            @if (readonly()) {
              <button type="button" (click)="editCopy()">{{ t.editCopy }}</button>
            } @else {
              <button type="button" [disabled]="editing() === null" (click)="remove()">
                {{ t.delete }}
              </button>
              <button type="submit" class="primary">{{ t.save }}</button>
            }
          </footer>
        </form>
      </div>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(820px, 94vw);
      padding: 14px 16px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    h2 {
      margin: 0;
      font-size: 15px;
    }
    .intro,
    .hint {
      margin: 2px 0 0;
      color: var(--text-dim);
      font-size: 12px;
    }
    .body {
      display: grid;
      grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
      gap: 14px;
      margin-top: 10px;
    }
    .side {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-height: 0;
    }
    .list {
      margin: 0;
      padding: 0;
      list-style: none;
      height: 340px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    li {
      display: grid;
      grid-template-columns: 5em minmax(0, 1fr) auto;
      gap: 6px;
      align-items: baseline;
      padding: 3px 6px;
      cursor: default;
    }
    li:hover {
      background: var(--bg-hover);
    }
    li[aria-selected='true'] {
      background: var(--row-selected);
    }
    .list:focus-visible li[aria-selected='true'] {
      box-shadow: inset 0 0 0 1px var(--accent);
    }
    code,
    textarea {
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .what {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    small {
      color: var(--text-dim);
      font-size: 11px;
    }
    .form {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
    }
    label {
      margin-top: 6px;
      color: var(--text-dim);
      font-size: 12px;
    }
    textarea {
      resize: vertical;
      white-space: pre;
    }
    .problem {
      margin: 6px 0 0;
      color: var(--error-fg);
    }
    footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 10px;
    }
  `,
})
export class SnippetDialog implements OnInit {
  protected readonly t = SNIPPET_TEXTS;
  protected readonly common = COMMON_TEXTS;
  protected readonly maxBody = MAX_SNIPPET_BODY;
  private readonly settings = inject(SettingsService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly prefixField = viewChild.required<ElementRef<HTMLInputElement>>('prefix');

  readonly closed = output<void>();

  private readonly own = computed(() => this.settings.settings().snippets);
  protected readonly rows = computed(() => snippetRows(this.own()));
  protected readonly selectedKey = signal<string | null>(null);
  /** The prefix of the own snippet being changed; `null` = a new one. */
  protected readonly editing = signal<string | null>(null);
  protected readonly readonly = signal(false);
  protected readonly draft = signal<OwnSnippet>({ prefix: '', description: '', body: '' });
  protected readonly message = signal<string | null>(null);

  ngOnInit(): void {
    this.dialog().nativeElement.showModal();
    const first = this.rows()[0];
    if (first) this.select(first);
  }

  /** Rows are told apart by prefix and by what they are for (`exp` exists per database). */
  protected key(row: SnippetRow): string {
    return `${row.builtin ? 'b' : 'o'}-${row.prefix}-${row.where.replace(/[^a-z]/g, '')}`;
  }

  private select(row: SnippetRow): void {
    this.selectedKey.set(this.key(row));
    this.readonly.set(row.builtin);
    this.editing.set(row.builtin ? null : row.prefix);
    this.draft.set({ prefix: row.prefix, description: row.description, body: row.body });
    this.message.set(null);
  }

  protected startNew(): void {
    this.selectedKey.set(null);
    this.readonly.set(false);
    this.editing.set(null);
    this.draft.set({ prefix: '', description: '', body: '' });
    this.message.set(null);
    setTimeout(() => this.prefixField().nativeElement.focus());
  }

  /** A built-in snippet becomes the start of an own one with its prefix. */
  protected editCopy(): void {
    this.readonly.set(false);
    this.editing.set(null);
    this.message.set(null);
  }

  protected set<K extends keyof OwnSnippet>(key: K, value: OwnSnippet[K]): void {
    this.draft.update((d) => ({ ...d, [key]: value }));
    this.message.set(null);
  }

  protected save(): void {
    if (this.readonly()) return;
    const draft = { ...this.draft(), prefix: this.draft().prefix.trim() };
    const problem = snippetProblem(draft, this.own(), this.editing());
    if (problem) {
      this.message.set(
        problem === 'prefix'
          ? this.t.prefixInvalid
          : problem === 'taken'
            ? this.t.prefixTaken
            : this.t.bodyMissing,
      );
      return;
    }
    if (this.editing() === null && this.own().length >= MAX_SNIPPETS) {
      this.message.set(this.t.tooMany);
      return;
    }
    this.settings.update({ snippets: withSnippet(this.own(), draft, this.editing()) });
    const row = this.rows().find((r) => !r.builtin && r.prefix === draft.prefix);
    if (row) this.select(row);
  }

  protected remove(): void {
    const prefix = this.editing();
    if (prefix === null) return;
    this.settings.update({ snippets: this.own().filter((s) => s.prefix !== prefix) });
    const next = this.rows().find((r) => r.prefix === prefix) ?? this.rows()[0];
    if (next) this.select(next);
    else this.startNew();
  }

  protected onClick(event: MouseEvent): void {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-key]');
    const row = this.rows().find((r) => this.key(r) === item?.dataset['key']);
    if (row) this.select(row);
  }

  protected onKey(event: KeyboardEvent): void {
    const rows = this.rows();
    const at = rows.findIndex((r) => this.key(r) === this.selectedKey());
    const to: Record<string, number> = {
      ArrowDown: Math.min(rows.length - 1, at + 1),
      ArrowUp: Math.max(0, at - 1),
      Home: 0,
      End: rows.length - 1,
    };
    const next = to[event.key];
    if (next === undefined || rows.length === 0) return;
    event.preventDefault();
    this.select(rows[next]);
    setTimeout(() =>
      document.getElementById(`sn-${this.key(rows[next])}`)?.scrollIntoView?.({ block: 'nearest' }),
    );
  }

  protected close(): void {
    this.dialog().nativeElement.close();
    this.closed.emit();
  }
}
