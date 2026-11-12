import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { ResultRef } from '../../core/sql/query.models';
import { DEFAULT_SETTINGS } from '../../core/settings/settings.models';
import { SettingsService } from '../../core/settings/settings.service';
import { SplitterComponent } from '../../shared/splitter';
import { EdChange } from '../editor/editlicious';
import { SqlEditor } from '../editor/sql-editor';
import { Dialect } from '../editor/sql-split';
import { ResultGrid } from '../results/result-grid';
import { QueryTab, TabEditor } from './query-tab';
import { StatementRun, clock, outcomeText, statusText } from './run-state';
import { ObjectDetailsService } from '../details/details.service';
import { CopyService } from '../results/copy.service';
import { errorObjectText, errorReport } from './run-state';
import { TabsStore } from './tabs.store';
import { FilterBar } from '../filter/filter-bar';
import { EditBar } from '../edit/edit-bar';
import { EditService } from '../edit/edit.service';
import { FindBar } from '../find/find-bar';
import { RelationPath } from '../relations/relation-path';
import { RelationsService } from '../relations/relations.service';
import { ColumnLayout } from '../results/column-layout';
import { ColumnLayouts } from '../results/column-layouts.service';
import { sortMarks, toggleLocalSort, toggleServerOrder } from '../filter/filter-logic';
import { PARAM_TEXTS } from '../params/param-texts';
import { ValuePanel } from '../value/value-panel';
import { RowForm } from '../row-form/row-form';
import { ActiveCell, ValueService } from '../value/value.service';
import { VALUE_TEXTS } from '../value/value-texts';
import { TABS_TEXTS } from './tabs-texts';

const RESULT_MIN = 80;
/** What the editor keeps at least, px. */
const EDITOR_MIN = 120;
const RESULT_MIN_W = 160;
const EDITOR_MIN_W = 160;

/**
 * The content of one query tab (prompt 004): its editor above, its result below, a splitter between. Every
 * shown tab keeps its pane – and with it undo history, caret and scroll position – while another is in front.
 */
@Component({
  selector: 'app-query-pane',
  imports: [
    EditBar,
    FilterBar,
    FindBar,
    RelationPath,
    ResultGrid,
    SplitterComponent,
    SqlEditor,
    ValuePanel,
    RowForm,
  ],
  host: {
    '[class.side]': 'side()',
    '[class.no-result]': '!settings.settings().resultVisible && !maximized()',
    '[class.max-result]': 'maximized()',
    role: 'tabpanel',
    '[attr.aria-labelledby]': '"tab-" + tab().id',
    '[id]': '"pane-" + tab().id',
  },
  template: `
    @if (startText(); as start) {
      <app-sql-editor
        class="editor"
        [initialValue]="start.text"
        [label]="t.editorLabel(tab().title())"
        [dialect]="dialect()"
        [connectionId]="tab().connectionId()"
        (run)="tab().runAll($event)"
        (caret)="tab().caret.set($event)"
        (seededText)="onSeeded()"
        (changed)="onChanged($event)"
      />
    } @else {
      <p class="editor message">{{ t.loadingText }}</p>
    }
    @if (side()) {
      <app-splitter
        orientation="vertical"
        pane="after"
        [label]="t.resultWidth"
        [controls]="'results-' + tab().id"
        [size]="resultW()"
        [min]="resultMinW"
        [max]="resultMaxW()"
        [defaultSize]="defaults.resultWidth"
        (sizeChange)="dragWidth.set($event)"
        (sizeCommit)="commitWidth($event)"
      />
    } @else {
      <app-splitter
        orientation="horizontal"
        pane="after"
        [label]="t.resultHeight"
        [controls]="'results-' + tab().id"
        [size]="resultH()"
        [min]="resultMin"
        [max]="resultMaxH()"
        [defaultSize]="defaults.resultHeight"
        (sizeChange)="dragHeight.set($event)"
        (sizeCommit)="commitHeight($event)"
      />
    }
    <section
      class="results"
      [attr.aria-label]="t.result"
      tabindex="-1"
      [id]="'results-' + tab().id"
      [style.height.px]="maximized() || side() ? null : resultH()"
      [style.width.px]="maximized() || !side() ? null : resultW()"
    >
      @if (tab().runs().length > 1 || tab().log().length > 0) {
        <div class="subtabs" role="tablist" [attr.aria-label]="t.results">
          @for (run of tab().runs(); track $index) {
            @if (tab().runs().length > 1) {
              <button
                type="button"
                role="tab"
                [class]="'sub ' + run.kind"
                [attr.aria-selected]="tab().shown() === $index"
                [tabindex]="tab().shown() === $index ? 0 : -1"
                [title]="run.sql"
                (click)="tab().shown.set($index)"
                (keydown)="onSubKey($event)"
              >
                <span class="mark" aria-hidden="true">{{ mark(run) }}</span>
                {{ $index + 1 }}
                <span class="sr">{{ outcome(run) }}</span>
              </button>
            }
          }
          <button
            type="button"
            role="tab"
            class="sub"
            [attr.aria-selected]="tab().shown() === 'messages'"
            [tabindex]="tab().shown() === 'messages' ? 0 : -1"
            (click)="tab().shown.set('messages')"
            (keydown)="onSubKey($event)"
          >
            {{ t.messages }}
          </button>
        </div>
      }
      @if (filterBar()) {
        <app-filter-bar
          [tab]="tab()"
          [columns]="result()?.columns ?? []"
          [total]="baseRows()"
          [local]="settings.settings().filterBarVisible"
        />
      }
      @if (pathShown()) {
        <app-relation-path [tab]="tab()" />
      }
      @if (tab().tableView() && tab().shown() !== 'messages') {
        <app-edit-bar [tab]="tab()" />
      }
      @if (tab().find.open() && filterBar()) {
        <app-find-bar
          [find]="tab().find"
          [resultId]="result()?.resultId ?? null"
          [rows]="rows()"
          [columns]="result()?.columns ?? []"
          [cursor]="cursor"
          (go)="grid()?.goTo($event[0], $event[1])"
          (goRow)="grid()?.goTo($event, null); grid()?.focusGrid()"
          (closed)="grid()?.focusGrid()"
        />
      }
      <div class="body" role="tabpanel">
        @if (tab().shown() === 'messages') {
          <ol class="log" [attr.aria-label]="t.messages">
            @for (entry of tab().log(); track $index) {
              <li [class]="entry.kind">
                <time>{{ time(entry.at) }}</time>
                <code>{{ entry.sql }}</code>
                <span class="text">{{ entry.text }}</span>
                @if (entry.values) {
                  <span class="values">{{ params.with(entry.values) }}</span>
                }
                @if (entry.elapsedMs !== null) {
                  <span class="ms">{{ entry.elapsedMs }} ms</span>
                }
              </li>
            } @empty {
              <li class="info">{{ t.noMessages }}</li>
            }
          </ol>
        } @else {
          @switch (state().kind) {
            @case ('done') {
              @if (result(); as r) {
                <div class="with-value">
                  <app-result-grid
                    [result]="r"
                    [rows]="rows()"
                    [fetch]="fetch"
                    [marks]="marks()"
                    [layout]="layout()"
                    [hits]="hits()"
                    [links]="links()"
                    [edits]="edits()"
                    (editCell)="edit.begin(tab())"
                    (pasted)="edit.paste(tab(), $event)"
                    (follow)="relations.follow(tab(), 'here')"
                    (layoutChange)="setLayout($event)"
                    (active)="onActive(r, $event)"
                    (headClick)="onHeadClick(r, $event)"
                  />
                  @if (beside() !== 'none') {
                    <app-splitter
                      orientation="vertical"
                      pane="after"
                      [label]="value.width"
                      [size]="valueW()"
                      [min]="valueMinW"
                      [max]="valueMaxW"
                      [defaultSize]="defaults.valuePanelWidth"
                      (sizeChange)="dragValue.set($event)"
                      (sizeCommit)="commitValue($event)"
                    />
                    @if (beside() === 'form') {
                      <app-row-form
                        [style.width.px]="valueW()"
                        [cell]="activeCell()"
                        [result]="r"
                        [rows]="rows()"
                        [tab]="tab()"
                        [edits]="edits()"
                      />
                    } @else {
                      <app-value-panel [style.width.px]="valueW()" [cell]="activeCell()" />
                    }
                  }
                </div>
              } @else {
                <p class="message">{{ status() }}</p>
              }
            }
            @case ('failed') {
              <!-- the message of the server in full, its parts apart (prompt 022) -->
              <div class="failure" role="alert">
                <p class="what">{{ errorMessage() }}</p>
                @if (errorDetails(); as d) {
                  <dl>
                    @if (d.sqlstate) {
                      <dt>{{ t.errorCode }}</dt>
                      <dd>{{ d.sqlstate }}</dd>
                    }
                    @if (d.detail) {
                      <dt>{{ t.errorDetail }}</dt>
                      <dd>{{ d.detail }}</dd>
                    }
                    @if (d.hint) {
                      <dt>{{ t.errorHint }}</dt>
                      <dd>{{ d.hint }}</dd>
                    }
                    @if (d.context) {
                      <dt>{{ t.errorContext }}</dt>
                      <dd>{{ d.context }}</dd>
                    }
                    @if (errorObject(); as o) {
                      <dt>{{ t.errorObject }}</dt>
                      <dd>{{ o }}</dd>
                    }
                  </dl>
                }
                <p class="acts">
                  <button type="button" (click)="tab().goToError()">{{ t.errorGoTo }}</button>
                  <button type="button" (click)="copyError()">{{ t.errorCopy }}</button>
                  @if (errorDetails()?.table; as table) {
                    <button type="button" (click)="showErrorTable()">
                      {{ t.errorShowTable(table) }}
                    </button>
                  }
                </p>
              </div>
            }
            @case ('running') {
              <!-- rows are shown as soon as there are some, while the rest is still read -->
              @if (result(); as r) {
                <div class="with-value">
                  <app-result-grid
                    [result]="r"
                    [rows]="rows()"
                    [fetch]="fetch"
                    [marks]="marks()"
                    [layout]="layout()"
                    [hits]="hits()"
                    [links]="links()"
                    [edits]="edits()"
                    (editCell)="edit.begin(tab())"
                    (pasted)="edit.paste(tab(), $event)"
                    (follow)="relations.follow(tab(), 'here')"
                    (layoutChange)="setLayout($event)"
                    (active)="onActive(r, $event)"
                    (headClick)="onHeadClick(r, $event)"
                  />
                  @if (beside() !== 'none') {
                    <app-splitter
                      orientation="vertical"
                      pane="after"
                      [label]="value.width"
                      [size]="valueW()"
                      [min]="valueMinW"
                      [max]="valueMaxW"
                      [defaultSize]="defaults.valuePanelWidth"
                      (sizeChange)="dragValue.set($event)"
                      (sizeCommit)="commitValue($event)"
                    />
                    @if (beside() === 'form') {
                      <app-row-form
                        [style.width.px]="valueW()"
                        [cell]="activeCell()"
                        [result]="r"
                        [rows]="rows()"
                        [tab]="tab()"
                        [edits]="edits()"
                      />
                    } @else {
                      <app-value-panel [style.width.px]="valueW()" [cell]="activeCell()" />
                    }
                  }
                </div>
              } @else {
                <p class="message">{{ t.runningNow }}</p>
              }
            }
            @case ('cancelled') {
              <p class="message">{{ t.cancelledNow }}</p>
            }
            @default {
              <p class="message">{{ t.noResult }}</p>
            }
          }
        }
      </div>
    </section>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
    }
    /* the result beside the editor, hidden, or alone (prompt 016) */
    :host(.side) {
      flex-direction: row;
    }
    :host(.no-result) .results,
    :host(.no-result) app-splitter,
    :host(.max-result) .editor,
    :host(.max-result) app-splitter {
      display: none;
    }
    :host(.max-result) .results {
      flex: 1 1 0;
    }
    .editor {
      flex: 1 1 0;
      min-width: 0;
      min-height: 0;
    }
    .results {
      flex: none;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      background: var(--bg-app);
    }
    .body {
      flex: 1 1 0;
      min-height: 0;
      overflow: auto;
    }
    /* the grid and, beside it, the value of the cell the cursor is on (prompt 026) */
    .with-value {
      display: flex;
      height: 100%;
      min-height: 0;
    }
    .with-value app-result-grid {
      flex: 1 1 0;
      min-width: 0;
    }
    .with-value app-row-form,
    .with-value app-value-panel {
      flex: none;
    }
    .subtabs {
      flex: none;
      display: flex;
      gap: 2px;
      padding: 2px 6px 0;
      overflow-x: auto;
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border);
      scrollbar-width: none;
    }
    .sub {
      flex: none;
      padding: 2px 9px;
      border-radius: var(--radius) var(--radius) 0 0;
      color: var(--text-dim);
      font-size: 12px;
    }
    .sub[aria-selected='true'] {
      background: var(--bg-app);
      color: var(--text);
    }
    .sub.failed .mark {
      color: var(--danger);
    }
    .sub.done .mark {
      color: var(--ok);
    }
    .sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    .log {
      margin: 0;
      padding: 6px 0;
      list-style: none;
      font-size: 12px;
    }
    .log li {
      display: grid;
      grid-template-columns: max-content minmax(120px, 2fr) minmax(120px, 3fr) max-content;
      gap: 12px;
      padding: 2px 12px;
      border-left: 3px solid transparent;
    }
    .log li.error {
      border-left-color: var(--error-edge);
      background: var(--error-bg);
      color: var(--error-fg);
    }
    .log li.cancelled,
    .log time,
    .log .ms {
      color: var(--text-dim);
    }
    .log code {
      font-family: var(--font-mono);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .log .text {
      overflow-wrap: anywhere;
    }
    .log .values {
      /* a line of its own under the statement: values can be long */
      grid-column: 2 / -1;
      grid-row: 2;
      color: var(--text-dim);
      font-family: var(--font-mono);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .message {
      margin: 0;
      padding: 12px 16px;
      color: var(--text-dim);
    }
    .failure {
      padding: 10px 16px;
      background: var(--error-bg);
      color: var(--error-fg);
      border-left: 3px solid var(--error-edge);
      /* the message can be marked and copied by hand too */
      user-select: text;
      -webkit-user-select: text;
    }
    .failure .what {
      margin: 0;
      font-family: var(--font-mono);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .failure dl {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: 2px 12px;
      margin: 8px 0 0;
      font-size: 12px;
    }
    .failure dt {
      font-weight: 600;
    }
    .failure dd {
      margin: 0;
      font-family: var(--font-mono);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .failure .acts {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 10px 0 0;
    }
    .failure button {
      padding: 1px 10px;
      border: 1px solid var(--error-edge);
      border-radius: var(--radius);
      background: transparent;
      color: inherit;
    }
    .message.error {
      background: var(--error-bg);
      color: var(--error-fg);
      border-left: 3px solid var(--error-edge);
      font-family: var(--font-mono);
      white-space: pre-wrap;
    }
  `,
})
export class QueryPane implements OnInit, OnDestroy {
  protected readonly t = TABS_TEXTS;
  protected readonly params = PARAM_TEXTS;
  protected readonly value = VALUE_TEXTS;
  private readonly values = inject(ValueService);
  /** The cell the cursor of this tab's grid is on. */
  protected readonly activeCell = signal<ActiveCell | null>(null);
  /** What stands beside the grid: the row as a form, the value of the cell, or nothing. */
  protected readonly beside = computed(() => {
    const s = this.settings.settings();
    return s.rowFormVisible ? 'form' : s.valuePanelVisible ? 'value' : 'none';
  });
  protected readonly valueMinW = 200;
  protected readonly valueMaxW = 1200;
  protected readonly dragValue = signal<number | null>(null);
  protected readonly valueW = computed(() =>
    Math.min(
      this.valueMaxW,
      Math.max(this.valueMinW, this.dragValue() ?? this.settings.settings().valuePanelWidth),
    ),
  );
  private readonly tabs = inject(TabsStore);
  protected readonly settings = inject(SettingsService);
  private readonly connections = inject(ConnectionsStore);
  private readonly copier = inject(CopyService);
  private readonly objectDetails = inject(ObjectDetailsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly tab = input.required<QueryTab>();

  protected readonly defaults = DEFAULT_SETTINGS;
  protected readonly resultMin = RESULT_MIN;
  /** The text the editor starts with; `null` while it is read. Wrapped: an empty text is a text too. */
  protected readonly startText = signal<{ text: string } | null>(null);
  protected readonly state = computed(() => this.tab().state());
  protected readonly status = computed(() => statusText(this.state()));
  /** The rules of the tab's database for splitting statements. */
  protected readonly dialect = computed<Dialect>(() => {
    const id = this.tab().connectionId();
    return this.connections.profiles().find((p) => p.id === id)?.kind ?? 'sqlite';
  });
  protected readonly time = clock;
  protected readonly outcome = outcomeText;
  /** The result to show: of a finished statement, or of one that still reads. */
  protected readonly result = computed<ResultRef | null>(
    () => {
      const s = this.state();
      const result = s.kind === 'done' || s.kind === 'running' ? s.result : null;
      // looked at through a local filter or order: the view of the store stands in for the result
      const view = this.tab().localView();
      return result && view && view.base === result.resultId
        ? { resultId: view.resultId, columns: result.columns }
        : result;
    },
    // a row count that grows must not look like a new result (the grid would start over)
    { equal: (a, b) => a?.resultId === b?.resultId },
  );
  /** The filter rows have something to stand above: a result, or the view of a table. */
  protected readonly filterBar = computed(
    () => this.tab().shown() !== 'messages' && (!!this.result() || !!this.tab().tableView()),
  );
  /** Rows of the result as the database gave it. */
  protected readonly baseRows = computed(() => {
    const s = this.state();
    return s.kind === 'done' || s.kind === 'running' ? s.rows : 0;
  });
  protected readonly rows = computed(() => {
    const s = this.state();
    const result = s.kind === 'done' || s.kind === 'running' ? s.result : null;
    const view = this.tab().localView();
    return result && view && view.base === result.resultId ? view.rows : this.baseRows();
  });
  /** The sort keys the heads show: those of the table view, else the local ones. */
  protected readonly marks = computed(() => {
    const s = this.state();
    const columns = (s.kind === 'done' || s.kind === 'running' ? s.result?.columns : null) ?? [];
    return sortMarks(
      columns,
      this.tab().tableView()?.spec.order ?? null,
      this.tab().localSpec().sort,
    );
  });
  protected readonly fetch = (resultId: number, from: number, count: number) =>
    this.tab().window(resultId, from, count);
  protected readonly errorMessage = computed(() => {
    const s = this.state();
    return s.kind === 'failed' ? s.message : '';
  });
  /** What the database said beyond the message; `null` for an error of the app or without any. */
  protected readonly errorDetails = computed(() => {
    const s = this.state();
    return s.kind === 'failed' ? s.details : null;
  });
  /** The object an error names: `schema.table.column`, and the constraint that was violated. */
  protected readonly errorObject = computed(() => {
    const d = this.errorDetails();
    return d ? errorObjectText(d) : '';
  });

  // The height is stored when a drag ends; in between the drag signal holds it.
  protected readonly dragHeight = signal<number | null>(null);
  private readonly height = signal(0);
  protected readonly resultMaxH = computed(() => Math.max(RESULT_MIN, this.height() - EDITOR_MIN));
  protected readonly resultH = computed(() =>
    Math.min(
      this.resultMaxH(),
      Math.max(RESULT_MIN, this.dragHeight() ?? this.settings.settings().resultHeight),
    ),
  );

  /** The result lies beside the editor. */
  protected readonly side = computed(() => this.settings.settings().resultPlacement === 'right');
  protected readonly maximized = this.tabs.resultMaximized;
  protected readonly resultMinW = RESULT_MIN_W;
  protected readonly dragWidth = signal<number | null>(null);
  private readonly width = signal(0);
  protected readonly resultMaxW = computed(() =>
    Math.max(RESULT_MIN_W, this.width() - EDITOR_MIN_W),
  );
  protected readonly resultW = computed(() =>
    Math.min(
      this.resultMaxW(),
      Math.max(RESULT_MIN_W, this.dragWidth() ?? this.settings.settings().resultWidth),
    ),
  );

  private readonly editor = viewChild(SqlEditor);
  protected readonly grid = viewChild(ResultGrid);
  protected readonly relations = inject(RelationsService);
  protected readonly edit = inject(EditService);
  /** The changes that are not written yet: the grid shows them instead of what was read. */
  protected readonly edits = computed(() =>
    // a local order or filter shows the rows elsewhere than where they were edited: no marks there
    this.tab().localView() ? null : this.edit.marks(this.tab(), this.result()?.columns ?? []),
  );
  /** The columns whose cells lead to another table: those of the foreign keys of a table view. */
  protected readonly links = computed(() => {
    const columns = this.result()?.columns;
    return columns && this.tab().tableView() ? this.relations.links(this.tab(), columns) : null;
  });
  /** The path is worth a row: the tab went somewhere, or shows only the rows of some keys. */
  protected readonly pathShown = computed(
    () =>
      this.tab().shown() !== 'messages' &&
      !!this.tab().tableView() &&
      (this.tab().nav().entries.length > 1 || !!this.tab().tableView()?.spec.keys),
  );
  private readonly layouts = inject(ColumnLayouts);
  /** How the columns of the result are laid out: of the table of a table view, else of this tab. */
  protected readonly layout = computed(() => this.layouts.of(this.tab()));
  /** The cells the search of the tab found, for the grid (a new object whenever they change). */
  protected readonly hits = computed(() => {
    const find = this.tab().find;
    void find.version();
    return find.open() && find.count() > 0 ? { at: find.marks.at } : null;
  });
  protected readonly cursor = () => this.grid()?.cursor() ?? null;

  protected setLayout(layout: ColumnLayout): void {
    this.layouts.set(this.tab(), layout);
  }
  private observer: ResizeObserver | null = null;
  private readonly handle: TabEditor = {
    goTo: (line, ch) => this.editor()?.goTo(line, ch) ?? Promise.resolve(),
    getText: () => this.editor()?.getText() ?? Promise.resolve(this.startText()?.text ?? ''),
    selectedText: () => this.editor()?.selectedText() ?? Promise.resolve(''),
    setText: (text) => this.editor()?.setText(text) ?? Promise.resolve(),
    focus: () => this.editor()?.focus(),
    insert: (text, snippet) => this.editor()?.insert(text, snippet) ?? Promise.resolve(),
    runCurrent: () => this.editor()?.runCurrent() ?? Promise.resolve(),
    currentStatement: () => this.editor()?.currentStatement() ?? Promise.resolve(''),
    runScript: () => this.editor()?.runScript() ?? Promise.resolve(),
    expandStar: () => this.editor()?.expandStar() ?? Promise.resolve(false),
    format: (mode, whole) => this.editor()?.format(mode, whole) ?? Promise.resolve('nothing'),
    toggleComment: () => this.editor()?.toggleComment() ?? Promise.resolve(),
    clearMarks: () => this.editor()?.clearMarks(),
    markRunning: (statements, index) => void this.editor()?.markRunning(statements, index),
    markError: (statements, index, message, details, jump) =>
      void this.editor()?.markError(statements, index, message, details, jump),
    goToError: () => void this.editor()?.goToError(),
  };

  constructor() {
    // a statement that runs shows its result: a hidden result area comes back
    effect(() => {
      if (!this.tab().running()) return;
      untracked(() => {
        if (!this.settings.settings().resultVisible) this.settings.update({ resultVisible: true });
      });
    });
    effect(() => {
      // a table view: its foreign keys are read once, so its cells can say where they lead
      const tab = this.tab();
      if (tab.tableView()) {
        void this.relations.ensure(tab);
        // and its columns, to know its key: whether its cells can be edited
        this.edit.ensure(tab);
      }
    });
    effect((onCleanup) => {
      // the app moves the cursor of the grid from outside (search, go to row, column list)
      const tab = this.tab();
      const grid = this.grid() ?? null;
      tab.grid = grid;
      onCleanup(() => {
        if (tab.grid === grid) tab.grid = null;
      });
    });
    effect(() => {
      // a hidden pane has no size: keep the last one
      const element = this.host.nativeElement;
      this.observer?.disconnect();
      if (typeof ResizeObserver === 'undefined') return;
      this.observer = new ResizeObserver(() => {
        if (element.clientHeight > 0) this.height.set(element.clientHeight);
        if (element.clientWidth > 0) this.width.set(element.clientWidth);
      });
      this.observer.observe(element);
    });
  }

  async ngOnInit(): Promise<void> {
    const tab = this.tab();
    tab.attach(this.handle);
    this.startText.set({ text: await this.tabs.startText(tab) });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.tab().detach(this.handle);
  }

  /** `✓`, `✗` … in front of the number of a result. */
  protected mark(run: StatementRun): string {
    switch (run.kind) {
      case 'done':
        return '✓';
      case 'failed':
        return '✗';
      case 'running':
        return '…';
      case 'cancelled':
      case 'skipped':
        return '–';
      default:
        return '';
    }
  }

  /** Arrows move between the results and the messages (APG tabs). */
  protected onSubKey(event: KeyboardEvent): void {
    const tab = this.tab();
    const count = tab.runs().length > 1 ? tab.runs().length : 0;
    const order: (number | 'messages')[] = [...Array(count).keys(), 'messages'];
    const at = order.indexOf(tab.shown());
    const to: Record<string, number> = {
      ArrowRight: (at + 1) % order.length,
      ArrowLeft: (at - 1 + order.length) % order.length,
      Home: 0,
      End: order.length - 1,
    };
    const next = to[event.key];
    if (next === undefined) return;
    event.preventDefault();
    tab.shown.set(order[next]);
    setTimeout(() =>
      this.host.nativeElement.querySelector<HTMLElement>('.subtabs [aria-selected=true]')?.focus(),
    );
  }

  /** The editor has its text: back to where the caret was in the last run. */
  protected onSeeded(): void {
    const at = this.tab().takeStartCaret();
    if (at) void this.editor()?.goTo(at.line, at.ch);
  }

  /** The error as text: what one sends to a colleague. */
  protected copyError(): void {
    const s = this.state();
    if (s.kind !== 'failed') return;
    void this.copier.copyText(errorReport(s.message, s.details, s.sql, this.t));
  }

  /** The table an error names, in the object details (prompt 019). */
  protected showErrorTable(): void {
    const d = this.errorDetails();
    if (!d?.table) return;
    this.objectDetails.open({
      connectionId: this.tab().connectionId(),
      schema: d.schema ?? '',
      name: d.table,
      kind: 'table',
      detail: '',
    });
  }

  protected onChanged(change: EdChange): void {
    this.tabs.textChanged(this.tab(), change.charCount, change.dirty);
  }

  /** A click on a column head: the table view orders on the server, any other result in the store. */
  protected onHeadClick(result: ResultRef, click: { column: number; additive: boolean }): void {
    const tab = this.tab();
    const column = result.columns[click.column];
    if (!column) return;
    const view = tab.tableView();
    if (view) {
      void tab.applyTable({
        ...view.spec,
        order: toggleServerOrder(view.spec.order, column.name, click.additive),
      });
    } else {
      const spec = tab.localSpec();
      void tab.setLocal({
        ...spec,
        sort: toggleLocalSort(spec.sort, click.column, click.additive),
      });
    }
  }

  /** The cursor of the grid moved: the value panel and the actions on the value follow. */
  protected onActive(result: ResultRef, at: readonly [number, number] | null): void {
    const column = at ? result.columns[at[1]] : undefined;
    const cell: ActiveCell | null =
      at && column ? { resultId: result.resultId, row: at[0], col: at[1], column } : null;
    const before = this.activeCell();
    this.activeCell.set(cell);
    if (cell) this.values.cell.set(cell);
    else if (before) this.values.forget(before.resultId);
  }

  protected commitValue(width: number): void {
    this.dragValue.set(null);
    this.settings.update({ valuePanelWidth: Math.round(width) });
  }

  protected commitWidth(width: number): void {
    this.dragWidth.set(null);
    this.settings.update({ resultWidth: width });
  }

  protected commitHeight(height: number): void {
    this.dragHeight.set(null);
    this.settings.update({ resultHeight: height });
  }
}
