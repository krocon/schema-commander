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
import { ExportApi, ExportFormat } from '../../core/backend/export-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { COMMON_TEXTS } from '../../core/i18n/common-texts';
import { SettingsService } from '../../core/settings/settings.service';
import {
  EXPORT_FORMATS,
  ExportChoices,
  fileName,
  formatHas,
  isExportFormat,
  mergeChoices,
  specOf,
} from './export-logic';
import { ExportService, ExportSource } from './export.service';
import { EXPORT_TEXTS } from './export-texts';

/**
 * What to write and how (prompt 011): format, its options, the columns, a look at the first lines. The
 * target comes from the save dialog of the OS, then the job starts and this dialog closes.
 */
@Component({
  selector: 'app-export-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      aria-labelledby="export-title"
      (cancel)="$event.preventDefault(); closed.emit()"
    >
      <form (submit)="$event.preventDefault(); go()">
        <h2 id="export-title">{{ t.title }}</h2>
        <p class="what">{{ what() }}</p>
        <div class="grid">
          <label for="export-format">{{ t.format }}</label>
          <select #fmt id="export-format" (change)="setFormat(fmt.value)">
            @for (f of formats; track f.id) {
              <option [value]="f.id" [selected]="f.id === format()">{{ f.label }}</option>
            }
          </select>
          @if (has().delimiter) {
            <label for="export-delimiter">{{ t.delimiter }}</label>
            <select #del id="export-delimiter" (change)="set({ delimiter: del.value })">
              <option value="," [selected]="choices().delimiter === ','">{{ t.comma }}</option>
              <option value=";" [selected]="choices().delimiter === ';'">{{ t.semicolon }}</option>
              <option value="&#9;" [selected]="choices().delimiter === tab">{{ t.tab }}</option>
              <option value="|" [selected]="choices().delimiter === '|'">{{ t.pipe }}</option>
            </select>
          }
          @if (has().nullAs) {
            <label for="export-null">{{ t.nullAs }}</label>
            <select #nul id="export-null" (change)="set({ nullAs: nul.value })">
              <option value="" [selected]="choices().nullAs === ''">{{ t.empty }}</option>
              <option value="NULL" [selected]="choices().nullAs === 'NULL'">NULL</option>
              <option value="\\N" [selected]="choices().nullAs === '\\\\N'">\\N</option>
            </select>
          }
          @if (has().insert) {
            <label for="export-batch">{{ t.rowsPerInsert }}</label>
            <input
              #batch
              id="export-batch"
              type="number"
              min="1"
              max="10000"
              [value]="choices().batch"
              (change)="set({ batch: +batch.value })"
            />
            <label for="export-table">{{ t.table }}</label>
            <input
              #tab
              id="export-table"
              type="text"
              spellcheck="false"
              [value]="table()"
              (input)="table.set(tab.value)"
            />
          }
        </div>
        <div class="checks">
          @if (has().header) {
            <label>
              <input
                #hd
                type="checkbox"
                [checked]="choices().header"
                (change)="set({ header: hd.checked })"
              />
              {{ t.header }}
            </label>
          }
          @if (has().delimiter) {
            <label>
              <input
                #cr
                type="checkbox"
                [checked]="choices().crlf"
                (change)="set({ crlf: cr.checked })"
              />
              {{ t.crlf }}
            </label>
          }
          @if (format() === 'csv' || format() === 'tsv') {
            <label>
              <input
                #bm
                type="checkbox"
                [checked]="choices().bom"
                (change)="set({ bom: bm.checked })"
              />
              {{ t.bom }}
            </label>
          }
          @if (has().text) {
            <label>
              <input
                #gz
                type="checkbox"
                [checked]="choices().gzip"
                (change)="set({ gzip: gz.checked })"
              />
              {{ t.gzip }}
            </label>
          }
          @if (source().kind === 'result') {
            <label>
              <input #re type="checkbox" [checked]="rerun()" (change)="rerun.set(re.checked)" />
              {{ t.rerun }}
            </label>
          }
        </div>
        @if (columns().length > 0) {
          <fieldset>
            <legend>
              {{ t.columns }}
              <button type="button" class="link" (click)="allColumns(true)">{{ t.all }}</button>
              <button type="button" class="link" (click)="allColumns(false)">{{ t.none }}</button>
            </legend>
            <div class="columns">
              @for (c of columns(); track $index) {
                <label>
                  <input
                    type="checkbox"
                    [checked]="picked().has($index)"
                    (change)="toggleColumn($index)"
                  />
                  {{ c.name }}
                </label>
              }
            </div>
          </fieldset>
          <label class="preview-label" for="export-preview">{{ t.preview }}</label>
          <pre id="export-preview" class="preview" tabindex="0">{{ preview() }}</pre>
        }
        @if (problem(); as p) {
          <p class="problem" role="alert">{{ p }}</p>
        }
        <footer>
          <button type="button" (click)="closed.emit()">{{ common.cancel }}</button>
          <button type="submit" class="primary" [disabled]="!canGo()">{{ t.saveAs }}</button>
        </footer>
      </form>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(620px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      padding: 16px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 35%);
    }
    h2 {
      margin: 0 0 4px;
      font-size: 14px;
    }
    .what {
      margin: 0 0 12px;
      color: var(--text-dim);
    }
    .grid {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 6px 12px;
      align-items: center;
    }
    select,
    input[type='text'],
    input[type='number'] {
      padding: 3px 6px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
      color: var(--text);
      font: inherit;
    }
    .checks {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 16px;
      margin: 12px 0;
    }
    .checks label,
    .columns label {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    fieldset {
      margin: 0 0 10px;
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    .columns {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 14px;
      max-height: 96px;
      overflow: auto;
    }
    .link {
      border: 0;
      padding: 0 4px;
      background: transparent;
      color: var(--accent);
      font: inherit;
    }
    .preview-label {
      display: block;
      margin-bottom: 4px;
      color: var(--text-dim);
      font-size: 12px;
    }
    .preview {
      margin: 0 0 12px;
      padding: 6px 8px;
      max-height: 130px;
      overflow: auto;
      background: var(--bg-app);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-family: var(--font-mono);
      font-size: 12px;
      white-space: pre;
    }
    .problem {
      margin: 0 0 10px;
      color: var(--danger);
    }
    footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
  `,
})
export class ExportDialog {
  readonly source = input.required<ExportSource>();
  readonly closed = output<void>();

  private readonly api = inject(ExportApi);
  private readonly files = inject(FileDialogApi);
  private readonly exporter = inject(ExportService);
  private readonly settings = inject(SettingsService);
  private readonly connections = inject(ConnectionsStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly t = EXPORT_TEXTS;
  protected readonly common = COMMON_TEXTS;
  protected readonly formats = EXPORT_FORMATS;
  protected readonly tab = '\t';
  protected readonly format = signal<ExportFormat>('csv');
  protected readonly choices = signal<ExportChoices>(mergeChoices(undefined));
  protected readonly has = computed(() => formatHas(this.format()));
  protected readonly rerun = signal(false);
  protected readonly table = signal('');
  protected readonly picked = signal<ReadonlySet<number>>(new Set());
  protected readonly preview = signal('');
  protected readonly problem = signal<string | null>(null);
  /** Counts the previews asked for, so an older answer is dropped. */
  private previews = 0;

  protected readonly columns = computed(() => {
    const source = this.source();
    return source.kind === 'result' ? source.columns : [];
  });
  protected readonly what = computed(() => {
    const source = this.source();
    if (source.kind === 'query') return this.t.whatQuery(source.name);
    return source.ranges.length > 0
      ? this.t.whatSelected(source.name)
      : this.t.whatRows(source.name, source.rows);
  });
  protected readonly canGo = computed(() => this.columns().length === 0 || this.picked().size > 0);

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
    effect(() => {
      const source = this.source();
      untracked(() => {
        const s = this.settings.settings();
        const last = s.lastExportFormat;
        this.format.set(isExportFormat(last) ? last : 'csv');
        this.choices.set(mergeChoices(s.exportChoices[this.format()]));
        this.table.set(source.table);
        this.picked.set(new Set(source.kind === 'result' ? source.columns.map((_, i) => i) : []));
      });
    });
    effect(() => {
      const spec = this.spec();
      const source = this.source();
      untracked(() => void this.showPreview(source, spec));
    });
  }

  private readonly spec = computed(() => {
    const source = this.source();
    const all = this.columns().length;
    const picked = [...this.picked()].sort((a, b) => a - b);
    return specOf(
      this.format(),
      this.choices(),
      // every column: say nothing, so a statement run again may have others
      picked.length === all ? [] : picked,
      this.table().trim() || this.t.defaultTable,
      this.connections.profiles().find((p) => p.id === source.connectionId)?.kind ?? 'sqlite',
    );
  });

  private async showPreview(source: ExportSource, spec: ReturnType<typeof specOf>): Promise<void> {
    if (source.kind !== 'result') return;
    const mine = ++this.previews;
    try {
      const text = await this.api.preview(source.resultId, spec);
      if (mine === this.previews) this.preview.set(text);
    } catch {
      if (mine === this.previews) this.preview.set('');
    }
  }

  protected setFormat(id: string): void {
    if (!isExportFormat(id)) return;
    this.format.set(id);
    this.choices.set(mergeChoices(this.settings.settings().exportChoices[id]));
  }

  protected set(change: Partial<ExportChoices>): void {
    this.choices.update((c) => mergeChoices({ ...c, ...change }));
  }

  protected toggleColumn(index: number): void {
    this.picked.update((old) => {
      const next = new Set(old);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  }

  protected allColumns(on: boolean): void {
    this.picked.set(new Set(on ? this.columns().map((_, i) => i) : []));
  }

  /** Asks for the target, then starts the job. */
  protected async go(): Promise<void> {
    if (!this.canGo()) return;
    const source = this.source();
    const format = this.format();
    const spec = this.spec();
    const label = EXPORT_FORMATS.find((f) => f.id === format);
    const extension = spec.gzip ? 'gz' : (label?.extension ?? 'txt');
    let path: string | null;
    try {
      path = await this.files.saveFile(this.t.title, fileName(source.name, format, spec.gzip), [
        { name: label?.label ?? format, extensions: [extension] },
      ]);
    } catch {
      this.problem.set(this.t.saveDialogFailed);
      return;
    }
    if (!path) return;
    const s = this.settings.settings();
    this.settings.update({
      lastExportFormat: format,
      exportChoices: { ...s.exportChoices, [format]: this.choices() },
    });
    this.closed.emit();
    void this.exporter.start(source, path, spec, this.rerun());
  }
}
