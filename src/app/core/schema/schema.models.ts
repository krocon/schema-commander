/** Mirrors `src-tauri/src/db/meta.rs` (prompt 008): what is in a database. */
export interface SchemaInfo {
  readonly name: string;
  /** The name as it is written in SQL (quoted by the backend where needed). */
  readonly quoted: string;
  /** A schema of the database itself. */
  readonly system: boolean;
  /** Where unqualified names are looked up first. */
  readonly current: boolean;
}

export type ObjectKind = 'table' | 'view' | 'matview' | 'routine' | 'sequence' | 'type';

export interface ObjectInfo {
  readonly kind: ObjectKind;
  readonly name: string;
  readonly quoted: string;
  /** Arguments of a routine, the engine of a table, the sort of a type … */
  readonly detail: string;
  /** Rows as the server estimates them; `null` when it does not. */
  readonly rows: number | null;
}

export interface ColumnInfo {
  readonly name: string;
  readonly quoted: string;
  readonly typeName: string;
  readonly nullable: boolean;
  readonly default: string | null;
  /** `pk`, `fk` or `''`. */
  readonly key: string;
}

/** An index, a key or a trigger of a table. */
export interface PartInfo {
  readonly name: string;
  readonly detail: string;
}

export interface TableInfo {
  readonly columns: readonly ColumnInfo[];
  readonly indexes: readonly PartInfo[];
  readonly keys: readonly PartInfo[];
  readonly triggers: readonly PartInfo[];
}

/** A hit of the name search on the server. */
export interface Found {
  readonly schema: string;
  readonly kind: ObjectKind;
  readonly name: string;
  readonly quoted: string;
}

/** Mirrors `Section` in src-tauri/src/db/details.rs (prompt 019): one list of an object. */
export interface DetailSection {
  /** `columns`, `indexes`, `constraints`, `triggers`, `partitions`, `privileges`, `stats` … */
  readonly id: string;
  /** The keys of the columns; `refSchema` and `refName` name an object a row leads to. */
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
  /** More rows than the backend hands over: the rest is left out. */
  readonly cut: boolean;
}

/** Mirrors `ObjectDetails`. */
export interface ObjectDetails {
  readonly sections: readonly DetailSection[];
  /** The statement(s) that create the object; `null` when the database gives none. */
  readonly ddl: string | null;
  /** Ids of lists the server refused; `ddl` when there is no DDL. */
  readonly notes: readonly string[];
}
