import { Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { COMMON_TEXTS } from '../../core/i18n/common-texts';
import {
  EMPTY_VALUE,
  FORM_SIGNS,
  PARAM_FORMS,
  PARAM_TYPES,
  ParamForm,
  ParamType,
  ParamValue,
  bind,
  formsOf,
  inPlace,
  listKeys,
  paramKeys,
  resolve,
} from './param-logic';
import { ParamService } from './param.service';
import { PARAM_TEXTS } from './param-texts';

/**
 * The values of the parameters of a run (prompt 025): a field per parameter with what was given last, a
 * type for those the text does not tell, `Enter` runs. Below, which ways of writing a parameter count on
 * this connection – changing them changes the fields at once. Open while `ParamService.request` is set.
 */
@Component({
  selector: 'app-param-dialog',
  template: `
    <dialog #dialog aria-labelledby="param-title" (cancel)="$event.preventDefault(); cancel()">
      <form (submit)="$event.preventDefault(); submit()">
        <h2 id="param-title">{{ t.title }}</h2>
        <p class="hint">{{ t.intro }}</p>
        @if (keys().length === 0) {
          <p class="hint">{{ t.none }}</p>
        }
        <div class="rows">
          @for (key of keys(); track key) {
            @let value = valueOf(key);
            <label class="name" [for]="'param-' + $index">{{ key }}</label>
            @if (value.type === 'list') {
              <textarea
                class="field"
                rows="3"
                spellcheck="false"
                [id]="'param-' + $index"
                [attr.aria-label]="t.value(key)"
                [attr.aria-describedby]="'param-reads-' + $index"
                [attr.aria-invalid]="bad() === key"
                [value]="value.text"
                (input)="setText(key, $any($event.target).value)"
                (keydown.control.enter)="$event.preventDefault(); submit()"
                (keydown.meta.enter)="$event.preventDefault(); submit()"
              ></textarea>
            } @else {
              <input
                class="field"
                type="text"
                autocomplete="off"
                spellcheck="false"
                [id]="'param-' + $index"
                [attr.aria-label]="t.value(key)"
                [attr.aria-describedby]="'param-reads-' + $index"
                [attr.aria-invalid]="bad() === key"
                [disabled]="value.type === 'null'"
                [value]="value.type === 'null' ? '' : value.text"
                (input)="setText(key, $any($event.target).value)"
              />
            }
            <select
              class="type"
              [attr.aria-label]="t.type(key)"
              (change)="setType(key, $any($event.target).value)"
            >
              @for (type of types; track type) {
                <option [value]="type" [selected]="type === value.type">{{ t.types[type] }}</option>
              }
            </select>
            <span class="reads" [id]="'param-reads-' + $index">{{ reads(key) }}</span>
          }
        </div>
        @if (message(); as m) {
          <p class="problem" role="alert">{{ m }}</p>
        }
        <fieldset class="forms">
          <legend>{{ t.forms }}</legend>
          @for (form of allForms; track form) {
            <label>
              <input
                type="checkbox"
                [checked]="forms().includes(form)"
                (change)="toggleForm(form, $any($event.target).checked)"
              />
              <code>{{ signs[form] }}</code>
            </label>
          }
          <button type="button" class="link" [disabled]="!ownForms()" (click)="resetForms()">
            {{ t.formsReset }}
          </button>
        </fieldset>
        <footer>
          <button type="button" (click)="cancel()">{{ common.cancel }}</button>
          <button type="submit" class="primary">{{ t.run }}</button>
        </footer>
      </form>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(620px, 94vw);
      padding: 16px;
    }
    h2 {
      margin: 0 0 4px;
      font-size: 15px;
    }
    .hint {
      margin: 0 0 8px;
      color: var(--text-dim);
      font-size: 12px;
    }
    .rows {
      display: grid;
      grid-template-columns: minmax(60px, auto) minmax(0, 1fr) auto;
      gap: 6px 8px;
      align-items: start;
      max-height: 50vh;
      overflow: auto;
      padding: 2px;
    }
    .name {
      padding-top: 5px;
      font-family: var(--font-mono);
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    .field {
      width: 100%;
      font-family: var(--font-mono);
      font-size: 13px;
    }
    textarea.field {
      resize: vertical;
    }
    .reads {
      grid-column: 2 / -1;
      margin-top: -4px;
      color: var(--text-dim);
      font-size: 11px;
    }
    .problem {
      margin: 8px 0 0;
      color: var(--error-fg);
    }
    .forms {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 14px;
      margin: 12px 0 0;
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    legend {
      padding: 0 4px;
      color: var(--text-dim);
      font-size: 12px;
    }
    .forms label {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    code {
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .link {
      margin-left: auto;
    }
    footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 12px;
    }
  `,
})
export class ParamDialog implements OnInit {
  protected readonly t = PARAM_TEXTS;
  protected readonly common = COMMON_TEXTS;
  protected readonly types = PARAM_TYPES;
  protected readonly allForms = PARAM_FORMS;
  protected readonly signs = FORM_SIGNS;
  private readonly service = inject(ParamService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  /** What the dialog was opened for; it stays that while it is open. */
  private readonly request = this.service.request()!;
  private readonly own = signal(this.service.forms(this.request.connectionId));
  protected readonly ownForms = computed(() => this.own() !== undefined);
  protected readonly forms = computed(() => formsOf(this.request.dialect, this.own()));
  protected readonly keys = computed(() =>
    paramKeys(this.request.sqls, this.request.dialect, this.forms()),
  );
  private readonly values = signal<Readonly<Record<string, ParamValue>>>(this.request.values);
  protected readonly message = signal<string | null>(null);
  /** The parameter whose value was refused. */
  protected readonly bad = signal<string | null>(null);

  ngOnInit(): void {
    const dialog = this.dialog().nativeElement;
    dialog.showModal();
    // the fields are drawn after this: the first one gets the focus then
    setTimeout(() => {
      const first = dialog.querySelector<HTMLInputElement>('.field:not([disabled])');
      first?.focus();
      first?.select?.();
    });
  }

  protected valueOf(key: string): ParamValue {
    return this.values()[key] ?? EMPTY_VALUE;
  }

  private readonly lists = computed(() =>
    listKeys(this.request.sqls, this.request.dialect, this.forms()),
  );

  /** What the value is read as – so `Automatic` is no guess the user cannot see. */
  protected reads(key: string): string {
    const value = inPlace(this.valueOf(key), this.lists().has(key));
    const resolved = resolve(value);
    if (!resolved.ok) return '';
    if (resolved.values === null) return this.t.reads.null;
    if (value.type === 'list') return this.t.reads.list(resolved.values.length);
    return this.t.reads[resolved.values[0].kind];
  }

  private change(key: string, change: Partial<ParamValue>): void {
    this.values.update((all) => ({ ...all, [key]: { ...(all[key] ?? EMPTY_VALUE), ...change } }));
    this.message.set(null);
    this.bad.set(null);
  }

  protected setText(key: string, text: string): void {
    this.change(key, { text });
  }

  protected setType(key: string, type: ParamType): void {
    this.change(key, { type });
  }

  protected toggleForm(form: ParamForm, on: boolean): void {
    const next = PARAM_FORMS.filter((f) => (f === form ? on : this.forms().includes(f)));
    this.own.set(next);
    this.service.setForms(this.request.connectionId, next);
    this.message.set(null);
  }

  protected resetForms(): void {
    this.own.set(undefined);
    this.service.setForms(this.request.connectionId, null);
  }

  /** Runs when every statement can be written with the values; else says which value is in the way. */
  protected submit(): void {
    const keys = this.keys();
    const values: Record<string, ParamValue> = {};
    for (const key of keys) values[key] = this.valueOf(key);
    for (const sql of this.request.sqls) {
      const bound = bind(sql, this.request.dialect, this.forms(), values);
      if (!bound.ok) {
        this.bad.set(bound.key);
        this.message.set(this.t.problems[bound.problem](bound.key));
        return;
      }
    }
    this.dialog().nativeElement.close();
    this.service.answer(values);
  }

  protected cancel(): void {
    this.dialog().nativeElement.close();
    this.service.answer(null);
  }
}
