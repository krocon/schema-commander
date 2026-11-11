import { Injectable, inject } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { TabsStore } from '../tabs/tabs.store';
import {
  TreeRow,
  hasColumns,
  insertSnippet,
  qualifiedName,
  selectTemplate,
  updateSnippet,
} from './schema-logic';
import { SchemaStore } from './schema.store';

/** What can be done with a node of the schema tree (prompt 008); each is an action of the app. */
export type NodeAction =
  | 'SCHEMA_OPEN_DATA'
  | 'SCHEMA_INSERT_NAME'
  | 'SCHEMA_COPY_NAME'
  | 'SCHEMA_COPY_QUALIFIED'
  | 'SCHEMA_SELECT_TEMPLATE'
  | 'SCHEMA_INSERT_TEMPLATE'
  | 'SCHEMA_UPDATE_TEMPLATE';

export const NODE_ACTIONS: readonly NodeAction[] = [
  'SCHEMA_OPEN_DATA',
  'SCHEMA_INSERT_NAME',
  'SCHEMA_COPY_NAME',
  'SCHEMA_COPY_QUALIFIED',
  'SCHEMA_SELECT_TEMPLATE',
  'SCHEMA_INSERT_TEMPLATE',
  'SCHEMA_UPDATE_TEMPLATE',
];

/** The name of a row as it is written in SQL; `null` for rows without one (sorts, notes). */
export function rowName(row: TreeRow | null): string | null {
  if (!row) return null;
  if (row.kind === 'column') return row.column?.quoted ?? null;
  if (row.kind === 'object') return row.object?.quoted ?? null;
  if (row.kind === 'schema') return row.schema?.quoted ?? null;
  return null;
}

/** The name with its schema where that is needed. */
export function rowQualified(row: TreeRow | null): string | null {
  if (!row) return null;
  if (row.kind === 'object' && row.schema && row.object) {
    return qualifiedName(row.schema, row.object);
  }
  return rowName(row);
}

/** Whether a row is a table or view (something with rows and columns). */
export const isRelation = (row: TreeRow | null): boolean =>
  !!row && row.kind === 'object' && !!row.object && hasColumns(row.object.kind);

/** Whether an action makes sense for a row. */
export function allows(action: NodeAction, row: TreeRow | null): boolean {
  switch (action) {
    case 'SCHEMA_INSERT_NAME':
    case 'SCHEMA_COPY_NAME':
      return rowName(row) !== null;
    case 'SCHEMA_COPY_QUALIFIED':
      return row?.kind === 'object';
    case 'SCHEMA_OPEN_DATA':
    case 'SCHEMA_SELECT_TEMPLATE':
      return isRelation(row);
    case 'SCHEMA_INSERT_TEMPLATE':
    case 'SCHEMA_UPDATE_TEMPLATE':
      return isRelation(row) && row?.object?.kind === 'table';
  }
}

@Injectable({ providedIn: 'root' })
export class SchemaActions {
  private readonly store = inject(SchemaStore);
  private readonly tabs = inject(TabsStore);
  private readonly connections = inject(ConnectionsStore);

  /** Whether `action` can run on the active row of the tree. */
  can(action: NodeAction): boolean {
    return allows(action, this.store.activeRow());
  }

  /** Runs `action` on a row (default: the active one). */
  async run(action: NodeAction, row: TreeRow | null = this.store.activeRow()): Promise<void> {
    if (!row || !allows(action, row)) return;
    const name = rowName(row) ?? '';
    const qualified = rowQualified(row) ?? '';
    const kind = this.connections.active()?.kind ?? 'sqlite';
    switch (action) {
      case 'SCHEMA_INSERT_NAME':
        this.tabs.active()?.insert(row.kind === 'object' ? qualified : name);
        return;
      case 'SCHEMA_COPY_NAME':
        await this.copy(name);
        return;
      case 'SCHEMA_COPY_QUALIFIED':
        await this.copy(qualified);
        return;
      case 'SCHEMA_OPEN_DATA': {
        const sql = selectTemplate(kind, qualified);
        const tab = this.tabs.newTab(sql, { title: row.label, customTitle: true });
        await tab.run(sql);
        return;
      }
      case 'SCHEMA_SELECT_TEMPLATE':
      case 'SCHEMA_INSERT_TEMPLATE':
      case 'SCHEMA_UPDATE_TEMPLATE': {
        if (!row.schema || !row.object) return;
        const table = await this.store.table(row.schema, row.object);
        if (!table) return;
        const tab = this.tabs.active();
        if (action === 'SCHEMA_SELECT_TEMPLATE') {
          tab?.insert(selectTemplate(kind, qualified, table.columns));
        } else if (action === 'SCHEMA_INSERT_TEMPLATE') {
          tab?.insert(insertSnippet(qualified, table.columns), true);
        } else {
          tab?.insert(updateSnippet(qualified, table.columns), true);
        }
      }
    }
  }

  private async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // no clipboard (no permission, no focus): nothing to copy to
    }
  }
}
