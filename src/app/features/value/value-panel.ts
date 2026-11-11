import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ActionService } from '../../core/actions/action.service';
import { describeError } from '../../core/errors/app-error';
import { language } from '../../core/i18n/i18n';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { CellValuePart, ImageInfo } from '../../core/sql/query.models';
import { codePoints } from '../../core/text/places';
import { ThemeService } from '../../core/theme/theme.service';
import { EDITOR_COLORS } from '../editor/editor-colors';
import { EditliciousEditorElement, loadEditlicious } from '../editor/editlicious';
import {
  AUTO_WHOLE,
  FIRST_PART,
  HEX_BYTES,
  JsonLayout,
  MAX_IN_WINDOW,
  PART,
  ValueView,
  bytesOf,
  dateForms,
  drawable,
  hexDump,
  languageOf,
  layoutXml,
  numberForms,
  sizeText,
  viewsOf,
} from './value-logic';
import { ActiveCell, ValueService } from './value.service';
import { VALUE_TEXTS } from './value-texts';

/** A cell must stay the cursor's for this long before its value is asked for. */
const FOLLOW_MS = 120;
/** Characters of JSON laid out in one go, before the window gets a turn. */
const LAYOUT_STEP = 400_000;

/** What is known of the value on screen. */
interface Loaded {
  readonly cell: ActiveCell;
  readonly kind: CellValuePart['kind'];
  /** Bytes of the whole value. */
  readonly total: number;
  /** Bytes that are here. */
  readonly have: number;
  readonly text: string;
  readonly bytes: Uint8Array | null;
  readonly image: ImageInfo | null;
}

/**
 * The value of the cell the cursor is on, whole (prompt 026): long text, JSON and XML laid out, binary
 * data as hex or as a picture, a number in other bases, an instant in other zones. Follows the cursor with
 * a short delay; an answer for a cell the cursor has left is dropped. The text lives in a read-only
 * `<editlicious-editor>`. Nothing of a value is ever put into the page as markup; a picture is raster data
 * behind a `blob:` address.
 */
@Component({
  selector: 'app-value-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  host: { role: 'region', '[attr.aria-label]': 't.panel' },
  template: `
    @if (loaded(); as v) {
      <header>
        <strong class="column">{{ v.cell.column.name }}</strong>
        <span class="facts">{{ v.cell.column.typeName }}</span>
        <span class="facts">{{ facts() }}</span>
      </header>
      <div class="tools">
        @if (views().length > 1) {
          <select [attr.aria-label]="t.view" (change)="chosen.set($any($event.target).value)">
            @for (view of views(); track view) {
              <option [value]="view" [selected]="view === view$()">{{ t.views[view] }}</option>
            }
          </select>
        }
        <!-- hex lines are sixteen bytes each: they are never wrapped -->
        @if (showsText() && view$() !== 'hex') {
          <label class="wrap">
            <input
              type="checkbox"
              [checked]="settings.settings().valueWrap"
              (change)="settings.update({ valueWrap: $any($event.target).checked })"
            />
            {{ t.wrap }}
          </label>
        }
        <span class="spacer"></span>
        <button
          type="button"
          [disabled]="v.kind === 'null'"
          (click)="actions.run('COPY_CELL_VALUE')"
        >
          {{ t.copy }}
        </button>
        <button
          type="button"
          [disabled]="v.kind === 'null'"
          (click)="actions.run('SAVE_CELL_VALUE')"
        >
          {{ t.save }}
        </button>
      </div>
      @if (note(); as n) {
        <p class="note" role="status">
          {{ n }}
          @if (canLoadWhole()) {
            <button type="button" (click)="loadWhole()">{{ t.loadWhole(size(v.total)) }}</button>
          }
        </p>
      }
    }
    @if (problem(); as p) {
      <p class="note problem" role="alert">{{ p }}</p>
    } @else if (!loaded()) {
      <p class="note">{{ cell() ? t.reading : t.none }}</p>
    } @else if (loaded()!.kind === 'null') {
      <p class="note">{{ t.nullValue }}</p>
    } @else if (loaded()!.kind === 'unreadable') {
      <p class="note">{{ t.unreadable(loaded()!.text) }}</p>
    } @else if (view$() === 'image' && imageUrl()) {
      <div class="picture">
        <img
          [src]="imageUrl()"
          [alt]="t.imageAlt(loaded()!.cell.column.name)"
          (error)="imageFailed.set(true)"
        />
      </div>
    } @else if (view$() === 'number' || view$() === 'date') {
      <dl class="forms">
        @for (row of forms(); track row[0]) {
          <dt>{{ row[0] }}</dt>
          <dd>{{ row[1] }}</dd>
        }
      </dl>
    }
    <!-- the editor stays in the page: another value is another text, not another editor -->
    @if (editorReady()) {
      <editlicious-editor
        #editor
        readonly
        scheme="none"
        line-numbers="off"
        [class.hidden]="!showsText() || !loaded() || !!problem()"
        [attr.color-scheme]="dark() ? 'dark' : 'light'"
        [style]="colors"
        [attr.aria-label]="t.panel"
        [attr.language]="editorLanguage() || null"
        [attr.ui-language]="uiLanguage()"
        [attr.font-family]="settings.settings().editorFontFamily || null"
        [attr.font-size]="settings.settings().resultFontSize + 1"
        [attr.word-wrap]="settings.settings().valueWrap && view$() !== 'hex' ? '' : null"
      />
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      height: 100%;
      border-left: 1px solid var(--border);
      background: var(--bg-app);
    }
    header,
    .tools {
      flex: none;
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 4px 8px;
      min-width: 0;
    }
    .tools {
      align-items: center;
      border-bottom: 1px solid var(--border);
    }
    .column {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .facts {
      color: var(--text-dim);
      font-size: 12px;
      white-space: nowrap;
    }
    .wrap {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      white-space: nowrap;
    }
    .spacer {
      flex: 1 1 0;
    }
    .note {
      flex: none;
      margin: 0;
      padding: 6px 8px;
      color: var(--text-dim);
      font-size: 12px;
    }
    .note button {
      margin-left: 6px;
    }
    .problem {
      color: var(--error-fg);
    }
    editlicious-editor {
      flex: 1 1 0;
      min-height: 0;
    }
    editlicious-editor.hidden {
      display: none;
    }
    .picture {
      flex: 1 1 0;
      min-height: 0;
      overflow: auto;
      padding: 8px;
    }
    img {
      max-width: 100%;
      height: auto;
      image-rendering: auto;
      background: var(--bg-hover);
    }
    .forms {
      flex: none;
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: 4px 12px;
      margin: 0;
      padding: 8px;
    }
    dt {
      color: var(--text-dim);
      font-size: 12px;
    }
    dd {
      margin: 0;
      font-family: var(--font-mono);
      font-size: 13px;
      overflow-wrap: anywhere;
    }
  `,
})
export class ValuePanel {
  protected readonly t = VALUE_TEXTS;
  protected readonly settings = inject(SettingsService);
  protected readonly actions = inject(ActionService);
  private readonly api = inject(QueryApi);
  private readonly service = inject(ValueService);
  private readonly theme = inject(ThemeService);
  protected readonly colors = EDITOR_COLORS;
  protected readonly uiLanguage = language;
  protected readonly size = sizeText;
  protected readonly dark = computed(() => this.theme.applied()?.dark ?? this.theme.systemDark());

  /** The cell to show; `null` = none. */
  readonly cell = input<ActiveCell | null>(null);

  protected readonly loaded = signal<Loaded | null>(null);
  protected readonly problem = signal<string | null>(null);
  /** The view the user chose for this value; `null` = the one the value suggests. */
  protected readonly chosen = signal<ValueView | null>(null);
  /** Reading or laying out, in per cent; `null` = neither. */
  private readonly reading = signal<number | null>(null);
  private readonly layingOut = signal<number | null>(null);
  protected readonly imageUrl = signal<string | null>(null);
  protected readonly imageFailed = signal(false);
  protected readonly editorReady = signal(false);
  /** The text the editor holds (for tests and for „copy“ of binary data). */
  readonly shown = signal('');
  private readonly editor = viewChild<ElementRef<EditliciousEditorElement>>('editor');
  /** Counts the cells shown: an answer for an older one is dropped. */
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private layoutRun = 0;

  protected readonly views = computed<ValueView[]>(() => {
    const v = this.loaded();
    if (!v) return ['text'];
    const views = viewsOf({
      kind: v.kind,
      column: v.cell.column.kind,
      start: v.text.slice(0, 2000),
      total: v.total,
      image: this.imageFailed() ? null : v.image,
    });
    return views;
  });
  protected readonly view$ = computed<ValueView>(() => {
    const chosen = this.chosen();
    const views = this.views();
    return chosen && views.includes(chosen) ? chosen : views[0];
  });
  protected readonly showsText = computed(() => {
    const v = this.loaded();
    if (!v || v.kind === 'null' || v.kind === 'unreadable') return false;
    const view = this.view$();
    return view === 'text' || view === 'json' || view === 'xml' || view === 'hex';
  });
  protected readonly editorLanguage = computed(() => languageOf(this.view$()));
  protected readonly whole = computed(() => {
    const v = this.loaded();
    return !!v && v.have >= v.total;
  });
  protected readonly canLoadWhole = computed(() => {
    const v = this.loaded();
    return !!v && !this.whole() && this.reading() === null && v.total <= MAX_IN_WINDOW;
  });

  /** Type and size: characters once the whole text is here, bytes always. */
  protected readonly facts = computed(() => {
    const v = this.loaded();
    if (!v) return '';
    if (v.kind === 'bytes') {
      const image = this.imageFailed() ? null : v.image;
      const picture = image ? ` · ${this.t.image(image.mime, image.width, image.height)}` : '';
      return this.t.bytes(sizeText(v.total)) + picture;
    }
    if (v.kind !== 'text') return '';
    return this.whole()
      ? this.t.textSize(codePoints(v.text).toLocaleString(language()), sizeText(v.total))
      : this.t.textSizeOpen(sizeText(v.total));
  });

  /** What stands above the value: progress, or that only a part is shown. */
  protected readonly note = computed(() => {
    const v = this.loaded();
    if (!v) return null;
    const reading = this.reading();
    if (reading !== null) return this.t.loading(reading);
    const layingOut = this.layingOut();
    if (layingOut !== null) return this.t.layingOut(layingOut);
    if (this.imageFailed() && v.image) return this.t.imageBroken;
    if (v.kind === 'bytes' && this.view$() === 'hex' && v.total > HEX_BYTES) {
      return this.t.hexPartial(sizeText(Math.min(v.have, HEX_BYTES)), sizeText(v.total));
    }
    if (v.kind === 'text' && !this.whole()) {
      return v.total > MAX_IN_WINDOW
        ? this.t.tooLarge(sizeText(v.total))
        : this.t.partial(sizeText(v.have), sizeText(v.total));
    }
    return null;
  });

  /** The lines of the number and the date view. */
  protected readonly forms = computed<[string, string][]>(() => {
    const v = this.loaded();
    if (!v) return [];
    if (this.view$() === 'number') {
      const n = numberForms(v.text);
      return n
        ? [
            [this.t.decimal, n.decimal],
            [this.t.hex, n.hex],
            [this.t.binary, n.binary],
          ]
        : [];
    }
    const d = dateForms(v.text, v.cell.column.kind);
    if (!d) return [];
    const rows: [string, string][] = [[this.t.weekday, this.t.days[d.weekday]]];
    if (d.utc && d.local && d.epoch) {
      rows.push([this.t.utc, d.utc], [this.t.local, d.local], [this.t.epoch, d.epoch]);
    } else {
      rows.push(['', this.t.noZone]);
    }
    return rows;
  });

  constructor() {
    loadEditlicious().then(
      () => this.editorReady.set(true),
      () => undefined,
    );
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
      if (this.timer) clearTimeout(this.timer);
      this.release();
      this.service.shownBinary.set(null);
    });
    // follow the cursor – after a breath, so that running through cells asks for none of them
    effect(() => {
      const cell = this.cell();
      untracked(() => this.follow(cell));
    });
    // what the editor shows follows the value and the view
    effect(() => {
      const v = this.loaded();
      const view = this.view$();
      const failed = this.imageFailed();
      untracked(() => void this.render(v, view, failed));
    });
    effect(() => {
      const editor = this.editor()?.nativeElement;
      const text = this.shown();
      if (editor) void editor.setValue(text);
    });
  }

  private follow(cell: ActiveCell | null): void {
    const mine = ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    this.reading.set(null);
    if (!cell) {
      this.loaded.set(null);
      this.problem.set(null);
      return;
    }
    this.timer = setTimeout(() => void this.load(cell, mine), FOLLOW_MS);
  }

  private async load(cell: ActiveCell, mine: number): Promise<void> {
    try {
      const first = await this.api.cellValue(cell.resultId, cell.row, cell.col, 0, FIRST_PART);
      // the cursor moved on while this was on its way
      if (mine !== this.generation) return;
      this.chosen.set(null);
      this.imageFailed.set(false);
      this.problem.set(null);
      this.loaded.set({
        cell,
        kind: first.kind,
        total: first.total,
        have: first.to,
        text: first.text ?? '',
        bytes: first.base64 !== undefined ? bytesOf(first.base64) : null,
        image: first.image ?? null,
      });
      const picture = first.kind === 'bytes' && drawable(first.image ?? null, first.total);
      if (first.to < first.total && (first.total <= AUTO_WHOLE || picture)) {
        await this.readRest(mine);
      }
    } catch (e) {
      if (mine !== this.generation) return;
      this.loaded.set(null);
      this.problem.set(describeError(e));
    }
  }

  /** Reads the rest of the value on screen, piece by piece. */
  private async readRest(mine: number): Promise<void> {
    let v = this.loaded();
    if (!v) return;
    const { cell } = v;
    const texts = [v.text];
    const chunks: Uint8Array[] = v.bytes ? [v.bytes] : [];
    let have = v.have;
    this.reading.set(Math.floor((have / v.total) * 100));
    try {
      while (have < v.total) {
        const part = await this.api.cellValue(cell.resultId, cell.row, cell.col, have, PART);
        if (mine !== this.generation) return;
        if (part.to <= have) break;
        if (part.text !== undefined) texts.push(part.text);
        if (part.base64 !== undefined) chunks.push(bytesOf(part.base64));
        have = part.to;
        this.reading.set(Math.floor((have / v.total) * 100));
      }
      let bytes: Uint8Array | null = null;
      if (chunks.length > 0) {
        bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) {
          bytes.set(c, at);
          at += c.length;
        }
      }
      v = { ...v, have, text: texts.join(''), bytes };
      this.loaded.set(v);
    } catch (e) {
      if (mine === this.generation) this.problem.set(describeError(e));
    } finally {
      if (mine === this.generation) this.reading.set(null);
    }
  }

  protected loadWhole(): void {
    void this.readRest(this.generation);
  }

  private release(): void {
    const url = this.imageUrl();
    if (url) URL.revokeObjectURL(url);
    this.imageUrl.set(null);
  }

  /** Puts the value into the editor (or behind the picture) the way the view wants it. */
  private async render(v: Loaded | null, view: ValueView, failed: boolean): Promise<void> {
    const run = ++this.layoutRun;
    this.layingOut.set(null);
    this.release();
    this.service.shownBinary.set(null);
    if (!v || v.kind === 'null' || v.kind === 'unreadable') {
      this.shown.set('');
      return;
    }
    if (v.kind === 'bytes') {
      const bytes = v.bytes ?? new Uint8Array();
      const dump = hexDump(bytes.subarray(0, HEX_BYTES));
      this.service.shownBinary.set(dump);
      if (view === 'image' && !failed && v.image && v.have >= v.total) {
        // raster data behind a blob: address – the type is the one the header named, nothing else
        const copy = new Uint8Array(bytes);
        this.imageUrl.set(URL.createObjectURL(new Blob([copy], { type: v.image.mime })));
      }
      this.shown.set(dump);
      return;
    }
    if (view === 'xml') {
      this.shown.set(layoutXml(v.text));
      return;
    }
    if (view !== 'json') {
      this.shown.set(v.text);
      return;
    }
    // JSON: in steps, so a large value does not hold the window
    const layout = new JsonLayout(v.text);
    while (!layout.done) {
      layout.step(LAYOUT_STEP);
      if (layout.done) break;
      this.layingOut.set(Math.floor(layout.progress * 100));
      await new Promise((resolve) => setTimeout(resolve));
      // another value or view took over meanwhile
      if (run !== this.layoutRun) return;
    }
    this.layingOut.set(null);
    this.shown.set(layout.result());
  }
}
