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
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { describeError, toAppError } from '../../core/errors/app-error';
import { COMMON_TEXTS } from '../../core/i18n/common-texts';
import {
  DataImportApi,
  ImportEncoding,
  ImportFormat,
  FilePreview,
} from '../../core/import/data-import-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { ObjectInfo, SchemaInfo } from '../../core/schema/schema.models';
import {
  DEFAULT_CHOICES,
  ImportChoices,
  MapRow,
  PREVIEW_SHOWN,
  autoMap,
  ddlColumns,
  detectedLine,
  fileOf,
  nullTexts,
  planOf,
  remap,
  runOptions,
  reportLine,
  sourceOptions,
  tableNameOf,
  unfilled,
} from './data-import-logic';
import { DataImportService, ImportTarget } from './data-import.service';
import { DATA_IMPORT_TEXTS } from './data-import-texts';

/**
 * A file into a table (prompt 033): choose the file, see its start as the options read it, choose or
 * create the table, map columns, start. The backend reads and writes; while it does, this shows the
 * progress, then the report. Nothing of the file is set into the page as markup.
 */
@Component({
  selector: 'app-data-import-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="di-title" (cancel)="$event.preventDefault(); close()">
      <h2 id="di-title">{{ t.title }}</h2>
      @if (job(); as j) {
        <div class="report" aria-live="polite">
          @if (j.state === 'running') {
            <p>{{ t.running(j.read) }}</p>
            <progress></progress>
          } @else if (j.report; as r) {
            <p class="headline" [class.bad]="r.failed">{{ reportOf(r) }}</p>
            <p class="dim">{{ t.counts(r.read, r.written, r.skipped) }}</p>
            @if (r.cleared && (r.failed || r.cancelled)) {
              <p class="bad">{{ t.emptied }}</p>
            }
            @if (r.errors.length > 0) {
              <h3>{{ t.problems }}</h3>
              <ul class="errors">
                @for (e of r.errors; track $index) {
                  <li>
                    <b>{{ t.line(e.line) }}</b> {{ e.reason }}
                  </li>
                }
              </ul>
            }
          } @else {
            <p class="headline bad" role="alert">{{ t.failed(j.error ?? '') }}</p>
          }
        </div>
        <footer>
          @if (j.state === 'running') {
            <button type="button" (click)="importer.cancel()">{{ t.stop }}</button>
          } @else {
            @if (j.report?.errorFile) {
              <button type="button" (click)="importer.reveal()">{{ t.showErrorFile }}</button>
            }
            <button type="button" (click)="importer.job.set(null)">{{ t.again }}</button>
            <button type="button" class="primary" (click)="close()">{{ t.close }}</button>
          }
        </footer>
      } @else {
        <form (submit)="$event.preventDefault(); go()">
          <fieldset>
            <legend>{{ t.file }}</legend>
            <div class="line">
              <button type="button" (click)="chooseFile()">{{ t.chooseFile }}</button>
              <span class="path" [title]="path() ?? ''">{{ path() ? fileName() : t.noFile }}</span>
            </div>
            <div class="grid">
              <label for="di-format">{{ t.format }}</label>
              <select #fmt id="di-format" (change)="setFormat(fmt.value)">
                @for (f of formats; track f) {
                  <option [value]="f" [selected]="choices().format === f">
                    {{ t.formats[f] }}
                  </option>
                }
              </select>
              <label for="di-delimiter">{{ t.delimiter }}</label>
              <select #del id="di-delimiter" (change)="set({ delimiter: del.value })">
                <option value="" [selected]="choices().delimiter === ''">{{ t.detect }}</option>
                <option value="," [selected]="choices().delimiter === ','">{{ t.comma }}</option>
                <option value=";" [selected]="choices().delimiter === ';'">
                  {{ t.semicolon }}
                </option>
                <option value="&#9;" [selected]="choices().delimiter === tab">{{ t.tab }}</option>
                <option value="|" [selected]="choices().delimiter === '|'">{{ t.pipe }}</option>
              </select>
              <label for="di-encoding">{{ t.encoding }}</label>
              <select #enc id="di-encoding" (change)="setEncoding(enc.value)">
                <option value="" [selected]="choices().encoding === ''">{{ t.detect }}</option>
                @for (e of encodings; track e) {
                  <option [value]="e" [selected]="choices().encoding === e">
                    {{ e.toUpperCase() }}
                  </option>
                }
              </select>
              <label for="di-header">{{ t.header }}</label>
              <select #hd id="di-header" (change)="setHeader(hd.value)">
                <option value="auto" [selected]="choices().header === 'auto'">
                  {{ t.detect }}
                </option>
                <option value="yes" [selected]="choices().header === 'yes'">{{ t.yes }}</option>
                <option value="no" [selected]="choices().header === 'no'">{{ t.no }}</option>
              </select>
              <label for="di-skip">{{ t.skipLines }}</label>
              <input
                #skip
                id="di-skip"
                type="number"
                min="0"
                [value]="choices().skipLines"
                (change)="set({ skipLines: +skip.value })"
              />
              <label for="di-nulls">{{ t.nullTexts }}</label>
              <input
                #nulls
                id="di-nulls"
                type="text"
                spellcheck="false"
                [value]="choices().nullTexts"
                (change)="set({ nullTexts: nulls.value })"
              />
            </div>
            <label class="check">
              <input
                #ein
                type="checkbox"
                [checked]="choices().emptyIsNull"
                (change)="set({ emptyIsNull: ein.checked })"
              />
              {{ t.emptyIsNull }}
            </label>
            @if (previewError(); as p) {
              <p class="problem" role="alert">{{ p }}</p>
            }
            @if (preview(); as pv) {
              <p class="dim">{{ detected() }}</p>
              @if (pv.broken > 0) {
                <p class="problem">{{ t.previewBroken(pv.broken) }}</p>
              }
              @if (pv.rows.length === 0) {
                <p class="problem">{{ t.empty }}</p>
              } @else {
                <div class="preview" tabindex="0" role="region" [attr.aria-label]="t.preview">
                  <table>
                    <thead>
                      <tr>
                        @for (c of pv.columns; track $index) {
                          <th scope="col">
                            {{ c }}<span class="kind">{{ pv.types[$index]?.kind }}</span>
                          </th>
                        }
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of shown(); track $index) {
                        <tr>
                          @for (cell of row; track $index) {
                            <td [class.null]="cell === null">{{ cell ?? 'NULL' }}</td>
                          }
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
            }
          </fieldset>

          <fieldset>
            <legend>{{ t.target }}</legend>
            <div class="grid">
              <label for="di-schema">{{ t.schema }}</label>
              <select #sch id="di-schema" (change)="setSchema(sch.value)">
                @for (s of schemas(); track s.name) {
                  <option [value]="s.name" [selected]="s.name === schema()">{{ s.name }}</option>
                }
              </select>
            </div>
            <div class="line" role="radiogroup" [attr.aria-label]="t.target">
              <label class="check">
                <input
                  type="radio"
                  name="di-kind"
                  [checked]="!creating()"
                  (change)="creating.set(false)"
                />
                {{ t.existingTable }}
              </label>
              <label class="check">
                <input
                  type="radio"
                  name="di-kind"
                  [checked]="creating()"
                  (change)="startCreating()"
                />
                {{ t.newTable }}
              </label>
            </div>
            @if (!creating()) {
              <div class="grid">
                <label for="di-table">{{ t.table }}</label>
                <select #tbl id="di-table" (change)="setTable(tbl.value)">
                  <option value="" [selected]="table() === ''">{{ t.chooseTable }}</option>
                  @for (o of tables(); track o.name) {
                    <option [value]="o.name" [selected]="o.name === table()">{{ o.name }}</option>
                  }
                </select>
              </div>
            } @else {
              <div class="grid">
                <label for="di-new">{{ t.tableName }}</label>
                <input
                  #nn
                  id="di-new"
                  type="text"
                  spellcheck="false"
                  [value]="newName()"
                  (change)="setNewName(nn.value)"
                />
              </div>
              <label class="dim" for="di-ddl">{{ t.ddl }}</label>
              <textarea
                #ddlText
                id="di-ddl"
                rows="7"
                spellcheck="false"
                [value]="ddl()"
                (input)="ddl.set(ddlText.value)"
              ></textarea>
              <div class="line">
                <button type="button" [disabled]="!preview()" (click)="propose()">
                  {{ t.propose }}
                </button>
                <button
                  type="button"
                  [disabled]="ddl().trim() === '' || busy()"
                  (click)="createTable()"
                >
                  {{ t.createTable }}
                </button>
              </div>
            }
            @if (targetNote(); as n) {
              <p [class.problem]="n.bad" [class.dim]="!n.bad" role="status">{{ n.text }}</p>
            }
          </fieldset>

          @if (maps().length > 0 && preview(); as pv) {
            <fieldset>
              <legend>{{ t.mapping }}</legend>
              <div class="mapping">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{{ t.targetColumn }}</th>
                      <th scope="col">{{ t.type }}</th>
                      <th scope="col">{{ t.source }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (m of maps(); track m.target.name; let i = $index) {
                      <tr>
                        <th scope="row">{{ m.target.name }}</th>
                        <td class="dim">{{ m.target.typeName }}</td>
                        <td>
                          <select
                            #src
                            [attr.aria-label]="t.sourceLabel(m.target.name)"
                            (change)="setSource(i, src.value)"
                          >
                            <option value="none" [selected]="m.source === 'none'">
                              {{ t.skipColumn }}
                            </option>
                            <option value="fixed" [selected]="m.source === 'fixed'">
                              {{ t.fixedValue }}
                            </option>
                            @for (c of pv.columns; track $index) {
                              <option [value]="$index" [selected]="m.source === $index">
                                {{ c }}
                              </option>
                            }
                          </select>
                          @if (m.source === 'fixed') {
                            <input
                              #fx
                              type="text"
                              spellcheck="false"
                              [attr.aria-label]="t.fixedLabel(m.target.name)"
                              [value]="m.fixed"
                              (input)="setFixed(i, fx.value)"
                            />
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              @if (missing().length > 0) {
                <p class="problem">{{ t.unfilled(missing().join(', ')) }}</p>
              }
              <div class="checks">
                <label class="check">
                  <input
                    #tr
                    type="checkbox"
                    [checked]="choices().trim"
                    (change)="set({ trim: tr.checked })"
                  />
                  {{ t.trim }}
                </label>
                <label class="check">
                  <input
                    #dc
                    type="checkbox"
                    [checked]="choices().decimalComma"
                    (change)="set({ decimalComma: dc.checked })"
                  />
                  {{ t.decimalComma }}
                </label>
                <label class="check" for="di-dates">
                  {{ t.dates }}
                  <select #dt id="di-dates" (change)="setDates(dt.value)">
                    <option value="" [selected]="choices().dateOrder === ''">
                      {{ t.datesIso }}
                    </option>
                    <option value="dmy" [selected]="choices().dateOrder === 'dmy'">
                      {{ t.datesDmy }}
                    </option>
                    <option value="mdy" [selected]="choices().dateOrder === 'mdy'">
                      {{ t.datesMdy }}
                    </option>
                  </select>
                </label>
              </div>
            </fieldset>

            <fieldset>
              <legend>{{ t.mode }}</legend>
              <label class="check">
                <input
                  #cf
                  type="checkbox"
                  [checked]="choices().clearFirst"
                  (change)="set({ clearFirst: cf.checked })"
                />
                {{ t.clearFirst }}
              </label>
              <div class="grid">
                <label for="di-onerror">{{ t.onError }}</label>
                <select #oe id="di-onerror" (change)="setOnError(oe.value)">
                  <option value="abort" [selected]="choices().onError === 'abort'">
                    {{ t.abort }}
                  </option>
                  <option value="skip" [selected]="choices().onError === 'skip'">
                    {{ t.skip }}
                  </option>
                </select>
              </div>
              @if (choices().onError === 'abort') {
                <label class="check">
                  <input
                    #wt
                    type="checkbox"
                    [checked]="choices().wholeTransaction"
                    (change)="set({ wholeTransaction: wt.checked })"
                  />
                  {{ t.wholeTransaction }}
                </label>
              } @else {
                <div class="line">
                  <span>{{ t.errorFile }}</span>
                  <button type="button" (click)="chooseErrorFile()">{{ t.chooseErrorFile }}</button>
                  <span class="path" [title]="errorPath() ?? ''">{{
                    errorPath() ? errorName() : t.noErrorFile
                  }}</span>
                </div>
              }
            </fieldset>
          }
          @if (problem(); as p) {
            <p class="problem" role="alert">{{ p }}</p>
          }
          <footer>
            <button type="button" (click)="close()">{{ common.cancel }}</button>
            <button type="submit" class="primary" [disabled]="!canGo()">{{ t.start }}</button>
          </footer>
        </form>
      }
    </dialog>
  `,
  styles: `
    dialog {
      width: min(820px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      padding: 16px;
      overflow: auto;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 35%);
    }
    h2 {
      margin: 0 0 10px;
      font-size: 14px;
    }
    h3 {
      margin: 12px 0 4px;
      font-size: 12px;
    }
    fieldset {
      margin: 0 0 10px;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    .grid {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr) max-content minmax(0, 1fr);
      gap: 6px 12px;
      align-items: center;
      margin: 6px 0;
    }
    .line,
    .checks {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 16px;
      margin: 6px 0;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    select,
    textarea,
    input[type='text'],
    input[type='number'] {
      padding: 3px 6px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
      color: var(--text);
      font: inherit;
      min-width: 0;
    }
    textarea {
      display: block;
      width: 100%;
      box-sizing: border-box;
      margin: 4px 0;
      font-family: var(--font-mono);
      font-size: 12px;
      resize: vertical;
    }
    .path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-dim);
    }
    .dim {
      color: var(--text-dim);
    }
    p {
      margin: 6px 0;
    }
    .problem,
    .bad {
      color: var(--danger);
    }
    .headline {
      font-size: 14px;
    }
    .preview,
    .mapping {
      max-height: 170px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
    }
    table {
      border-collapse: collapse;
      font-size: 12px;
    }
    .mapping table {
      width: 100%;
    }
    th,
    td {
      padding: 2px 8px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      white-space: nowrap;
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: normal;
    }
    thead th {
      position: sticky;
      top: 0;
      background: var(--bg-panel);
      font-weight: 600;
    }
    .preview td {
      font-family: var(--font-mono);
    }
    .kind {
      margin-left: 6px;
      color: var(--text-dim);
      font-weight: normal;
    }
    td.null {
      color: var(--text-dim);
      font-style: italic;
    }
    .mapping select,
    .mapping input {
      margin-right: 6px;
    }
    .errors {
      max-height: 220px;
      margin: 0;
      padding: 0 0 0 18px;
      overflow: auto;
    }
    progress {
      width: 100%;
    }
    footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 10px;
    }
  `,
})
export class DataImportDialog {
  readonly target = input.required<ImportTarget>();
  readonly closed = output<void>();

  private readonly api = inject(DataImportApi);
  private readonly meta = inject(SchemaApi);
  private readonly files = inject(FileDialogApi);
  protected readonly importer = inject(DataImportService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly t = DATA_IMPORT_TEXTS;
  protected readonly common = COMMON_TEXTS;
  protected readonly tab = '\t';
  protected readonly formats: readonly ImportFormat[] = ['auto', 'csv', 'json', 'ndjson'];
  protected readonly encodings: readonly ImportEncoding[] = [
    'utf-8',
    'utf-16le',
    'utf-16be',
    'windows-1252',
  ];

  protected readonly job = this.importer.job;
  protected readonly path = signal<string | null>(null);
  protected readonly errorPath = signal<string | null>(null);
  protected readonly choices = signal<ImportChoices>(DEFAULT_CHOICES);
  protected readonly preview = signal<FilePreview | null>(null);
  protected readonly previewError = signal<string | null>(null);
  protected readonly schemas = signal<readonly SchemaInfo[]>([]);
  protected readonly schema = signal('');
  protected readonly tables = signal<readonly ObjectInfo[]>([]);
  protected readonly table = signal('');
  protected readonly creating = signal(false);
  protected readonly newName = signal('');
  protected readonly ddl = signal('');
  protected readonly maps = signal<readonly MapRow[]>([]);
  protected readonly targetNote = signal<{ text: string; bad: boolean } | null>(null);
  protected readonly problem = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly previewing = signal(false);
  /** Counts what was asked of the backend, so an older answer is dropped. */
  private previews = 0;
  private tableReads = 0;
  private proposals = 0;

  protected readonly fileName = computed(() => fileOf(this.path() ?? ''));
  protected readonly errorName = computed(() => fileOf(this.errorPath() ?? ''));
  protected readonly shown = computed(() => this.preview()?.rows.slice(0, PREVIEW_SHOWN) ?? []);
  protected readonly detected = computed(() => {
    const p = this.preview();
    return p ? detectedLine(p.detected) : '';
  });
  protected readonly missing = computed(() => unfilled(this.maps()));
  protected readonly canGo = computed(
    () =>
      this.path() !== null &&
      // what is on the screen belongs to the last answer: not while the file is read again
      !this.previewing() &&
      (this.preview()?.rows.length ?? 0) > 0 &&
      !this.creating() &&
      this.table() !== '' &&
      this.maps().some((m) => m.source !== 'none') &&
      !this.busy(),
  );

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
    effect(() => {
      const target = this.target();
      untracked(() => void this.loadSchemas(target));
    });
    // the start of the file, again whenever an option changes how it is read
    effect(() => {
      const path = this.path();
      const c = this.choices();
      const options = JSON.stringify([sourceOptions(c), nullTexts(c.nullTexts)]);
      untracked(() => void this.readPreview(path, options));
    });
  }

  protected reportOf = reportLine;

  private async loadSchemas(target: ImportTarget): Promise<void> {
    try {
      const all = await this.meta.schemas(target.connectionId);
      // the schema that was asked for is offered, whatever it is
      const usable = all.filter((s) => !s.system || s.name === target.schema);
      this.schemas.set(usable.length > 0 ? usable : all);
      const wanted =
        this.schemas().find((s) => s.name === target.schema) ??
        this.schemas().find((s) => s.current) ??
        this.schemas()[0];
      this.schema.set(wanted?.name ?? '');
      await this.loadTables();
      if (target.table) await this.setTable(target.table);
    } catch (e) {
      this.targetNote.set({ text: describeError(toAppError(e)), bad: true });
    }
  }

  private async loadTables(): Promise<void> {
    const schema = this.schema();
    try {
      const objects = await this.meta.objects(this.target().connectionId, schema);
      if (schema === this.schema()) this.tables.set(objects.filter((o) => o.kind === 'table'));
    } catch (e) {
      this.tables.set([]);
      this.targetNote.set({ text: describeError(toAppError(e)), bad: true });
    }
  }

  private async readPreview(path: string | null, options: string): Promise<void> {
    if (!path) return;
    const mine = ++this.previews;
    this.previewing.set(true);
    const [source, nulls] = JSON.parse(options) as [ReturnType<typeof sourceOptions>, string[]];
    try {
      const preview = await this.api.preview(path, source, nulls);
      if (mine !== this.previews) return;
      this.previewing.set(false);
      const before = this.preview();
      this.preview.set(preview);
      this.previewError.set(null);
      // other columns: map anew; the same: keep what the user chose
      const same =
        before !== null &&
        before.columns.length === preview.columns.length &&
        before.columns.every((c, i) => c === preview.columns[i]);
      this.maps.update((old) =>
        same
          ? remap(old, preview.columns.length)
          : autoMap(
              preview.columns,
              old.map((m) => m.target),
            ),
      );
      if (this.creating() && this.ddl().trim() === '') void this.propose();
    } catch (e) {
      if (mine !== this.previews) return;
      this.previewing.set(false);
      this.preview.set(null);
      this.previewError.set(this.t.previewFailed(describeError(toAppError(e))));
    }
  }

  protected async chooseFile(): Promise<void> {
    let path: string | null;
    try {
      path = await this.files.openFile(this.t.title, [
        {
          name: this.t.fileTypes,
          extensions: ['csv', 'tsv', 'txt', 'json', 'ndjson', 'jsonl', 'gz'],
        },
      ]);
    } catch {
      this.problem.set(this.t.dialogFailed);
      return;
    }
    if (!path) return;
    this.problem.set(null);
    this.path.set(path);
    if (this.newName() === '') this.newName.set(tableNameOf(path));
  }

  protected async chooseErrorFile(): Promise<void> {
    try {
      const path = await this.files.saveFile(
        this.t.errorFile,
        `${tableNameOf(this.path() ?? 'import')}.errors.tsv`,
        [{ name: 'TSV', extensions: ['tsv'] }],
      );
      if (path) this.errorPath.set(path);
    } catch {
      this.problem.set(this.t.dialogFailed);
    }
  }

  protected set(change: Partial<ImportChoices>): void {
    this.choices.update((c) => ({ ...c, ...change }));
  }

  protected setFormat(value: string): void {
    const format = this.formats.find((f) => f === value);
    if (format) this.set({ format });
  }

  protected setEncoding(value: string): void {
    this.set({ encoding: this.encodings.find((e) => e === value) ?? '' });
  }

  protected setHeader(value: string): void {
    this.set({ header: value === 'yes' || value === 'no' ? value : 'auto' });
  }

  protected setDates(value: string): void {
    this.set({ dateOrder: value === 'dmy' || value === 'mdy' ? value : '' });
  }

  protected setOnError(value: string): void {
    this.set({ onError: value === 'skip' ? 'skip' : 'abort' });
  }

  protected async setSchema(name: string): Promise<void> {
    this.schema.set(name);
    this.table.set('');
    this.maps.set([]);
    this.ddl.set('');
    await this.loadTables();
    if (this.creating()) void this.propose();
  }

  /** Chooses the table: its columns are read and mapped. */
  protected async setTable(name: string): Promise<void> {
    this.table.set(name);
    this.targetNote.set(null);
    this.maps.set([]);
    if (name === '') return;
    const mine = ++this.tableReads;
    try {
      const info = await this.meta.table(this.target().connectionId, this.schema(), name);
      if (mine !== this.tableReads) return;
      this.maps.set(autoMap(this.preview()?.columns ?? [], info.columns));
    } catch (e) {
      if (mine === this.tableReads) {
        this.targetNote.set({ text: describeError(toAppError(e)), bad: true });
      }
    }
  }

  protected startCreating(): void {
    this.creating.set(true);
    this.targetNote.set(null);
    if (this.ddl().trim() === '') void this.propose();
  }

  protected setNewName(name: string): void {
    this.newName.set(name.trim());
    void this.propose();
  }

  /** Asks the backend for a `CREATE TABLE` for the columns of the file. */
  protected async propose(): Promise<void> {
    const preview = this.preview();
    const name = this.newName();
    if (!preview || name === '') return;
    const mine = ++this.proposals;
    try {
      const sql = await this.api.tableDdl(
        this.target().connectionId,
        this.schema() || null,
        name,
        ddlColumns(preview.columns, preview.types),
      );
      if (mine === this.proposals) this.ddl.set(sql);
    } catch (e) {
      if (mine === this.proposals) {
        this.targetNote.set({ text: describeError(toAppError(e)), bad: true });
      }
    }
  }

  /** Runs the statement, then goes on with the table it made. */
  protected async createTable(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    const name = this.newName();
    try {
      const why = await this.importer.createTable(this.target().connectionId, this.ddl());
      if (why === 'declined') return;
      if (why !== null) {
        this.targetNote.set({ text: this.t.createFailed(why), bad: true });
        return;
      }
      await this.loadTables();
      this.creating.set(false);
      // the statement may have named the table otherwise: only a table that is there is chosen
      if (this.tables().some((o) => o.name === name)) await this.setTable(name);
      this.targetNote.set({ text: this.t.created(name), bad: false });
    } finally {
      this.busy.set(false);
    }
  }

  protected setSource(index: number, value: string): void {
    const source: MapRow['source'] = value === 'none' || value === 'fixed' ? value : Number(value);
    this.maps.update((all) => all.map((m, i) => (i === index ? { ...m, source } : m)));
  }

  protected setFixed(index: number, fixed: string): void {
    this.maps.update((all) => all.map((m, i) => (i === index ? { ...m, fixed } : m)));
  }

  protected async go(): Promise<void> {
    const path = this.path();
    const preview = this.preview();
    if (!this.canGo() || !path || !preview) return;
    const c = this.choices();
    const plan = planOf(this.schema() || null, this.table(), this.maps(), c);
    await this.importer.start(
      this.target().connectionId,
      path,
      runOptions(c, preview.detected),
      plan,
      c.onError === 'skip' ? this.errorPath() : null,
    );
  }

  protected close(): void {
    if (this.importer.running()) return;
    this.closed.emit();
  }
}
