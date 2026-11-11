import { Injectable } from '@angular/core';
import { call } from '../backend/call';
import { Found, ObjectInfo, SchemaInfo, TableInfo } from './schema.models';

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
  /** Tables and views whose name holds `text`, in all schemas but the system's (at most 200). */
  abstract search(connectionId: string, text: string): Promise<Found[]>;
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

  search(connectionId: string, text: string): Promise<Found[]> {
    return call('meta_search', { id: connectionId, text });
  }
}
