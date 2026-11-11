import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { typeLabel } from '../results/cell-format';
import { QueryTab } from '../tabs/query-tab';
import { EDIT_TEXTS } from './edit-texts';
import { EditService } from './edit.service';

/**
 * The row above a table view for editing (prompt 031): the field for the cell that is being edited –
 * with NULL and default beside it –, and what is still to be written, with the ways to look at it, write
 * it or drop it. `Enter` takes the value (in a text of several lines: `Ctrl/Cmd+Enter`), `Esc` leaves the
 * cell as it is.
 */
@Component({
  selector: 'app-edit-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (editing(); as e) {
      <form
        class="cell"
        [attr.aria-label]="t.bar"
        (submit)="$event.preventDefault(); take()"
        (keydown)="onKey($event)"
      >
        <label for="edit-value">
          {{ t.where(e.row + 1, e.meta.name) }}
          <span class="type">{{ type(e.meta.typeName) }}</span>
        </label>
        @if (multiline()) {
          <textarea
            #field
            id="edit-value"
            rows="4"
            spellcheck="false"
            [attr.aria-label]="t.value"
            [attr.aria-invalid]="problem() ? 'true' : null"
            [attr.aria-describedby]="problem() ? 'edit-problem' : null"
            [value]="e.text"
            (input)="problem.set(null)"
          ></textarea>
        } @else {
          <input
            #field
            id="edit-value"
            type="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            [attr.aria-label]="t.value"
            [attr.aria-invalid]="problem() ? 'true' : null"
            [attr.aria-describedby]="problem() ? 'edit-problem' : null"
            [value]="e.text"
            (input)="problem.set(null)"
          />
        }
        <button type="submit" class="primary">{{ t.take }}</button>
        <button type="button" [title]="t.setNullHint" (click)="set('null')">{{ t.setNull }}</button>
        <button type="button" [title]="t.setDefaultHint" (click)="set('default')">
          {{ t.setDefault }}
        </button>
        <button type="button" (click)="edit.cancel()">{{ t.cancel }}</button>
        @if (problem(); as p) {
          <p id="edit-problem" class="problem">{{ p }}</p>
        }
      </form>
    }
    @if (count().cells > 0) {
      <div class="pending" role="group" [attr.aria-label]="pending()">
        <span class="mark" aria-hidden="true"></span>
        <span class="text" role="status">{{ pending() }}</span>
        <button type="button" (click)="edit.showPreview(tab())">{{ t.preview }}</button>
        <button type="button" class="primary" [disabled]="edit.busy()" (click)="edit.save(tab())">
          {{ t.write }}
        </button>
        <button
          type="button"
          (click)="edit.undo(tab())"
          [disabled]="tab().edits().undo.length === 0"
        >
          {{ t.undo }}
        </button>
        <button
          type="button"
          (click)="edit.redo(tab())"
          [disabled]="tab().edits().redo.length === 0"
        >
          {{ t.redo }}
        </button>
        <button type="button" (click)="edit.discard(tab())">{{ t.discard }}</button>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      border-bottom: 1px solid var(--border);
      background: var(--bg-panel);
      font-size: 12px;
    }
    :host:empty {
      display: none;
    }
    .cell,
    .pending {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
    }
    label {
      flex: none;
      color: var(--text-dim);
    }
    .type {
      font-family: var(--font-mono);
    }
    input,
    textarea {
      flex: 1 1 200px;
      min-width: 120px;
      font-family: var(--font-mono);
    }
    textarea {
      resize: vertical;
    }
    [aria-invalid='true'] {
      border-color: var(--danger);
    }
    .problem {
      flex-basis: 100%;
      margin: 0;
      color: var(--danger);
    }
    .mark {
      flex: none;
      width: 10px;
      height: 10px;
      border-radius: 2px;
      background: var(--cell-changed-bg);
      border: 1px solid var(--cell-changed-text);
    }
    .text {
      margin-right: 6px;
    }
  `,
})
export class EditBar {
  protected readonly t = EDIT_TEXTS;
  protected readonly type = typeLabel;
  protected readonly edit = inject(EditService);
  readonly tab = input.required<QueryTab>();

  /** The cell being edited, if it is one of this tab. */
  protected readonly editing = computed(() => {
    const e = this.edit.editing();
    return e && e.tab === this.tab() ? e : null;
  });
  protected readonly multiline = computed(() => this.editing()?.text.includes('\n') ?? false);
  protected readonly count = computed(() => this.edit.count(this.tab()));
  protected readonly pending = computed(() =>
    this.t.pending(this.count().cells, this.count().rows),
  );
  protected readonly problem = signal<string | null>(null);
  private readonly field = viewChild<ElementRef<HTMLInputElement | HTMLTextAreaElement>>('field');

  constructor() {
    effect(() => {
      // a cell to edit: the keyboard goes into its field, the old value marked to type over it
      const e = this.editing();
      const field = this.field()?.nativeElement;
      if (!e || !field) return;
      this.problem.set(null);
      field.focus();
      field.select();
    });
  }

  protected take(): void {
    const field = this.field()?.nativeElement;
    if (field) this.problem.set(this.edit.commit({ kind: 'value', text: field.value }));
  }

  protected set(kind: 'null' | 'default'): void {
    this.problem.set(this.edit.commit({ kind }));
  }

  /** Keys of the edit row (a widget of its own). */
  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.edit.cancel();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      // in a text of several lines Enter is a line break: this takes the value
      event.preventDefault();
      event.stopPropagation();
      this.take();
    }
  }
}
