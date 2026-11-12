import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { describeError } from '../../core/errors/app-error';
import {
  ColumnSpec,
  GenKind,
  TestdataApi,
  TestdataPreview,
  TestdataReference,
} from '../../core/testdata/testdata-api';
import {
  GEN_KINDS,
  GenField,
  PREVIEW_ROWS,
  fieldsOf,
  newSeed,
  rowsFollow,
  specOf,
  withField,
  withKind,
  withTemplate,
} from './testdata-logic';
import { TESTDATA_TEXTS } from './testdata-texts';
import { TestdataService, TestdataTarget } from './testdata.service';

/**
 * Test data for a table (prompt 049): a generator per column – proposed from the table, changed by the
 * user –, the first rows as they would be written, and the ways to write them: into the table, or into
 * a file. The rows are made in the backend; every change asks for the preview anew. Values of the
 * preview are generated text and shown as text.
 */
@Component({
  selector: 'app-testdata-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="td-title" (cancel)="$event.preventDefault(); close()">
      <h2 id="td-title">{{ t.title(target().table) }}</h2>
      <div class="row">
        <label>
          {{ t.rows }}
          <input
            #rw
            type="number"
            min="0"
            max="50000000"
            [value]="rows()"
            [disabled]="follows() || service.running()"
            (change)="rows.set(whole(rw.value, rows()))"
          />
        </label>
        <label [title]="t.seedHint">
          {{ t.seed }}
          <input
            #sd
            type="number"
            min="0"
            [value]="seed()"
            [disabled]="service.running()"
            (change)="seed.set(whole(sd.value, seed()))"
          />
        </label>
        <button type="button" [disabled]="service.running()" (click)="seed.set(another())">
          {{ t.newSeed }}
        </button>
        <label>
          {{ t.locale }}
          <select #lc [disabled]="service.running()" (change)="locale.set(lc.value)">
            <option value="en" [selected]="locale() === 'en'">{{ t.locales.en }}</option>
            <option value="de" [selected]="locale() === 'de'">{{ t.locales.de }}</option>
          </select>
        </label>
      </div>
      @if (fromTemplate()) {
        <p class="note">{{ t.fromTemplate }}</p>
      }
      @if (problem()) {
        <p class="warn" role="alert">{{ problem() }}</p>
      }
      <div class="columns">
        @if (columns().length === 0 && !problem()) {
          <p class="note">{{ t.reading }}</p>
        } @else {
          <table>
            <thead>
              <tr>
                <th scope="col">{{ t.column }}</th>
                <th scope="col">{{ t.generator }}</th>
                <th scope="col">{{ t.settings }}</th>
                <th scope="col" class="num">{{ t.nullShare }}</th>
                <th scope="col">{{ t.unique }}</th>
              </tr>
            </thead>
            <tbody>
              @for (c of columns(); track c.name; let i = $index) {
                <tr>
                  <th scope="row">
                    {{ c.name }}
                    <span class="note">{{ c.typeName }}</span>
                    @if (referenceOf(c.name); as r) {
                      <span class="note">{{ t.pointsTo(r.refTable, r.refColumn) }}</span>
                    }
                  </th>
                  <td>
                    <select
                      #kind
                      [attr.aria-label]="t.generatorOf(c.name)"
                      [disabled]="service.running()"
                      (change)="setKind(i, kind.value)"
                    >
                      @for (k of kindsFor(c.name); track k) {
                        <option [value]="k" [selected]="c.gen.kind === k">{{ t.kinds[k] }}</option>
                      }
                    </select>
                  </td>
                  <td class="fields">
                    @for (f of fields(c); track f.key) {
                      @if (f.type === 'check') {
                        <label>
                          <input
                            #box
                            type="checkbox"
                            [checked]="f.value === true"
                            [disabled]="service.running()"
                            [attr.aria-label]="t.fieldOf(c.name, fieldName(f.key))"
                            (change)="setField(i, f.key, box.checked)"
                          />
                          {{ fieldName(f.key) }}
                        </label>
                      } @else if (f.type === 'lines') {
                        <textarea
                          #area
                          rows="2"
                          spellcheck="false"
                          [value]="f.value"
                          [disabled]="service.running()"
                          [attr.aria-label]="t.fieldOf(c.name, fieldName(f.key))"
                          [placeholder]="fieldName(f.key)"
                          (change)="setField(i, f.key, area.value)"
                        ></textarea>
                      } @else {
                        <label>
                          {{ fieldName(f.key) }}
                          <input
                            #inp
                            [type]="f.type"
                            [class.wide]="isWide(f)"
                            spellcheck="false"
                            autocomplete="off"
                            [value]="f.value"
                            [disabled]="service.running()"
                            [attr.aria-label]="t.fieldOf(c.name, fieldName(f.key))"
                            (change)="setField(i, f.key, inp.value)"
                          />
                        </label>
                      }
                    }
                  </td>
                  <td class="num">
                    <input
                      #ns
                      type="number"
                      min="0"
                      max="100"
                      [value]="percent(c.nullShare)"
                      [disabled]="service.running() || c.gen.kind === 'skip'"
                      [attr.aria-label]="t.fieldOf(c.name, t.nullShare)"
                      (change)="setNull(i, ns.value)"
                    />
                  </td>
                  <td>
                    <input
                      #uq
                      type="checkbox"
                      [checked]="c.unique"
                      [disabled]="service.running() || c.gen.kind === 'skip'"
                      [attr.aria-label]="t.fieldOf(c.name, t.unique)"
                      (change)="setUnique(i, uq.checked)"
                    />
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
      </div>
      <h3>
        {{ t.preview }}
        @if (preview(); as p) {
          <span class="note">{{ t.previewOf(p.rows.length, p.total) }}</span>
        }
      </h3>
      <div class="preview">
        @if (preview(); as p) {
          <table>
            <thead>
              <tr>
                @for (name of p.columns; track $index) {
                  <th scope="col">{{ name }}</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (row of p.rows; track $index) {
                <tr>
                  @for (cell of row; track $index) {
                    <td [class.null]="cell === null">{{ cell === null ? t.nullValue : cell }}</td>
                  }
                </tr>
              }
            </tbody>
          </table>
        }
      </div>
      <div class="row">
        <label>
          <input
            #cf
            type="checkbox"
            [checked]="clearFirst()"
            [disabled]="service.running()"
            (change)="clearFirst.set(cf.checked)"
          />
          {{ t.clearFirst }}
        </label>
        <label>
          <input
            #wt
            type="checkbox"
            [checked]="wholeTransaction()"
            [disabled]="service.running()"
            (change)="wholeTransaction.set(wt.checked)"
          />
          {{ t.wholeTransaction }}
        </label>
        <span class="note" role="status">{{ statusText() }}</span>
      </div>
      @if (!canWrite()) {
        <p class="note">{{ t.protectedConnection }}</p>
      }
      <div class="buttons">
        <button type="button" [disabled]="!ready()" (click)="remember()">
          {{ t.saveTemplate }}
        </button>
        <span class="grow"></span>
        @if (service.running()) {
          <button type="button" (click)="service.stop()">{{ t.stop }}</button>
        } @else {
          <button type="button" [disabled]="!ready()" (click)="export('csv')">
            {{ t.exportCsv }}
          </button>
          <button type="button" [disabled]="!ready()" (click)="export('insert')">
            {{ t.exportInsert }}
          </button>
          <button
            type="button"
            class="primary"
            [disabled]="!ready() || !canWrite()"
            (click)="run()"
          >
            {{ t.run }}
          </button>
        }
        <button type="button" (click)="close()">{{ t.close }}</button>
      </div>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(1180px, calc(100vw - 32px));
      height: min(820px, calc(100vh - 32px));
      padding: 14px 16px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    dialog[open] {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 35%);
    }
    h2,
    h3 {
      flex: none;
      margin: 0;
      font-size: 14px;
    }
    h3 {
      font-size: 12px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    h3 .note {
      margin-left: 8px;
      text-transform: none;
      letter-spacing: 0;
    }
    .row,
    .buttons {
      flex: none;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 14px;
    }
    label {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .grow {
      flex: 1;
    }
    .columns {
      flex: 3;
      min-height: 0;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    .preview {
      flex: 2;
      min-height: 0;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    thead th {
      position: sticky;
      top: 0;
      background: var(--bg-panel);
      color: var(--text-dim);
      font-weight: normal;
      white-space: nowrap;
    }
    th,
    td {
      padding: 2px 8px;
      text-align: left;
      vertical-align: top;
    }
    tbody th {
      font-weight: normal;
      white-space: nowrap;
    }
    tbody th .note {
      margin-left: 6px;
    }
    .preview td {
      max-width: 260px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-family: var(--font-mono, monospace);
    }
    td.null {
      color: var(--text-dim);
      font-style: italic;
    }
    .fields {
      display: flex;
      flex-wrap: wrap;
      gap: 3px 10px;
    }
    .fields input[type='number'] {
      width: 84px;
    }
    .fields input[type='text'] {
      width: 110px;
    }
    .fields input.wide {
      width: 260px;
    }
    textarea {
      width: 220px;
      font-family: var(--font-mono, monospace);
      font-size: 12px;
    }
    .num {
      text-align: right;
    }
    td.num input,
    .row input[type='number'] {
      width: 96px;
    }
    td.num input {
      width: 56px;
    }
    .note {
      margin: 0;
      color: var(--text-dim);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .columns > .note {
      padding: 6px 8px;
    }
    .warn {
      flex: none;
      margin: 0;
      color: var(--danger);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    button {
      padding: 3px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-text);
    }
    button:disabled {
      opacity: 0.5;
    }
  `,
})
export class TestdataDialog {
  readonly target = input.required<TestdataTarget>();
  readonly closed = output<void>();

  protected readonly service = inject(TestdataService);
  private readonly api = inject(TestdataApi);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly t = TESTDATA_TEXTS;
  protected readonly columns = signal<readonly ColumnSpec[]>([]);
  private readonly references = signal<readonly TestdataReference[]>([]);
  protected readonly rows = signal(1000);
  protected readonly seed = signal(1);
  protected readonly locale = signal('en');
  protected readonly clearFirst = signal(false);
  protected readonly wholeTransaction = signal(false);
  protected readonly preview = signal<TestdataPreview | null>(null);
  protected readonly problem = signal('');
  protected readonly note = signal('');
  protected readonly fromTemplate = signal(false);
  private asked = 0;

  protected readonly follows = computed(() => rowsFollow(this.columns()));
  protected readonly spec = computed(() => {
    const target = this.target();
    return specOf(
      target.schema,
      target.table,
      this.columns(),
      this.rows(),
      this.seed(),
      this.locale(),
    );
  });
  protected readonly canWrite = computed(() => this.service.canWrite(this.target().connectionId));
  /** There is something to write, and the backend took the spec. */
  protected readonly ready = computed(
    () => this.preview() !== null && this.problem() === '' && !this.service.running(),
  );
  protected readonly statusText = computed(() => {
    const p = this.service.progress();
    return p ? this.t.writing(p.rows, p.total) : this.note();
  });

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
    effect(() => {
      const target = this.target();
      untracked(() => void this.load(target));
    });
    effect(() => {
      // every change of the spec asks for the preview anew
      const spec = this.spec();
      if (spec.columns.length === 0) return;
      untracked(() => void this.refresh());
    });
  }

  private async load(target: TestdataTarget): Promise<void> {
    try {
      const suggestion = await this.api.suggest(target.connectionId, target.schema, target.table);
      const template = this.service.template(target);
      this.references.set(suggestion.references);
      if (template) {
        this.rows.set(template.rows);
        this.locale.set(template.locale);
      }
      this.fromTemplate.set(template !== undefined);
      this.columns.set(withTemplate(suggestion.columns, template));
    } catch (e) {
      this.problem.set(describeError(e));
    }
  }

  private async refresh(): Promise<void> {
    const asked = ++this.asked;
    try {
      const preview = await this.api.preview(this.target().connectionId, this.spec(), PREVIEW_ROWS);
      if (asked !== this.asked) return;
      this.preview.set(preview);
      this.problem.set('');
    } catch (e) {
      if (asked !== this.asked) return;
      this.preview.set(null);
      this.problem.set(describeError(e));
    }
  }

  protected referenceOf(column: string): TestdataReference | null {
    return this.references().find((r) => r.column === column) ?? null;
  }

  /** The generators a column can have: values of another table only where a key points to one. */
  protected kindsFor(column: string): readonly GenKind[] {
    return this.referenceOf(column) ? GEN_KINDS : GEN_KINDS.filter((k) => k !== 'foreignKey');
  }

  protected fields(column: ColumnSpec): GenField[] {
    const all = fieldsOf(column.gen);
    // the numbers of "rows per parent" only while it is on
    return column.gen.kind === 'foreignKey' && column.gen.perParent === null
      ? all.slice(0, 1)
      : all;
  }

  protected fieldName(key: string): string {
    return (this.t.fields as Record<string, string>)[key] ?? key;
  }

  protected isWide(field: GenField): boolean {
    return field.key === 'pattern' || field.key === 'template' || field.key === 'value';
  }

  protected percent(share: number): number {
    return Math.round(share * 100);
  }

  protected whole(text: string, fallback: number): number {
    const n = Math.round(Number(text));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  protected another(): number {
    return newSeed();
  }

  private change(index: number, change: (column: ColumnSpec) => ColumnSpec): void {
    this.note.set('');
    this.columns.update((all) => all.map((c, i) => (i === index ? change(c) : c)));
  }

  protected setKind(index: number, kind: string): void {
    if ((GEN_KINDS as readonly string[]).includes(kind)) {
      this.change(index, (c) => withKind(c, kind as GenKind));
    }
  }

  protected setField(index: number, key: string, value: string | boolean): void {
    this.change(index, (c) => ({ ...c, gen: withField(c.gen, key, value) }));
  }

  protected setNull(index: number, text: string): void {
    const share = Math.min(100, Math.max(0, this.whole(text, 0))) / 100;
    this.change(index, (c) => ({ ...c, nullShare: share }));
  }

  protected setUnique(index: number, unique: boolean): void {
    this.change(index, (c) => ({ ...c, unique }));
  }

  protected remember(): void {
    this.service.remember(this.target(), {
      columns: this.columns(),
      rows: this.rows(),
      locale: this.locale(),
    });
    this.note.set(this.t.templateSaved);
  }

  protected async run(): Promise<void> {
    const total = this.preview()?.total ?? this.rows();
    this.note.set('');
    const said = await this.service.run(this.target().connectionId, this.spec(), total, {
      clearFirst: this.clearFirst(),
      wholeTransaction: this.wholeTransaction(),
    });
    this.note.set(said);
  }

  protected async export(format: 'csv' | 'insert'): Promise<void> {
    const total = this.preview()?.total ?? this.rows();
    this.note.set('');
    const said = await this.service.export(this.target().connectionId, this.spec(), total, format);
    if (said !== null) this.note.set(said);
  }

  protected close(): void {
    this.closed.emit();
  }
}
