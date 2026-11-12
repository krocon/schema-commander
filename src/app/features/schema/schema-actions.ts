import { TableViews } from '../filter/table-views.service';
import { Injectable, inject } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { ObjectDetailsService } from '../details/details.service';
import { DataImportService } from '../data-import/data-import.service';
import { DiagramService } from '../diagram/diagram.service';
import { ExportService } from '../export/export.service';
import { ServerSearchService } from '../server-search/server-search.service';
import { CopyService } from '../results/copy.service';
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
  | 'SCHEMA_DETAILS'
  | 'SCHEMA_OPEN_DATA'
  | 'SCHEMA_EXPORT_TABLE'
  | 'SCHEMA_IMPORT_TABLE'
  | 'SCHEMA_SEARCH'
  | 'SCHEMA_DIAGRAM'
  | 'SCHEMA_INSERT_NAME'
  | 'SCHEMA_COPY_NAME'
  | 'SCHEMA_COPY_QUALIFIED'
  | 'SCHEMA_SELECT_TEMPLATE'
  | 'SCHEMA_INSERT_TEMPLATE'
  | 'SCHEMA_UPDATE_TEMPLATE';

export const NODE_ACTIONS: readonly NodeAction[] = [
  'SCHEMA_DETAILS',
  'SCHEMA_OPEN_DATA',
  'SCHEMA_EXPORT_TABLE',
  'SCHEMA_IMPORT_TABLE',
  'SCHEMA_SEARCH',
  'SCHEMA_DIAGRAM',
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
    case 'SCHEMA_DETAILS':
      return row?.kind === 'object';
    case 'SCHEMA_OPEN_DATA':
    case 'SCHEMA_EXPORT_TABLE':
    case 'SCHEMA_SELECT_TEMPLATE':
      return isRelation(row);
    case 'SCHEMA_DIAGRAM':
      // a schema, or a table (a view has no keys)
      return row?.kind === 'schema' || (row?.kind === 'object' && row.object?.kind === 'table');
    case 'SCHEMA_SEARCH':
      // a schema, or something with rows
      return row?.kind === 'schema' || (isRelation(row) && row?.object?.kind !== 'view');
    case 'SCHEMA_IMPORT_TABLE':
    case 'SCHEMA_INSERT_TEMPLATE':
    case 'SCHEMA_UPDATE_TEMPLATE':
      return isRelation(row) && row?.object?.kind === 'table';
  }
}

@Injectable({ providedIn: 'root' })
export class SchemaActions {
  private readonly store = inject(SchemaStore);
  private readonly tabs = inject(TabsStore);
  private readonly tables = inject(TableViews);
  private readonly connections = inject(ConnectionsStore);
  private readonly copier = inject(CopyService);
  private readonly exporter = inject(ExportService);
  private readonly importer = inject(DataImportService);
  private readonly search = inject(ServerSearchService);
  private readonly diagram = inject(DiagramService);
  private readonly details = inject(ObjectDetailsService);

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
      case 'SCHEMA_DETAILS':
        if (!row.schema || !row.object) return;
        this.details.open({
          connectionId: this.connections.activeId(),
          schema: row.schema.name,
          name: row.object.name,
          kind: row.object.kind,
          // the arguments tell overloaded routines apart
          detail: row.object.kind === 'routine' ? row.object.detail : '',
        });
        return;
      case 'SCHEMA_INSERT_NAME':
        this.tabs.active()?.insert(row.kind === 'object' ? qualified : name);
        return;
      case 'SCHEMA_COPY_NAME':
        await this.copier.copyText(name);
        return;
      case 'SCHEMA_COPY_QUALIFIED':
        await this.copier.copyText(qualified);
        return;
      case 'SCHEMA_EXPORT_TABLE':
        this.exporter.request.set({
          kind: 'query',
          connectionId: this.connections.activeId(),
          sql: `SELECT * FROM ${qualified}`,
          name: row.label,
          table: qualified,
        });
        return;
      case 'SCHEMA_DIAGRAM':
        if (!row.schema) return;
        this.diagram.open(
          row.schema.name,
          row.kind === 'object' ? (row.object?.name ?? null) : null,
        );
        return;
      case 'SCHEMA_SEARCH':
        this.search.open(row.schema?.name ?? null, row.kind === 'object' ? row.label : null);
        return;
      case 'SCHEMA_IMPORT_TABLE':
        if (!row.object) return;
        this.importer.open(row.schema?.name ?? null, row.object.name);
        return;
      case 'SCHEMA_OPEN_DATA': {
        if (!row.object) return;
        await this.tables.open(
          this.connections.activeId(),
          row.schema?.name ?? null,
          row.object.name,
          row.label,
        );
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
}
