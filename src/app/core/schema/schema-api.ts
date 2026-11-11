import { Injectable } from '@angular/core';
import { call } from '../backend/call';
import {
  Found,
  NameContext,
  NameHits,
  ObjectDetails,
  ObjectInfo,
  ObjectKind,
  SchemaInfo,
  TableInfo,
  TableRelations,
} from './schema.models';

/**
 * What is in the database of an open connection (prompt 008). Every call asks the system catalog; it waits
 * while a statement runs on the connection and rejects with an `AppError` (`not_connected`,
 * `permission_denied`, `timeout`, `cancelled` …).
 */
export abstract class SchemaApi {
  abstract schemas(connectionId: string): Promise<SchemaInfo[]>;
  /** Tables, views, routines, sequences and types of a schema. */
  abstract objects(connectionId: string, schema: string): Promise<ObjectInfo[]>;
  /** Columns, indexes, keys and triggers of a table or view. */
  abstract table(connectionId: string, schema: string, table: string): Promise<TableInfo>;
  /** The foreign keys of a table and those that point to it (prompt 030). */
  abstract relations(connectionId: string, schema: string, table: string): Promise<TableRelations>;
  /** Tables and views whose name holds `text`, in all schemas but the system's (at most 200). */
  abstract search(connectionId: string, text: string): Promise<Found[]>;
  /** Everything about one object and its DDL; `detail` tells overloaded routines apart. */
  abstract details(
    connectionId: string,
    schema: string,
    name: string,
    kind: ObjectKind,
    detail: string,
  ): Promise<ObjectDetails>;
  /**
   * Searches the names of all schemas (prompt 020). The index is read on the first search, the columns on
   * the first search for columns; after that a search touches no database.
   */
  abstract names(connectionId: string, query: string, context: NameContext): Promise<NameHits>;
  /** Reads the names again (after DDL); resolves with how many there are. */
  abstract refreshNames(connectionId: string): Promise<number>;
}

@Injectable()
export class TauriSchemaApi extends SchemaApi {
  schemas(connectionId: string): Promise<SchemaInfo[]> {
    return call('meta_schemas', { id: connectionId });
  }

  objects(connectionId: string, schema: string): Promise<ObjectInfo[]> {
    return call('meta_objects', { id: connectionId, schema });
  }

  table(connectionId: string, schema: string, table: string): Promise<TableInfo> {
    return call('meta_table', { id: connectionId, schema, table });
  }

  relations(connectionId: string, schema: string, table: string): Promise<TableRelations> {
    return call('meta_relations', { id: connectionId, schema, table });
  }

  search(connectionId: string, text: string): Promise<Found[]> {
    return call('meta_search', { id: connectionId, text });
  }

  details(
    connectionId: string,
    schema: string,
    name: string,
    kind: ObjectKind,
    detail: string,
  ): Promise<ObjectDetails> {
    return call('meta_details', { id: connectionId, schema, name, kind, detail });
  }

  names(connectionId: string, query: string, context: NameContext): Promise<NameHits> {
    return call('names_query', { id: connectionId, query, context });
  }

  refreshNames(connectionId: string): Promise<number> {
    return call('names_refresh', { id: connectionId });
  }
}
