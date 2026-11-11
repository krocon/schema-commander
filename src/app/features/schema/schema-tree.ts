import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { SettingsService } from '../../core/settings/settings.service';
import { ContextMenu, MenuItem } from '../../shared/context-menu';
import { NodeAction, SchemaActions, allows, rowName, rowQualified } from './schema-actions';
import { TreeRow, keyMove } from './schema-logic';
import { SchemaStore } from './schema.store';
import { SCHEMA_TEXTS } from './schema-texts';

/** Row height in px (the rows are placed by it). */
export const TREE_ROW_HEIGHT = 22;
const OVERSCAN = 8;

/** The rows `first..last` to render for a scroll position. */
export function visibleRange(
  scrollTop: number,
  height: number,
  count: number,
): { first: number; last: number } {
  const first = Math.min(count, Math.max(0, Math.floor(scrollTop / TREE_ROW_HEIGHT) - OVERSCAN));
  const last = Math.min(count, Math.ceil((scrollTop + height) / TREE_ROW_HEIGHT) + OVERSCAN);
  return { first, last: Math.max(first, last) };
}

/** The menu of a node; `label` is asked when the menu opens, so it follows the language. */
const MENU: readonly { id: NodeAction; label: () => string; separator?: boolean }[] = [
  { id: 'SCHEMA_OPEN_DATA', label: () => SCHEMA_TEXTS.openData },
  { id: 'SCHEMA_EXPORT_TABLE', label: () => SCHEMA_TEXTS.exportTable },
  { id: 'SCHEMA_INSERT_NAME', label: () => SCHEMA_TEXTS.insertName, separator: true },
  { id: 'SCHEMA_COPY_NAME', label: () => SCHEMA_TEXTS.copyName },
  { id: 'SCHEMA_COPY_QUALIFIED', label: () => SCHEMA_TEXTS.copyQualified },
  { id: 'SCHEMA_SELECT_TEMPLATE', label: () => SCHEMA_TEXTS.selectTemplate, separator: true },
  { id: 'SCHEMA_INSERT_TEMPLATE', label: () => SCHEMA_TEXTS.insertTemplate },
  { id: 'SCHEMA_UPDATE_TEMPLATE', label: () => SCHEMA_TEXTS.updateTemplate },
];

/**
 * The schema tree of the active connection (prompt 008): a virtual list with the roles and keys of an APG
 * tree. Only the rows in view are in the page, so 50 000 objects cost as much as 50.
 */
@Component({
  selector: 'app-schema-tree',
  imports: [ContextMenu],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header>
      <h2 id="schema-title">{{ t.title }}</h2>
      <button
        type="button"
        class="tool"
        [title]="t.showSystem"
        [attr.aria-label]="t.showSystem"
        [attr.aria-pressed]="store.showSystem()"
        (click)="toggleSystem()"
      >
        ⚙
      </button>
      <button
        type="button"
        class="tool"
        [title]="t.refresh"
        [attr.aria-label]="t.refreshSchema"
        [disabled]="!store.connected()"
        (click)="store.refresh()"
      >
        ⟳
      </button>
    </header>
    <input
      #filter
      type="search"
      class="filter"
      [placeholder]="t.filterPlaceholder"
      [attr.aria-label]="t.filterLabel"
      autocomplete="off"
      spellcheck="false"
      [value]="store.filter()"
      (input)="store.setFilter(filter.value)"
      (keydown.arrowdown)="$event.preventDefault(); focusTree()"
      (keydown.escape)="clearFilter($event)"
    />
    @if (!store.connected()) {
      <p class="note">{{ t.notConnected }}</p>
    }
    <div
      #viewport
      class="viewport"
      role="tree"
      tabindex="0"
      aria-labelledby="schema-title"
      [attr.aria-activedescendant]="activeDom()"
      (scroll)="scrollTop.set(viewport.scrollTop)"
      (keydown)="onKey($event)"
      (click)="onClick($event)"
      (dblclick)="onDoubleClick($event)"
      (contextmenu)="onContextMenu($event)"
      (dragstart)="onDragStart($event)"
    >
      <div class="spacer" role="none" [style.height.px]="store.rows().length * rowHeight">
        @for (item of visible(); track item.row.id) {
          <div
            class="row"
            role="treeitem"
            [id]="'st-' + item.index"
            [attr.data-index]="item.index"
            [attr.aria-level]="item.row.level"
            [attr.aria-expanded]="item.row.expandable ? item.row.expanded : null"
            [attr.aria-selected]="item.row.id === store.activeId()"
            [class.active]="item.row.id === store.activeId()"
            [class.info]="item.row.kind === 'info'"
            [class.error]="item.row.error"
            [class.head]="item.row.kind === 'group' || item.row.kind === 'section'"
            [style.top.px]="item.index * rowHeight"
            [style.padding-left.px]="(item.row.level - 1) * 14 + 4"
            [attr.draggable]="draggable(item.row) ? 'true' : null"
            [title]="item.row.detail ? item.row.label + ' – ' + item.row.detail : item.row.label"
          >
            <span class="twisty" aria-hidden="true">{{
              item.row.expandable ? (item.row.expanded ? '▾' : '▸') : ''
            }}</span>
            @if (item.row.icon) {
              <span class="icon" [class]="item.row.tone" aria-hidden="true">{{
                item.row.icon
              }}</span>
            }
            <span class="label">{{ item.row.label }}</span>
            @if (item.row.detail) {
              <span class="detail">{{ item.row.detail }}</span>
            }
          </div>
        }
      </div>
    </div>
    @if (menu(); as m) {
      <app-context-menu
        [label]="t.menuLabel"
        [items]="m.items"
        [x]="m.x"
        [y]="m.y"
        (picked)="pick($event, m.row)"
        (closed)="closeMenu()"
      />
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      flex: 1;
    }
    header {
      display: flex;
      align-items: center;
      gap: 2px;
      margin-bottom: 4px;
    }
    h2 {
      flex: 1;
      margin: 0;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--text-dim);
    }
    .tool {
      width: 22px;
      height: 22px;
      padding: 0;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: var(--text-dim);
      text-align: center;
    }
    .tool:hover:not(:disabled),
    .tool[aria-pressed='true'] {
      background: var(--bg-hover);
      color: var(--text);
    }
    .filter {
      width: 100%;
      margin-bottom: 4px;
      padding: 3px 6px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
      color: var(--text);
      font: inherit;
    }
    .note {
      margin: 4px 2px;
      color: var(--text-dim);
    }
    .viewport {
      flex: 1;
      min-height: 0;
      overflow: auto;
      outline: none;
    }
    .viewport:focus-visible {
      box-shadow: inset 0 0 0 1px var(--accent);
    }
    .spacer {
      position: relative;
      min-width: 100%;
    }
    .row {
      position: absolute;
      left: 0;
      right: 0;
      height: 22px;
      line-height: 22px;
      display: flex;
      align-items: center;
      gap: 4px;
      padding-right: 6px;
      white-space: nowrap;
      overflow: hidden;
      border-radius: 3px;
      cursor: default;
      user-select: none;
    }
    .row:hover {
      background: var(--bg-hover);
    }
    .row.active {
      background: var(--row-selected);
    }
    .twisty {
      flex: none;
      width: 12px;
      color: var(--text-dim);
      text-align: center;
    }
    .icon {
      flex: none;
      width: 14px;
      text-align: center;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 600;
      color: var(--text-dim);
    }
    .icon.st-table {
      color: var(--accent);
    }
    .icon.st-view,
    .icon.st-matview {
      color: var(--sql-keyword);
    }
    .icon.st-routine,
    .icon.st-sequence,
    .icon.st-type {
      color: var(--sql-number);
    }
    .label {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .detail {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text-dim);
      font-size: 11px;
    }
    .row.head .label {
      color: var(--text-dim);
    }
    .row.info .label {
      color: var(--text-dim);
      font-style: italic;
    }
    .row.error .label {
      color: var(--danger);
      font-style: normal;
    }
  `,
})
export class SchemaTree implements OnDestroy {
  protected readonly store = inject(SchemaStore);
  private readonly actions = inject(SchemaActions);
  private readonly settings = inject(SettingsService);

  protected readonly t = SCHEMA_TEXTS;
  protected readonly rowHeight = TREE_ROW_HEIGHT;
  private readonly viewport = viewChild.required<ElementRef<HTMLElement>>('viewport');
  private readonly filterField = viewChild.required<ElementRef<HTMLInputElement>>('filter');
  protected readonly scrollTop = signal(0);
  private readonly height = signal(300);
  private observer: ResizeObserver | null = null;

  protected readonly menu = signal<{
    row: TreeRow;
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);

  protected readonly visible = computed(() => {
    const rows = this.store.rows();
    const { first, last } = visibleRange(this.scrollTop(), this.height(), rows.length);
    return rows.slice(first, last).map((row, i) => ({ row, index: first + i }));
  });

  private readonly activeIndex = computed(() => {
    const id = this.store.activeId();
    return id === null ? -1 : this.store.rows().findIndex((r) => r.id === id);
  });
  protected readonly activeDom = computed(() =>
    this.activeIndex() >= 0 ? `st-${this.activeIndex()}` : null,
  );

  constructor() {
    afterNextRender(() => {
      const el = this.viewport().nativeElement;
      this.observer = new ResizeObserver(() => this.height.set(el.clientHeight || 300));
      this.observer.observe(el);
    });
    effect(() => {
      // a list that became shorter than the scroll position: the browser clamps, we follow
      this.store.rows();
      untracked(() => this.scrollTop.set(this.viewport().nativeElement.scrollTop));
    });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  /** Puts the focus into the filter (action `SCHEMA_FILTER`). */
  focusFilter(): void {
    this.filterField().nativeElement.focus();
    this.filterField().nativeElement.select();
  }

  protected focusTree(): void {
    this.viewport().nativeElement.focus();
    if (this.activeIndex() < 0) this.activate(0);
  }

  protected clearFilter(event: Event): void {
    if (this.store.filter() === '') return;
    event.stopPropagation();
    this.store.setFilter('');
  }

  protected toggleSystem(): void {
    this.settings.update({ showSystemSchemas: !this.store.showSystem() });
  }

  protected draggable(row: TreeRow): boolean {
    return rowName(row) !== null;
  }

  private rowAt(event: Event): { row: TreeRow; index: number } | null {
    const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-index]');
    if (!el) return null;
    const index = Number(el.dataset['index']);
    const row = this.store.rows()[index];
    return row ? { row, index } : null;
  }

  private activate(index: number): void {
    const row = this.store.rows()[index];
    if (!row) return;
    this.store.activeId.set(row.id);
    // keep the active row in view
    const el = this.viewport().nativeElement;
    const top = index * TREE_ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + TREE_ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + TREE_ROW_HEIGHT - el.clientHeight;
    }
  }

  protected onClick(event: MouseEvent): void {
    const hit = this.rowAt(event);
    if (!hit) return;
    this.activate(hit.index);
    const onTwisty = !!(event.target as HTMLElement).closest('.twisty');
    // sorts open by a click anywhere, the others by their arrow
    if (hit.row.expandable && (onTwisty || hit.row.kind !== 'object')) {
      this.store.toggle(hit.row.id);
    }
  }

  protected onDoubleClick(event: MouseEvent): void {
    const hit = this.rowAt(event);
    if (!hit || (event.target as HTMLElement).closest('.twisty')) return;
    this.open(hit.row);
  }

  /** Enter or a double click: a name goes into the editor. */
  private open(row: TreeRow): void {
    if (allows('SCHEMA_INSERT_NAME', row) && row.kind !== 'schema') {
      void this.actions.run('SCHEMA_INSERT_NAME', row);
    } else if (row.expandable) {
      this.store.toggle(row.id);
    }
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const rows = this.store.rows();
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      const row = rows[this.activeIndex()];
      const el = this.viewport().nativeElement.querySelector<HTMLElement>('.row.active');
      if (row && el) {
        event.preventDefault();
        const box = el.getBoundingClientRect();
        this.openMenu(row, box.left + 24, box.bottom);
      }
      return;
    }
    const move = keyMove(rows, Math.max(0, this.activeIndex()), event.key);
    if (!move) return;
    event.preventDefault();
    event.stopPropagation();
    if ('to' in move) this.activate(move.to);
    else if ('toggle' in move) this.store.toggle(move.toggle);
    else this.open(rows[move.open]);
  }

  protected onContextMenu(event: MouseEvent): void {
    const hit = this.rowAt(event);
    if (!hit) return;
    event.preventDefault();
    this.activate(hit.index);
    this.openMenu(hit.row, event.clientX, event.clientY);
  }

  private openMenu(row: TreeRow, x: number, y: number): void {
    const items: MenuItem[] = MENU.filter((m) => allows(m.id, row)).map((m) => ({
      id: m.id,
      label: m.label(),
      separator: m.separator,
    }));
    if (items.length > 0) items[0] = { ...items[0], separator: false };
    items.push({ id: 'refresh', label: this.t.refresh, separator: items.length > 0 });
    this.menu.set({ row, x, y, items });
  }

  protected pick(id: string, row: TreeRow): void {
    this.closeMenu();
    if (id === 'refresh') this.store.refresh();
    else void this.actions.run(id as NodeAction, row);
  }

  protected closeMenu(): void {
    this.menu.set(null);
    this.viewport().nativeElement.focus();
  }

  protected onDragStart(event: DragEvent): void {
    const hit = this.rowAt(event);
    const text = hit
      ? hit.row.kind === 'object'
        ? rowQualified(hit.row)
        : rowName(hit.row)
      : null;
    if (!text || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData('text/plain', text);
    event.dataTransfer.effectAllowed = 'copy';
  }
}
