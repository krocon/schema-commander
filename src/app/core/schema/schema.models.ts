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

/** Mirrors `NameKind` in src-tauri/src/db/names.rs (prompt 020). */
export type NameKind = 'table' | 'view' | 'matview' | 'routine' | 'sequence' | 'column';

/** Mirrors `NameHit`: a name of the index that a search found. */
export interface NameHit {
  readonly kind: NameKind;
  readonly schema: string;
  readonly name: string;
  /** The table of a column. */
  readonly parent: string | null;
  /** The arguments of a routine, the type of a column. */
  readonly detail: string;
  /** The name as it is written in SQL, with its schema (a column: only its own name). */
  readonly quoted: string;
  /** The name alone as it is written in SQL. */
  readonly quotedName: string;
  /** The characters of `name` that matched (indices of characters, not of UTF-16 units). */
  readonly marks: readonly number[];
}

/** Mirrors `NameHits`. */
export interface NameHits {
  readonly hits: readonly NameHit[];
  /** Names that match in all. */
  readonly total: number;
  /** Names in the index. */
  readonly indexed: number;
  readonly cut: boolean;
}

/** Mirrors `Context`: what the ranking knows beside the query. */
export interface NameContext {
  readonly currentSchema: string;
  /** `schema.name` of what was chosen lately, the latest first. */
  readonly recent: readonly string[];
}

/** Mirrors `ForeignKey` in src-tauri/src/db/relations.rs: columns of a table and what they point to. */
export interface ForeignKey {
  /** The name of the constraint; `''` for a relation the user defined (prompt 030). */
  readonly name: string;
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly refSchema: string;
  readonly refTable: string;
  readonly refColumns: readonly string[];
}

/** Mirrors `Relations`: the keys a table has, and those that point to it. */
export interface TableRelations {
  readonly outgoing: readonly ForeignKey[];
  readonly incoming: readonly ForeignKey[];
}

/** Mirrors `DiagramColumn` in src-tauri/src/db/diagram.rs (prompt 037). */
export interface DiagramColumn {
  readonly name: string;
  readonly typeName: string;
  readonly nullable: boolean;
  /** Part of the primary key. */
  readonly pk: boolean;
}

/** Mirrors `DiagramTable`. */
export interface DiagramTable {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly DiagramColumn[];
}

/** Mirrors `DiagramData`: what an ER diagram of a schema is drawn from. */
export interface DiagramData {
  readonly tables: readonly DiagramTable[];
  /** The keys of the tables of the schema, and those of other schemas that point into it. */
  readonly keys: readonly ForeignKey[];
  /** Columns of a table that are unique together. */
  readonly unique: readonly { readonly table: string; readonly columns: readonly string[] }[];
  /** The schema has more tables than a diagram takes. */
  readonly cut: boolean;
}
