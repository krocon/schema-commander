import { CONNECTION_MODEL_TEXTS } from './connection-model-texts';

/** Mirrors `DbKind` in src-tauri/src/db/mod.rs. */
export type DbKind =
  'postgres' | 'mysql' | 'sqlserver' | 'sqlite' | 'oracle' | 'duckdb' | 'clickhouse';

/** An embedded database: a file of this computer (or memory) – no host, no login. */
export function isFileKind(kind: DbKind): boolean {
  return kind === 'sqlite' || kind === 'duckdb';
}

/** Mirrors `TlsMode`: no TLS (servers on this machine), or TLS with certificate and host name checked. */
export type TlsMode = 'off' | 'prefer' | 'require' | 'verify-ca' | 'verify';

/** TLS that checks nothing (`prefer`, `require`): shown as such wherever the connection is shown. */
export const tlsUnchecked = (mode: TlsMode) => mode === 'prefer' || mode === 'require';

/** Mirrors `SshAuth` in src-tauri/src/ssh/mod.rs. */
export type SshAuth = 'agent' | 'key' | 'password';

/** Mirrors `SshTarget`: the jump host a database is reached through – never a secret. */
export interface SshTarget {
  readonly host: string;
  /** 0 = 22. */
  readonly port: number;
  readonly user: string;
  readonly auth: SshAuth;
  /** The key file for `key`; `''` = the usual ones in `~/.ssh`. */
  readonly keyFile: string;
}

/** What the user gave for the SSH tunnel of this connect. */
export interface SshCredentials {
  /** The password, or the passphrase of the key file. */
  readonly secret: string | null;
  /** The fingerprint the user confirmed for an unknown host key. */
  readonly trustFingerprint: string | null;
}

/** Mirrors `HostConfig`: a host of `~/.ssh/config`. */
export interface SshHost {
  readonly alias: string;
  readonly hostName: string;
  readonly user: string | null;
  readonly port: number | null;
  readonly identityFiles: readonly string[];
  /** It needs `ProxyJump`/`ProxyCommand`: not supported. */
  readonly proxy: boolean;
}

/**
 * Mirrors `Protection` in src-tauri/src/db/guard.rs: `free` asks only for what destroys, `ask` for everything
 * that does not read, `readonly` runs nothing else (enforced in the backend, and on the server where it can).
 */
export type Protection = 'free' | 'ask' | 'readonly';

/** A stored connection – never a secret. Mirrors `Profile`. */
export interface Profile {
  /** `''` for a profile that is not stored yet. */
  readonly id: string;
  readonly name: string;
  readonly kind: DbKind;
  readonly host: string;
  /** 0 = the default port of the database. */
  readonly port: number;
  /** The database; for SQLite the path of the file. */
  readonly database: string;
  readonly user: string;
  readonly tls: TlsMode;
  /** A folder in the list, `''` = top level. */
  readonly folder: string;
  /** 1–8: the colour tag (`--conn-N`). */
  readonly color: number;
  /** Keep the password in the keychain of the OS after a login that worked. */
  readonly savePassword: boolean;
  /** What may run here without asking (prompt 012). */
  readonly protection: Protection;
  /** A short mark shown with the connection (`PROD`); `''` = none. */
  readonly label: string;
  /** A PEM file with the certificate authority to check the server against; `''` = the roots of the OS. */
  readonly caFile: string;
  /** Client certificate and its key (PEM files); both or none. */
  readonly clientCert: string;
  readonly clientKey: string;
  /** The jump host the database is reached through; `null` = directly. */
  readonly ssh: SshTarget | null;
}

/** Mirrors `LoadedProfiles`. */
export interface LoadedProfiles {
  readonly profiles: readonly Profile[];
  readonly notice: string | null;
}

/**
 * Mirrors `Capabilities` in src-tauri/src/db/mod.rs (prompt 035): what a connection can do, so the window
 * hides what would only fail.
 */
export interface Capabilities {
  /** What the server is: `PostgreSQL`, `CockroachDB`, `MariaDB` … */
  readonly product: string;
  /** A statement that is stopped ends on the server and the session goes on. */
  readonly cancel: boolean;
  readonly foreignKeys: boolean;
  readonly schemas: boolean;
  readonly triggers: boolean;
  readonly routines: boolean;
  /** The execution plan of a statement can be shown. */
  readonly plan: boolean;
  /** Sessions and running statements can be shown (the server monitor). */
  readonly monitor: boolean;
  /** Users, roles and rights can be shown and changed. */
  readonly access: boolean;
  /** The structure of a table can be edited, schemas can be compared. */
  readonly structure: boolean;
  /** Rows can be changed in the grid and files imported. */
  readonly edit: boolean;
}

/** What is assumed of a connection that has not said what it can do: everything. */
export const ALL_CAPABILITIES: Capabilities = {
  product: '',
  cancel: true,
  foreignKeys: true,
  schemas: true,
  triggers: true,
  routines: true,
  plan: true,
  monitor: true,
  access: true,
  structure: true,
  edit: true,
};

/** Mirrors `ConnectionInfo`. */
export interface ConnectionInfo {
  readonly id: string;
  readonly serverVersion: string;
  readonly capabilities?: Capabilities;
}

export const DEMO_ID = 'demo';

export const DB_KINDS: readonly {
  readonly kind: DbKind;
  readonly label: string;
  readonly port: number;
}[] = [
  // servers that speak its protocol are found out when the connection opens (prompt 035)
  { kind: 'postgres', label: 'PostgreSQL · CockroachDB · TimescaleDB · YugabyteDB', port: 5432 },
  { kind: 'mysql', label: 'MySQL / MariaDB', port: 3306 },
  { kind: 'sqlserver', label: 'SQL Server', port: 1433 },
  // the database of an Oracle profile is its service name (prompt 035b)
  { kind: 'oracle', label: 'Oracle', port: 1521 },
  // a file, or `:memory:` to query Parquet, CSV and JSON files with (prompt 035c)
  { kind: 'duckdb', label: 'DuckDB', port: 0 },
  // over HTTP (8123, with TLS usually 8443) (prompt 035d)
  { kind: 'clickhouse', label: 'ClickHouse', port: 8123 },
  {
    kind: 'sqlite',
    // a getter: the language may change while the app runs
    get label() {
      return CONNECTION_MODEL_TEXTS.sqliteFile;
    },
    port: 0,
  },
];

export function kindLabel(kind: DbKind): string {
  return DB_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}

export function defaultPort(kind: DbKind): number {
  return DB_KINDS.find((k) => k.kind === kind)?.port ?? 0;
}

/** A new profile with the usual values of its database. */
export function emptyProfile(kind: DbKind = 'postgres'): Profile {
  return {
    id: '',
    name: '',
    kind,
    host: isFileKind(kind) ? '' : 'localhost',
    port: 0,
    database: '',
    user:
      kind === 'postgres'
        ? 'postgres'
        : kind === 'mysql'
          ? 'root'
          : kind === 'sqlserver'
            ? 'sa'
            : '',
    tls: 'off',
    folder: '',
    color: 1,
    savePassword: true,
    protection: 'free',
    label: '',
    caFile: '',
    clientCert: '',
    clientKey: '',
    ssh: null,
  };
}

/** Whether a host is this machine (TLS off is a sensible default only there). */
export function isLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/** `host:port/database` (or the file) as shown under the name. */
export function whereLabel(p: Profile): string {
  if (isFileKind(p.kind)) return p.database.trim();
  const port = p.port || defaultPort(p.kind);
  const db = p.database.trim();
  return `${p.user.trim()}@${p.host.trim()}:${port}${db ? '/' + db : ''}`;
}

/** Whether connecting may need a password. */
export function usesPassword(p: Pick<Profile, 'kind'>): boolean {
  return !isFileKind(p.kind);
}

/** Mirrors `Source` in src-tauri/src/db/import.rs: where connections can be taken from (prompt 015). */
export type ImportSource =
  'dbeaver' | 'datagrip' | 'pgpass' | 'pg-service' | 'my-cnf' | 'environment' | 'own';

/** Mirrors `ImportItem`: a connection found in a source. Its password, if any, stays in the backend. */
export interface ImportItem {
  /** Its place in the source: what a pick names. */
  readonly index: number;
  readonly profile: Profile;
  /** A password stands there in clear text and can be taken along (into the keychain). */
  readonly hasPassword: boolean;
  /** What is missing before it can be stored; `null` = nothing. */
  readonly problem: string | null;
  /** A stored profile has this name already (the import adds a number). */
  readonly nameTaken: boolean;
}

/** Mirrors `ImportPick`. */
export interface ImportPick {
  readonly index: number;
  readonly withPassword: boolean;
}

/** Mirrors `ImportPreview`. */
export interface ImportPreview {
  /** The file that was read; `null` for the environment. */
  readonly path: string | null;
  readonly items: readonly ImportItem[];
}

/** Mirrors `UrlDraft`: a connection read from a pasted URL. */
export interface UrlDraft {
  readonly profile: Profile;
  /** The password of the URL, for the password field of the dialog – never part of a profile. */
  readonly password: string | null;
  readonly problem: string | null;
}
