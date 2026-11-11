import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError, toAppError } from '../../core/errors/app-error';
import { SchemaApi } from '../../core/schema/schema-api';
import { ObjectInfo, SchemaInfo, TableInfo } from '../../core/schema/schema.models';
import { SettingsService } from '../../core/settings/settings.service';
import {
  EMPTY_STATE,
  Loadable,
  SchemaState,
  changesSchema,
  flatten,
  groupId,
  hasColumns,
  schemaId,
  tableKey,
} from './schema-logic';

/** Wait this long after the last key before the server is asked for names. */
export const SEARCH_DELAY_MS = 300;
/** A filter shorter than this is not sent to the server. */
export const SEARCH_MIN_CHARS = 2;

const SEP = '\u0001';

/**
 * What is in the databases of the open connections (prompt 008): read when a node is opened, kept until
 * "refresh" or a statement that changes the schema. The tree shows the active connection.
 */
@Injectable({ providedIn: 'root' })
export class SchemaStore {
  private readonly api = inject(SchemaApi);
  private readonly connections = inject(ConnectionsStore);
  private readonly settings = inject(SettingsService);

  private readonly states = signal<Readonly<Record<string, SchemaState>>>({});
  /** Counts the refreshes per connection: an answer of an older one is dropped. */
  private readonly generations = new Map<string, number>();
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  /** The row the keyboard is on, by its id. */
  readonly activeId = signal<string | null>(null);
  /** What is typed into the filter. */
  readonly filter = signal('');
  readonly showSystem = computed(() => this.settings.settings().showSystemSchemas);
  readonly connectionId = this.connections.activeId;
  readonly state = computed(() => this.states()[this.connectionId()] ?? EMPTY_STATE);

  /** What is known of any connection (the completion asks for the one of its tab). */
  stateOf(id: string): SchemaState {
    return this.states()[id] ?? EMPTY_STATE;
  }
  readonly rows = computed(() => flatten(this.state(), this.showSystem(), this.filter()));
  readonly activeRow = computed(() => {
    const id = this.activeId();
    return id === null ? null : (this.rows().find((r) => r.id === id) ?? null);
  });
  /** Whether the active connection is open (else the tree has nothing to show). */
  readonly connected = computed(() => this.connections.activeState().kind === 'open');

  constructor() {
    effect(() => {
      const id = this.connectionId();
      const open = this.connected();
      untracked(() => {
        if (open) this.ensure(id);
        else this.forget(id);
      });
    });
  }

  private generation(id: string): number {
    return this.generations.get(id) ?? 0;
  }

  private patch(id: string, generation: number, change: (s: SchemaState) => SchemaState): void {
    if (generation !== this.generation(id)) return;
    this.states.update((all) => ({ ...all, [id]: change(all[id] ?? EMPTY_STATE) }));
  }

  private static failed<T>(e: unknown): Loadable<T> {
    return { state: 'error', message: describeError(toAppError(e)) };
  }

  /** Reads the schemas of a connection unless they are there; the current schema opens by itself. */
  ensure(id: string): void {
    if ((this.states()[id] ?? EMPTY_STATE).schemas !== null) return;
    void this.loadSchemas(id);
  }

  private async loadSchemas(id: string): Promise<void> {
    const generation = this.generation(id);
    this.patch(id, generation, (s) => ({ ...s, schemas: { state: 'loading' } }));
    try {
      const schemas = await this.api.schemas(id);
      const first = (this.states()[id] ?? EMPTY_STATE).expanded.size === 0;
      this.patch(id, generation, (s) => ({ ...s, schemas: { state: 'ready', value: schemas } }));
      if (generation !== this.generation(id)) return;
      if (first) {
        const current =
          schemas.find((s) => s.current) ?? (schemas.length === 1 ? schemas[0] : null);
        if (current) this.open(id, schemaId(current.name));
      } else {
        // after a refresh: what was open is read again
        for (const node of (this.states()[id] ?? EMPTY_STATE).expanded) this.load(id, node);
      }
    } catch (e) {
      this.patch(id, generation, (s) => ({ ...s, schemas: SchemaStore.failed(e) }));
    }
  }

  /** Forgets what was read of a connection (it was closed); what was open stays open for the next time. */
  private forget(id: string): void {
    const state = this.states()[id];
    if (!state || state.schemas === null) return;
    this.generations.set(id, this.generation(id) + 1);
    this.states.update((all) => ({
      ...all,
      [id]: { ...EMPTY_STATE, expanded: state.expanded },
    }));
  }

  /** Reads everything of the active connection again; open nodes stay open. */
  refresh(id = this.connectionId()): void {
    const state = this.states()[id] ?? EMPTY_STATE;
    this.generations.set(id, this.generation(id) + 1);
    this.states.update((all) => ({ ...all, [id]: { ...EMPTY_STATE, expanded: state.expanded } }));
    if (this.connections.state(id).kind === 'open') void this.loadSchemas(id);
  }

  /** Statements ran on a connection: when one of them changes the schema, the tree is read again. */
  ran(id: string, statements: readonly string[]): void {
    if ((this.states()[id] ?? EMPTY_STATE).schemas === null) return;
    if (statements.some(changesSchema)) {
      this.refresh(id);
      // the name index (prompt 020) knows the objects of all schemas: read it again, in the background
      void this.api.refreshNames(id).catch(() => undefined);
    }
  }

  /** Opens or closes a node of the active connection. */
  toggle(node: string): void {
    const id = this.connectionId();
    if (this.state().expanded.has(node)) {
      this.patch(id, this.generation(id), (s) => {
        const expanded = new Set(s.expanded);
        expanded.delete(node);
        return { ...s, expanded };
      });
    } else {
      this.open(id, node);
    }
  }

  private open(id: string, node: string): void {
    this.patch(id, this.generation(id), (s) => {
      const expanded = new Set(s.expanded);
      expanded.add(node);
      const [kind, schema] = node.split(SEP);
      // a schema opened for the first time shows its tables at once
      if (kind === 's' && !(schema in s.objects)) expanded.add(groupId(schema, 'table'));
      return { ...s, expanded };
    });
    this.load(id, node);
  }

  /** Reads what an open node shows, unless it is there. */
  private load(id: string, node: string): void {
    const [kind, schema, objectKind, name] = node.split(SEP);
    const state = this.states()[id] ?? EMPTY_STATE;
    if (kind === 's' && !(schema in state.objects)) void this.loadObjects(id, schema);
    if (kind === 'o' && hasColumns(objectKind as ObjectInfo['kind'])) {
      if (!(tableKey(schema, name) in state.tables)) void this.loadTable(id, schema, name);
    }
  }

  private async loadObjects(id: string, schema: string): Promise<void> {
    const generation = this.generation(id);
    const set = (value: Loadable<readonly ObjectInfo[]>) =>
      this.patch(id, generation, (s) => ({ ...s, objects: { ...s.objects, [schema]: value } }));
    set({ state: 'loading' });
    try {
      set({ state: 'ready', value: await this.api.objects(id, schema) });
    } catch (e) {
      set(SchemaStore.failed(e));
    }
  }

  private async loadTable(id: string, schema: string, table: string): Promise<TableInfo | null> {
    const generation = this.generation(id);
    const key = tableKey(schema, table);
    const set = (value: Loadable<TableInfo>) =>
      this.patch(id, generation, (s) => ({ ...s, tables: { ...s.tables, [key]: value } }));
    set({ state: 'loading' });
    try {
      const info = await this.api.table(id, schema, table);
      set({ state: 'ready', value: info });
      return info;
    } catch (e) {
      set(SchemaStore.failed(e));
      return null;
    }
  }

  /** The parts of a table of the active connection, read if need be; `null` when that fails. */
  async table(schema: SchemaInfo, object: ObjectInfo): Promise<TableInfo | null> {
    const id = this.connectionId();
    const known = this.state().tables[tableKey(schema.name, object.name)];
    if (known?.state === 'ready') return known.value;
    return this.loadTable(id, schema.name, object.name);
  }

  /**
   * Sets the filter. What is loaded is filtered at once; when a schema was never opened, the server is
   * asked for the names a little later.
   */
  setFilter(text: string): void {
    this.filter.set(text);
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    const query = text.trim().toLowerCase();
    if (query.length < SEARCH_MIN_CHARS || !this.connected()) return;
    const state = this.state();
    const schemas = state.schemas?.state === 'ready' ? state.schemas.value : [];
    const showSystem = this.showSystem();
    const unread = schemas.some(
      (s) => (showSystem || !s.system) && state.objects[s.name]?.state !== 'ready',
    );
    if (!unread || state.foundFor === query) return;
    this.searchTimer = setTimeout(() => void this.search(query), SEARCH_DELAY_MS);
  }

  private async search(query: string): Promise<void> {
    const id = this.connectionId();
    const generation = this.generation(id);
    try {
      const found = await this.api.search(id, query);
      // the filter went on meanwhile: this answer is of no use
      if (this.filter().trim().toLowerCase() !== query) return;
      this.patch(id, generation, (s) => ({ ...s, found, foundFor: query }));
    } catch {
      // the filter still works on what is loaded
    }
  }
}
