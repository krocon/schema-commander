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
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { describeError, toAppError } from '../../core/errors/app-error';
import { SchemaApi } from '../../core/schema/schema-api';
import { SessionApi } from '../../core/session/session-api';
import { SettingsService } from '../../core/settings/settings.service';
import { ObjectDetailsService } from '../details/details.service';
import { TableViews } from '../filter/table-views.service';
import { readVirtual } from '../relations/relation-logic';
import { DIAGRAM_TEXTS } from './diagram-texts';
import { DiagramTarget } from './diagram.service';
import { Palette, markers, toDbml, toMermaid, toSvg } from './er-export';
import { HEADER, Point, ROW, Rect, anchor, bounds, edgePath, layout, nodeSize } from './er-layout';
import {
  Detail,
  EMPTY_MODEL,
  ErEdge,
  ErModel,
  ErNode,
  buildModel,
  cardinality,
  mostConnected,
  neighbourhood,
  neighbours,
  nodeId,
  shownColumns,
  subModel,
} from './er-model';

/** Tables a diagram starts with at most; more are added by hand. */
export const START_LIMIT = 400;

interface DrawnEdge {
  readonly edge: ErEdge;
  readonly path: string;
  readonly start: string;
  readonly end: string;
  readonly hot: boolean;
}

interface DrawnNode {
  readonly node: ErNode;
  readonly rect: Rect;
  readonly rows: readonly {
    readonly text: string;
    readonly type: string;
    readonly key: boolean;
    readonly y: number;
  }[];
  readonly selected: boolean;
  readonly found: boolean;
}

/**
 * The ER diagram of a schema or of a table with its neighbours (prompt 037): arranged by itself, to be
 * moved by hand, zoomed, searched – and beside it the same as lists, which is what a keyboard and a
 * screen reader use. Names from the database stand in the drawing as text only.
 */
@Component({
  selector: 'app-er-diagram-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="er-title" (cancel)="$event.preventDefault(); closed.emit()">
      <header>
        <h2 id="er-title">{{ heading() }}</h2>
        <input
          #find
          type="search"
          spellcheck="false"
          [attr.aria-label]="t.search"
          [placeholder]="t.search"
          [value]="search()"
          (input)="search.set(find.value)"
        />
        <label>
          {{ t.detail }}
          <select #det (change)="setDetail(det.value)">
            <option value="names" [selected]="detail() === 'names'">{{ t.detailNames }}</option>
            <option value="keys" [selected]="detail() === 'keys'">{{ t.detailKeys }}</option>
            <option value="all" [selected]="detail() === 'all'">{{ t.detailAll }}</option>
          </select>
        </label>
        @if (target().table) {
          <label>
            {{ t.depth }}
            <select #dep (change)="setDepth(+dep.value)">
              @for (d of depths; track d) {
                <option [value]="d" [selected]="depth() === d">{{ t.depthN(d) }}</option>
              }
            </select>
          </label>
        }
        <span class="grow"></span>
        <button type="button" [attr.aria-label]="t.zoomOut" (click)="zoomBy(0.8)">−</button>
        <button type="button" [attr.aria-label]="t.zoomIn" (click)="zoomBy(1.25)">+</button>
        <button type="button" (click)="fit()">{{ t.fit }}</button>
        <button type="button" (click)="arrange()">{{ t.arrange }}</button>
      </header>
      <div class="body">
        <aside>
          <label for="er-tables">{{ t.tables }}</label>
          <select
            #list
            id="er-tables"
            size="12"
            (change)="choose(list.value)"
            (dblclick)="openData()"
            (keydown.enter)="openData()"
          >
            @for (n of listed(); track n.id) {
              <option [value]="n.id" [selected]="n.id === selected()">{{ n.name }}</option>
            }
          </select>
          <div class="actions">
            <button type="button" [disabled]="!selected()" (click)="openData()">
              {{ t.openData }}
            </button>
            <button type="button" [disabled]="!selected()" (click)="openDetails()">
              {{ t.details }}
            </button>
            <button type="button" [disabled]="!selected()" (click)="remove()">
              {{ t.remove }}
            </button>
            <button type="button" [disabled]="!canAddNeighbours()" (click)="addNeighbours()">
              {{ t.addNeighbours }}
            </button>
          </div>
          @if (hidden().length > 0) {
            <label for="er-add">{{ t.add }}</label>
            <select #add id="er-add" (change)="addTable(add.value); add.value = ''">
              <option value="">{{ t.addChoose }}</option>
              @for (n of hidden(); track n.id) {
                <option [value]="n.id">{{ n.name }}</option>
              }
            </select>
          }
          <h3>{{ t.relations }}</h3>
          <ul class="relations">
            @for (r of relationLines(); track $index) {
              <li [class.virtual]="r.virtual" [title]="r.virtual ? t.virtual : ''">
                {{ r.text }} <span class="dim">{{ r.kind }}</span>
              </li>
            } @empty {
              <li class="dim">{{ t.noRelations }}</li>
            }
          </ul>
        </aside>
        <svg
          #svg
          role="img"
          [attr.aria-label]="t.drawingLabel(model().nodes.length, model().edges.length)"
          (wheel)="wheel($event)"
          (pointerdown)="down($event, null)"
          (pointermove)="move($event)"
          (pointerup)="up($event)"
          (pointercancel)="up($event)"
        >
          <defs>
            <marker
              id="er-many"
              markerUnits="userSpaceOnUse"
              markerWidth="18"
              markerHeight="14"
              refX="0"
              refY="7"
              orient="auto-start-reverse"
            >
              <path class="mark" d="M0,1 L12,7 L0,13 M12,7 L0,7" />
              <circle class="ring" cx="15" cy="7" r="2.6" />
            </marker>
            <marker
              id="er-one"
              markerUnits="userSpaceOnUse"
              markerWidth="18"
              markerHeight="14"
              refX="0"
              refY="7"
              orient="auto-start-reverse"
            >
              <path class="mark" d="M5,1 L5,13 M9,1 L9,13" />
            </marker>
            <marker
              id="er-zero-one"
              markerUnits="userSpaceOnUse"
              markerWidth="18"
              markerHeight="14"
              refX="0"
              refY="7"
              orient="auto-start-reverse"
            >
              <path class="mark" d="M4,1 L4,13" />
              <circle class="ring" cx="11" cy="7" r="2.6" />
            </marker>
          </defs>
          <g [attr.transform]="transform()">
            @for (e of edges(); track e.edge.id) {
              <path
                class="edge"
                [class.virtual]="e.edge.virtual"
                [class.hot]="e.hot"
                [attr.d]="e.path"
                [attr.marker-start]="'url(#' + e.start + ')'"
                [attr.marker-end]="'url(#' + e.end + ')'"
              />
            }
            @for (n of nodes(); track n.node.id) {
              <g
                class="node"
                [class.selected]="n.selected"
                [class.found]="n.found"
                [class.faded]="searching() && !n.found"
                [attr.transform]="'translate(' + n.rect.x + ',' + n.rect.y + ')'"
                (pointerdown)="down($event, n.node.id)"
                (dblclick)="choose(n.node.id); openData()"
              >
                <rect [attr.width]="n.rect.w" [attr.height]="n.rect.h" rx="5" />
                <text class="title" x="10" y="17">{{ n.node.name }}</text>
                @if (n.rows.length > 0) {
                  <path class="rule" [attr.d]="'M0,' + header + ' h' + n.rect.w" />
                }
                @for (r of n.rows; track $index) {
                  <text x="10" [attr.y]="r.y" [class.key]="r.key">{{ r.text }}</text>
                  @if (r.type) {
                    <text class="type" [attr.x]="n.rect.w - 10" [attr.y]="r.y" text-anchor="end">
                      {{ r.type }}
                    </text>
                  }
                }
              </g>
            }
          </g>
        </svg>
      </div>
      <footer>
        <span class="status" role="status">{{ status() }}</span>
        <button type="button" [disabled]="model().nodes.length === 0" (click)="saveSvg()">
          {{ t.saveSvg }}
        </button>
        <button type="button" [disabled]="model().nodes.length === 0" (click)="copy('mermaid')">
          {{ t.copyMermaid }}
        </button>
        <button type="button" [disabled]="model().nodes.length === 0" (click)="copy('dbml')">
          {{ t.copyDbml }}
        </button>
        <button type="button" class="primary" (click)="closed.emit()">{{ t.close }}</button>
      </footer>
    </dialog>
  `,
  styles: `
    dialog {
      width: calc(100vw - 32px);
      height: calc(100vh - 32px);
      max-width: none;
      max-height: none;
      padding: 12px;
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
    header,
    footer {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    h2 {
      margin: 0 8px 0 0;
      font-size: 14px;
    }
    h3 {
      margin: 8px 0 2px;
      font-size: 12px;
      color: var(--text-dim);
    }
    .grow,
    .status {
      flex: 1;
    }
    .status {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-dim);
    }
    label {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    select,
    input {
      padding: 3px 6px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
      color: var(--text);
      font: inherit;
      min-width: 0;
    }
    .body {
      flex: 1;
      min-height: 0;
      display: flex;
      gap: 8px;
    }
    aside {
      width: 230px;
      flex: none;
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-height: 0;
    }
    aside label {
      color: var(--text-dim);
      font-size: 12px;
    }
    aside select[size] {
      flex: 1;
      min-height: 100px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .relations {
      flex: 1;
      min-height: 60px;
      margin: 0;
      padding: 0;
      overflow: auto;
      list-style: none;
      font-size: 12px;
    }
    .relations li {
      padding: 1px 0;
      overflow-wrap: anywhere;
    }
    .relations .virtual {
      font-style: italic;
    }
    .dim {
      color: var(--text-dim);
    }
    svg {
      flex: 1;
      min-width: 0;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
      cursor: grab;
      touch-action: none;
      user-select: none;
      font-size: 12px;
    }
    .node {
      cursor: move;
    }
    .node rect {
      fill: var(--bg-panel);
      stroke: var(--border);
    }
    .node.selected rect {
      stroke: var(--accent);
      stroke-width: 2;
    }
    .node.found rect {
      stroke: var(--accent);
    }
    .node.faded {
      opacity: 0.3;
    }
    .node text {
      fill: var(--text);
    }
    .node .title {
      font-weight: 600;
    }
    .node .key {
      fill: var(--accent);
    }
    .node .type {
      fill: var(--text-dim);
    }
    .rule {
      stroke: var(--border);
    }
    .edge {
      fill: none;
      stroke: var(--text-dim);
      stroke-width: 1.4;
    }
    .edge.virtual {
      stroke-dasharray: 6 4;
    }
    .edge.hot {
      stroke: var(--accent);
      stroke-width: 2.2;
    }
    .mark {
      fill: none;
      stroke: var(--text-dim);
      stroke-width: 1.4;
    }
    .ring {
      fill: var(--bg-app);
      stroke: var(--text-dim);
      stroke-width: 1.2;
    }
  `,
})
export class ErDiagramDialog {
  readonly target = input.required<DiagramTarget>();
  readonly closed = output<void>();

  private readonly api = inject(SchemaApi);
  private readonly settings = inject(SettingsService);
  private readonly tables = inject(TableViews);
  private readonly detailsOf = inject(ObjectDetailsService);
  private readonly clipboard = inject(ClipboardApi);
  private readonly files = inject(FileDialogApi);
  private readonly session = inject(SessionApi);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly svg = viewChild.required<ElementRef<SVGSVGElement>>('svg');

  protected readonly t = DIAGRAM_TEXTS;
  protected readonly header = HEADER;
  protected readonly depths = [1, 2, 3, 4];

  /** Everything the schema has. */
  private readonly all = signal<ErModel>(EMPTY_MODEL);
  /** The tables that are drawn. */
  private readonly shown = signal<ReadonlySet<string>>(new Set());
  /** Where the user put tables; the others stand where the arrangement puts them. */
  private readonly moved = signal<ReadonlyMap<string, Point>>(new Map());
  protected readonly detail = signal<Detail>('keys');
  protected readonly depth = signal(1);
  protected readonly selected = signal<string | null>(null);
  protected readonly search = signal('');
  private readonly view = signal({ x: 20, y: 20, k: 1 });
  private readonly note = signal('');
  private readonly loaded = signal<'loading' | 'ready' | 'failed'>('loading');
  private readonly hints = signal<readonly string[]>([]);
  private drag: { id: string | null; x: number; y: number; moved: boolean } | null = null;

  protected readonly model = computed(() => subModel(this.all(), this.shown()));
  private readonly places = computed(() => {
    const auto = layout(this.model(), this.detail());
    const moved = this.moved();
    return new Map([...auto].map(([id, at]) => [id, moved.get(id) ?? at]));
  });
  private readonly rects = computed(() => {
    const places = this.places();
    const detail = this.detail();
    return new Map(
      this.model().nodes.map((n) => [
        n.id,
        { ...(places.get(n.id) ?? { x: 0, y: 0 }), ...nodeSize(n, detail) } as Rect,
      ]),
    );
  });
  protected readonly searching = computed(() => this.search().trim() !== '');
  private readonly matches = computed(() => {
    const text = this.search().trim().toLowerCase();
    return new Set(
      text === ''
        ? []
        : this.model()
            .nodes.filter((n) => n.name.toLowerCase().includes(text))
            .map((n) => n.id),
    );
  });
  protected readonly nodes = computed<DrawnNode[]>(() => {
    const rects = this.rects();
    const detail = this.detail();
    const selected = this.selected();
    const matches = this.matches();
    return this.model().nodes.map((node) => ({
      node,
      rect: rects.get(node.id) ?? { x: 0, y: 0, w: 110, h: HEADER },
      rows: shownColumns(node, detail).map((c, i) => ({
        text: `${c.pk ? 'PK ' : c.fk ? 'FK ' : ''}${c.name}`,
        type: detail === 'all' ? c.typeName : '',
        key: c.pk || c.fk,
        y: HEADER + 14 + i * ROW,
      })),
      selected: node.id === selected,
      found: matches.has(node.id),
    }));
  });
  protected readonly edges = computed<DrawnEdge[]>(() => {
    const rects = this.rects();
    const selected = this.selected();
    const detail = this.detail();
    const nodeOf = new Map(this.model().nodes.map((n) => [n.id, n]));
    const at = (id: string, columns: readonly string[]) => {
      const node = nodeOf.get(id);
      return node ? anchor(node, detail, columns) : null;
    };
    const nth = new Map<string, number>();
    const out: DrawnEdge[] = [];
    for (const edge of this.model().edges) {
      const from = rects.get(edge.from);
      const to = rects.get(edge.to);
      if (!from || !to) continue;
      const pair = `${edge.from}\u0000${edge.to}`;
      const n = nth.get(pair) ?? 0;
      nth.set(pair, n + 1);
      out.push({
        edge,
        path: edgePath(
          from,
          to,
          edge.from === edge.to,
          n,
          at(edge.from, edge.columns),
          at(edge.to, edge.refColumns),
        ),
        ...markers(edge),
        hot: selected !== null && (edge.from === selected || edge.to === selected),
      });
    }
    return out;
  });
  protected readonly transform = computed(() => {
    const v = this.view();
    return `translate(${v.x},${v.y}) scale(${v.k})`;
  });
  /** The tables of the diagram for the list: those that match the search first. */
  protected readonly listed = computed(() => {
    const matches = this.matches();
    return [...this.model().nodes].sort(
      (a, b) =>
        Number(matches.has(b.id)) - Number(matches.has(a.id)) || a.name.localeCompare(b.name),
    );
  });
  protected readonly hidden = computed(() =>
    this.all()
      .nodes.filter((n) => !this.shown().has(n.id))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  protected readonly canAddNeighbours = computed(() => {
    const id = this.selected();
    return id !== null && neighbours(this.all(), id).some((n) => !this.shown().has(n));
  });
  /** The relations of the selected table – or all of the diagram – in words. */
  protected readonly relationLines = computed(() => {
    const id = this.selected();
    const model = this.model();
    const name = new Map(model.nodes.map((n) => [n.id, n.name]));
    const words = { one: this.t.one, zeroOrOne: this.t.zeroOrOne, many: this.t.many };
    return model.edges
      .filter((e) => id === null || e.from === id || e.to === id)
      .map((e) => {
        const c = cardinality(e);
        const from = name.get(e.from) ?? '';
        const to = name.get(e.to) ?? '';
        return {
          text:
            id !== null && e.from !== id
              ? this.t.pointedFrom(from, e.columns.join(', '), e.refColumns.join(', '))
              : `${id === null ? `${from}: ` : ''}${this.t.pointsTo(e.columns.join(', '), to, e.refColumns.join(', '))}`,
          kind: `${words[c.from]} → ${words[c.to]}`,
          virtual: e.virtual,
        };
      });
  });
  protected readonly heading = computed(() => {
    const target = this.target();
    return target.table ? this.t.titleTable(target.table) : this.t.title(target.schema);
  });
  protected readonly status = computed(() => {
    if (this.loaded() === 'loading') return this.t.loading;
    const note = this.note();
    if (note) return note;
    if (this.loaded() === 'ready' && this.all().nodes.length === 0) return this.t.empty;
    const model = this.model();
    return [this.t.drawing(model.nodes.length, model.edges.length), ...this.hints()].join(' · ');
  });

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
    effect(() => {
      const target = this.target();
      untracked(() => void this.load(target));
    });
  }

  private key(): string {
    const t = this.target();
    return `${t.connectionId}|${t.schema}|${t.table ?? ''}`;
  }

  private async load(target: DiagramTarget): Promise<void> {
    this.loaded.set('loading');
    this.note.set('');
    try {
      const data = await this.api.diagram(target.connectionId, target.schema);
      // a relation of the user's without a schema means this one
      const virtual = readVirtual(this.settings.settings().virtualRelations[target.connectionId])
        .map((k) => ({
          ...k,
          schema: k.schema || target.schema,
          refSchema: k.refSchema || target.schema,
        }))
        .filter((k) => k.schema === target.schema && k.refSchema === target.schema);
      const { model, outside } = buildModel(data, virtual);
      this.all.set(model);
      const hints: string[] = [];
      const root = target.table ? nodeId(target.schema, target.table) : null;
      if (root && model.nodes.some((n) => n.id === root)) {
        this.shown.set(neighbourhood(model, root, this.depth()));
        this.selected.set(root);
      } else {
        const start = mostConnected(model, START_LIMIT);
        this.shown.set(start);
        if (start.size < model.nodes.length) {
          hints.push(this.t.limited(start.size, model.nodes.length));
        }
      }
      if (data.cut) hints.push(this.t.cut);
      if (outside > 0) hints.push(this.t.outside(outside));
      this.hints.set(hints);
      const stored = this.settings.settings().diagramPlaces[this.key()] ?? {};
      this.moved.set(new Map(Object.entries(stored).map(([id, [x, y]]) => [id, { x, y }])));
      this.loaded.set('ready');
      setTimeout(() => this.fit());
    } catch (e) {
      this.loaded.set('failed');
      this.note.set(this.t.failed(describeError(toAppError(e))));
    }
  }

  protected setDetail(value: string): void {
    this.detail.set(value === 'names' || value === 'all' ? value : 'keys');
  }

  protected setDepth(depth: number): void {
    const target = this.target();
    if (!target.table) return;
    this.depth.set(Math.min(4, Math.max(1, depth)));
    this.shown.set(neighbourhood(this.all(), nodeId(target.schema, target.table), this.depth()));
    setTimeout(() => this.fit());
  }

  /** Selects a table and brings it into view. */
  protected choose(id: string): void {
    if (!this.shown().has(id)) return;
    this.selected.set(id);
    const rect = this.rects().get(id);
    const size = this.size();
    if (!rect || !size) return;
    const v = this.view();
    const left = rect.x * v.k + v.x;
    const top = rect.y * v.k + v.y;
    if (left < 0 || top < 0 || left + rect.w * v.k > size.w || top + rect.h * v.k > size.h) {
      this.view.set({
        k: v.k,
        x: size.w / 2 - (rect.x + rect.w / 2) * v.k,
        y: size.h / 2 - (rect.y + rect.h / 2) * v.k,
      });
    }
  }

  private node(): ErNode | null {
    const id = this.selected();
    return this.all().nodes.find((n) => n.id === id) ?? null;
  }

  protected openData(): void {
    const node = this.node();
    if (!node) return;
    this.closed.emit();
    void this.tables.open(this.target().connectionId, node.schema || null, node.name, node.name);
  }

  protected openDetails(): void {
    const node = this.node();
    if (!node) return;
    this.closed.emit();
    this.detailsOf.open({
      connectionId: this.target().connectionId,
      schema: node.schema,
      name: node.name,
      kind: 'table',
      detail: '',
    });
  }

  protected remove(): void {
    const id = this.selected();
    if (!id) return;
    this.shown.update((s) => new Set([...s].filter((x) => x !== id)));
    this.selected.set(null);
  }

  protected addTable(id: string): void {
    if (!id) return;
    this.shown.update((s) => new Set([...s, id]));
    this.selected.set(id);
  }

  protected addNeighbours(): void {
    const id = this.selected();
    if (!id) return;
    this.shown.update((s) => new Set([...s, ...neighbours(this.all(), id)]));
  }

  private size(): { w: number; h: number } | null {
    const box = this.svg().nativeElement.getBoundingClientRect();
    return box.width > 0 && box.height > 0 ? { w: box.width, h: box.height } : null;
  }

  /** Scales and moves the drawing so that all of it is seen. */
  protected fit(): void {
    const all = bounds([...this.rects().values()]);
    const size = this.size();
    if (!all || !size) return;
    const k = Math.min(1.5, Math.max(0.05, Math.min((size.w - 40) / all.w, (size.h - 40) / all.h)));
    this.view.set({
      k,
      x: (size.w - all.w * k) / 2 - all.x * k,
      y: (size.h - all.h * k) / 2 - all.y * k,
    });
  }

  /** Forgets where tables were moved to. */
  protected arrange(): void {
    this.moved.set(new Map());
    this.store();
    setTimeout(() => this.fit());
  }

  protected zoomBy(factor: number, at?: Point): void {
    const size = this.size();
    const centre = at ?? (size ? { x: size.w / 2, y: size.h / 2 } : { x: 0, y: 0 });
    this.view.update((v) => {
      const k = Math.min(4, Math.max(0.05, v.k * factor));
      const f = k / v.k;
      return { k, x: centre.x - (centre.x - v.x) * f, y: centre.y - (centre.y - v.y) * f };
    });
  }

  protected wheel(event: WheelEvent): void {
    event.preventDefault();
    const box = this.svg().nativeElement.getBoundingClientRect();
    this.zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, {
      x: event.clientX - box.left,
      y: event.clientY - box.top,
    });
  }

  protected down(event: PointerEvent, id: string | null): void {
    if (event.button !== 0) return;
    // a table takes the pointer for itself: the drawing behind it does not move too
    event.stopPropagation();
    this.drag = { id, x: event.clientX, y: event.clientY, moved: false };
    this.svg().nativeElement.setPointerCapture?.(event.pointerId);
    if (id) this.selected.set(id);
  }

  protected move(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (dx === 0 && dy === 0) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.moved = true;
    const id = drag.id;
    if (id === null) {
      this.view.update((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      return;
    }
    const k = this.view().k;
    const at = this.places().get(id);
    if (!at) return;
    this.moved.update((m) => new Map(m).set(id, { x: at.x + dx / k, y: at.y + dy / k }));
  }

  protected up(event: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    this.svg().nativeElement.releasePointerCapture?.(event.pointerId);
    if (!drag) return;
    if (drag.id && drag.moved) this.store();
    // a click on the empty drawing selects nothing
    if (!drag.id && !drag.moved) this.selected.set(null);
  }

  /** Remembers where tables were put, for this diagram. */
  private store(): void {
    const places = Object.fromEntries(
      [...this.moved()].map(([id, at]) => [id, [Math.round(at.x), Math.round(at.y)] as const]),
    );
    const all = { ...this.settings.settings().diagramPlaces };
    if (Object.keys(places).length === 0) delete all[this.key()];
    else all[this.key()] = places;
    this.settings.update({ diagramPlaces: all });
  }

  private palette(): Palette {
    const style = getComputedStyle(this.dialog().nativeElement);
    const of = (token: string, fallback: string) =>
      style.getPropertyValue(token).trim() || fallback;
    return {
      background: of('--bg-app', '#14171c'),
      panel: of('--bg-panel', '#1b2027'),
      border: of('--border', '#39424e'),
      text: of('--text', '#e6edf3'),
      dim: of('--text-dim', '#8b98a5'),
      accent: of('--accent', '#5aa2f7'),
    };
  }

  protected async copy(format: 'mermaid' | 'dbml'): Promise<void> {
    try {
      await this.clipboard.copyText(
        format === 'mermaid' ? toMermaid(this.model()) : toDbml(this.model()),
      );
      this.note.set(this.t.copied);
    } catch {
      this.note.set(this.t.saveFailed);
    }
  }

  protected async saveSvg(): Promise<void> {
    const target = this.target();
    try {
      const path = await this.files.saveFile(
        this.t.saveSvg,
        `${target.table ?? target.schema ?? 'diagram'}.svg`,
        [{ name: 'SVG', extensions: ['svg'] }],
      );
      if (!path) return;
      await this.session.writeFile(
        path,
        toSvg(this.model(), this.rects(), this.detail(), this.palette()),
        'utf-8',
      );
      this.note.set(this.t.saved(path.split(/[\\/]/).pop() ?? path));
    } catch {
      this.note.set(this.t.saveFailed);
    }
  }
}
