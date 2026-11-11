import {
  Component,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ACTIONS, ActionId } from '../../core/actions/action-catalog';
import { ActionService } from '../../core/actions/action.service';
import { actionLabel, groupLabel } from '../../core/actions/action-texts';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError, toAppError } from '../../core/errors/app-error';
import { SchemaApi } from '../../core/schema/schema-api';
import { NameHits } from '../../core/schema/schema.models';
import { MAX_RECENT_ACTIONS } from '../../core/settings/settings.models';
import { SettingsService } from '../../core/settings/settings.service';
import { SchemaStore } from '../schema/schema.store';
import { TabsStore } from '../tabs/tabs.store';
import {
  GotoHit,
  GotoVariant,
  allowsVariant,
  gotoScope,
  localHits,
  markedChars,
  mergeHits,
  objectHit,
  variantOf,
} from './goto-logic';
import { GotoService } from './goto.service';
import { PaletteEntry, markedParts, paletteHits, pushRecent } from './palette-logic';
import { PALETTE_TEXTS } from './palette-texts';

/** How long the columns of the hit under the cursor wait before they are asked for. */
const PREVIEW_DELAY_MS = 180;
const PREVIEW_COLUMNS = 12;

/** A row of the list, whatever the palette searches. */
interface Row {
  readonly id: string;
  readonly parts: [string, boolean][];
  readonly icon: string;
  readonly where: string;
  readonly keys: string;
  readonly enabled: boolean;
}

/**
 * One field for everything (prompts 002 and 020). As the **command palette** it searches all actions with
 * their shortcuts, the recently used ones first. As **go to anything** it searches the open tabs, the
 * connections and every table, view, routine, sequence – and with `c:` every column – of the database
 * of the tab in front. `>` at the start changes to the commands, Backspace in the empty field back.
 * Enter does the chosen thing after the dialog is closed, so it finds the focus where it was.
 */
@Component({
  selector: 'app-command-palette',
  template: `
    <dialog
      #dialog
      [attr.aria-label]="mode() === 'commands' ? t.title : t.gotoTitle"
      (cancel)="$event.preventDefault(); close()"
      (close)="onClosed()"
    >
      <div class="field">
        @if (mode() === 'commands') {
          <span class="mode" aria-hidden="true">{{ '>' }}</span>
        }
        <input
          #field
          type="text"
          role="combobox"
          aria-controls="palette-list"
          aria-autocomplete="list"
          autocomplete="off"
          spellcheck="false"
          [attr.aria-label]="mode() === 'commands' ? t.search : t.gotoSearch"
          [placeholder]="mode() === 'commands' ? t.placeholder : t.gotoPlaceholder"
          [attr.aria-expanded]="rows().length > 0"
          [attr.aria-activedescendant]="activeId()"
          [value]="query()"
          (input)="setQuery(field.value)"
          (keydown)="onKey($event)"
        />
      </div>
      <ul
        #list
        id="palette-list"
        role="listbox"
        [attr.aria-label]="mode() === 'commands' ? t.commands : t.gotoList"
      >
        @for (row of rows(); track row.id; let i = $index) {
          <li
            role="option"
            tabindex="-1"
            [id]="'palette-option-' + row.id"
            [attr.aria-selected]="i === index()"
            [attr.aria-disabled]="!row.enabled"
            [class.active]="i === index()"
            [class.off]="!row.enabled"
            (click)="run(i)"
            (keydown.enter)="run(i)"
            (pointermove)="index.set(i)"
          >
            @if (row.icon) {
              <span class="icon" aria-hidden="true">{{ row.icon }}</span>
            }
            <span class="label">
              @for (part of row.parts; track $index) {
                <span [class.hit]="part[1]">{{ part[0] }}</span>
              }
            </span>
            <span [class]="mode() === 'commands' ? 'group' : 'where'">{{ row.where }}</span>
            @if (row.keys) {
              <kbd>{{ row.keys }}</kbd>
            }
          </li>
        }
      </ul>
      @if (preview(); as p) {
        <p class="preview">{{ p }}</p>
      }
      <p class="status" role="status">{{ status() }}</p>
      @if (mode() === 'goto') {
        <p class="keys">{{ t.gotoKeys }}</p>
      }
    </dialog>
  `,
  styles: `
    dialog {
      top: 12vh;
      margin: 0 auto;
      width: min(620px, calc(100vw - 32px));
      max-height: 70vh;
      padding: 0;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 16px 40px rgb(0 0 0 / 35%);
    }
    dialog[open] {
      display: flex;
      flex-direction: column;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 20%);
    }
    input {
      flex: none;
      margin: 10px;
      padding: 6px 10px;
      font-size: 14px;
    }
    ul {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      margin: 0;
      padding: 0 6px;
      list-style: none;
    }
    li {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 5px 8px;
      border-radius: var(--radius);
      cursor: pointer;
    }
    li.active {
      background: var(--row-selected);
    }
    li.off {
      color: var(--text-dim);
      cursor: default;
    }
    .label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .hit {
      color: var(--accent);
      font-weight: 600;
    }
    .group,
    .status {
      color: var(--text-dim);
      font-size: 11.5px;
    }
    kbd {
      padding: 1px 6px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-raised);
      font: 11.5px var(--font-ui);
      white-space: nowrap;
    }
    .status {
      flex: none;
      margin: 0;
      padding: 6px 14px 8px;
    }
    .field {
      flex: none;
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 10px;
    }
    .field input {
      flex: 1 1 0;
      min-width: 0;
      margin: 0;
    }
    .mode {
      flex: none;
      padding: 1px 8px;
      border: 1px solid var(--border);
      border-radius: 10px;
      color: var(--text-dim);
      font-size: 11.5px;
    }
    .icon {
      flex: none;
      width: 18px;
      color: var(--text-dim);
      font: 600 11.5px var(--font-mono);
      text-align: center;
    }
    .where {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-dim);
      font-size: 11.5px;
    }
    .preview {
      flex: none;
      margin: 0;
      padding: 4px 14px 0;
      color: var(--text-dim);
      font: 11.5px var(--font-mono);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .keys {
      flex: none;
      margin: 0;
      padding: 0 14px 8px;
      color: var(--text-dim);
      font-size: 11.5px;
    }
  `,
})
export class CommandPalette implements OnInit {
  protected readonly t = PALETTE_TEXTS;
  private readonly actions = inject(ActionService);
  private readonly settings = inject(SettingsService);
  private readonly api = inject(SchemaApi);
  private readonly tabs = inject(TabsStore);
  private readonly connections = inject(ConnectionsStore);
  private readonly schema = inject(SchemaStore);
  private readonly goto = inject(GotoService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');
  private readonly list = viewChild.required<ElementRef<HTMLElement>>('list');

  /** What the palette searches when it opens. */
  readonly start = input<'commands' | 'goto'>('commands');
  readonly closed = output<void>();

  protected readonly mode = signal<'commands' | 'goto'>('commands');
  protected readonly query = signal('');
  protected readonly index = signal(0);
  /** What to do once the dialog is gone. */
  private chosen: (() => void) | null = null;

  // --- commands ---
  private readonly entries = computed<PaletteEntry[]>(() => {
    const engine = this.actions.engine();
    const platform = this.actions.platform();
    return ACTIONS.filter((a) => !('hidden' in a && a.hidden)).map((a) => {
      const first = this.actions.shortcuts(a.id)[0];
      return {
        id: a.id,
        label: actionLabel(a.id),
        group: groupLabel(a.group),
        keys: first && engine ? engine.formatShortcut(first, platform) : '',
        enabled: this.actions.isRegistered(a.id) && this.actions.canRun(a.id),
      };
    });
  });
  protected readonly hits = computed(() =>
    paletteHits(this.entries(), this.query(), this.settings.settings().recentActions),
  );

  // --- go to anything ---
  /** The connection whose names are searched: that of the tab in front. */
  private readonly connectionId = computed(
    () => this.tabs.active()?.connectionId() ?? this.connections.activeId(),
  );
  /** What the backend found for the query on screen; `null` while nothing came yet. */
  private readonly names = signal<NameHits | null>(null);
  private readonly problem = signal<string | null>(null);
  private readonly searching = signal(false);
  private asked = 0;
  protected readonly gotoHits = computed<GotoHit[]>(() => {
    const scope = gotoScope(this.query());
    const tabs = scope.tabs
      ? localHits(
          'tab',
          this.tabs.tabs().map((t) => ({
            id: t.id,
            name: t.title(),
            where: this.connectionName(t.connectionId()),
          })),
          scope.text,
        )
      : [];
    const connections = scope.connections
      ? localHits(
          'connection',
          this.connections.profiles().map((p) => ({ id: p.id, name: p.name, where: p.kind })),
          scope.text,
        )
      : [];
    const names = scope.objects ? (this.names()?.hits ?? []).map(objectHit) : [];
    return mergeHits(tabs, connections, names);
  });

  protected readonly rows = computed<Row[]>(() =>
    this.mode() === 'commands'
      ? this.hits().map((hit) => ({
          id: hit.entry.id,
          parts: markedParts(hit.entry.label, hit.marks),
          icon: '',
          where: hit.entry.group,
          keys: hit.entry.keys,
          enabled: hit.entry.enabled,
        }))
      : this.gotoHits().map((hit) => ({
          id: hit.key,
          parts: markedChars(hit.name, hit.marks),
          icon: this.t.icons[hit.kind],
          where: hit.where ? `${hit.where} · ${this.t.kinds[hit.kind]}` : this.t.kinds[hit.kind],
          keys: '',
          enabled: true,
        })),
  );
  protected readonly activeId = computed(() => {
    const row = this.rows()[this.index()];
    return row ? `palette-option-${row.id}` : null;
  });
  /** What a screen reader hears after every key: how many there are, or why there are none. */
  protected readonly status = computed(() => {
    if (this.mode() === 'commands') {
      return this.hits().length === 0 ? this.t.none : this.t.count(this.hits().length);
    }
    const scope = gotoScope(this.query());
    if (scope.saved) return this.t.gotoNoSaved;
    const problem = this.problem();
    const shown = this.gotoHits().length;
    if (scope.objects && problem && shown === 0) return problem;
    if (scope.objects && this.names() === null && this.searching()) return this.t.gotoReading;
    if (shown === 0) return this.t.gotoNone;
    const names = scope.objects ? this.names() : null;
    const more = names && names.total > names.hits.length ? names.total : null;
    const text = more ? this.t.gotoCountOf(shown, more) : this.t.gotoCount(shown);
    return scope.objects && problem ? `${text} ${problem}` : text;
  });
  /** The columns of the table under the cursor, as a line under the list. */
  protected readonly preview = signal<string | null>(null);
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private previewAsked = 0;

  constructor() {
    // every key press asks the backend; an answer to an older question is dropped
    effect(() => {
      if (this.mode() !== 'goto') return;
      const query = this.query();
      const id = this.connectionId();
      untracked(() => void this.search(id, query));
    });
    effect(() => {
      const hit = this.mode() === 'goto' ? this.gotoHits()[this.index()] : undefined;
      const id = this.connectionId();
      untracked(() => this.planPreview(id, hit));
    });
  }

  ngOnInit(): void {
    this.mode.set(this.start());
    this.dialog().nativeElement.showModal();
    this.field().nativeElement.focus();
  }

  /** The schema unqualified names are looked up in first, as far as the tree knows it. */
  private currentSchema(): string {
    const schemas = this.schema.state().schemas;
    return schemas?.state === 'ready' ? (schemas.value.find((s) => s.current)?.name ?? '') : '';
  }

  private connectionName(id: string): string {
    return this.connections.profiles().find((p) => p.id === id)?.name ?? '';
  }

  private async search(connectionId: string, query: string): Promise<void> {
    const mine = ++this.asked;
    if (!gotoScope(query).objects) {
      this.searching.set(false);
      return;
    }
    this.searching.set(true);
    try {
      const names = await this.api.names(connectionId, query, {
        currentSchema: this.currentSchema(),
        recent: this.settings.settings().recentObjects,
      });
      if (mine !== this.asked) return;
      this.names.set(names);
      this.problem.set(null);
    } catch (e) {
      if (mine !== this.asked) return;
      this.names.set(null);
      // not connected is no failure here: tabs and connections can still be gone to
      this.problem.set(
        toAppError(e).code === 'backend_unavailable' ? null : describeError(toAppError(e)),
      );
    } finally {
      if (mine === this.asked) this.searching.set(false);
    }
    // the list changed under the cursor
    if (this.index() >= this.rows().length) this.index.set(0);
  }

  private planPreview(connectionId: string, hit: GotoHit | undefined): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    const mine = ++this.previewAsked;
    this.preview.set(null);
    const object = hit?.object;
    if (!object || !['table', 'view', 'matview'].includes(object.kind)) return;
    this.previewTimer = setTimeout(() => {
      void this.api.table(connectionId, object.schema, object.name).then(
        (table) => {
          if (mine !== this.previewAsked) return;
          const shown = table.columns
            .slice(0, PREVIEW_COLUMNS)
            .map((c) => `${c.name} ${c.typeName}`);
          const more = table.columns.length - shown.length;
          this.preview.set(shown.join(', ') + (more > 0 ? ` … +${more}` : ''));
        },
        () => undefined,
      );
    }, PREVIEW_DELAY_MS);
  }

  protected setQuery(value: string): void {
    // `>` at the start: the commands (the sign is the mode, not part of the search)
    if (this.mode() === 'goto' && value.startsWith('>')) {
      this.mode.set('commands');
      value = value.slice(1).trimStart();
      this.field().nativeElement.value = value;
    }
    this.query.set(value);
    this.index.set(0);
  }

  protected onKey(event: KeyboardEvent): void {
    const count = this.rows().length;
    const move = (to: number) => {
      event.preventDefault();
      if (count === 0) return;
      this.index.set((to + count) % count);
      this.scrollToActive();
    };
    switch (event.key) {
      case 'ArrowDown':
        return move(this.index() + 1);
      case 'ArrowUp':
        return move(this.index() - 1);
      case 'PageDown':
        return move(Math.min(count - 1, this.index() + 8));
      case 'PageUp':
        return move(Math.max(0, this.index() - 8));
      case 'Home':
        if (event.ctrlKey || event.metaKey) move(0);
        return;
      case 'End':
        if (event.ctrlKey || event.metaKey) move(count - 1);
        return;
      case 'Backspace':
        // in the empty field of the commands: back to everything
        if (this.mode() === 'commands' && this.query() === '' && !event.repeat) {
          event.preventDefault();
          this.mode.set('goto');
          this.index.set(0);
        }
        return;
      case 'Enter': {
        event.preventDefault();
        if (event.repeat) return;
        this.run(this.index(), variantOf(event) ?? 'default');
        return;
      }
    }
  }

  protected run(i: number, variant: GotoVariant = 'default'): void {
    if (this.mode() === 'commands') {
      const hit = this.hits()[i];
      if (!hit || !hit.entry.enabled) return;
      const id = hit.entry.id as ActionId;
      this.chosen = () => {
        this.settings.update({
          recentActions: pushRecent(this.settings.settings().recentActions, id, MAX_RECENT_ACTIONS),
        });
        this.actions.run(id, 'other');
      };
    } else {
      const hit = this.gotoHits()[i];
      if (!hit) return;
      // a variant that makes no sense for this hit does the usual thing
      const wanted = allowsVariant(hit, variant) ? variant : 'default';
      const connectionId = this.connectionId();
      this.chosen = () => void this.goto.run(hit, wanted, connectionId);
    }
    this.close();
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  /** The dialog is gone and the focus is back where it was: now the chosen thing happens. */
  protected onClosed(): void {
    const chosen = this.chosen;
    this.chosen = null;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.closed.emit();
    chosen?.();
  }

  private scrollToActive(): void {
    const id = this.activeId();
    if (id)
      this.list()
        .nativeElement.querySelector(`#${CSS.escape(id)}`)
        ?.scrollIntoView?.({ block: 'nearest' });
  }
}
