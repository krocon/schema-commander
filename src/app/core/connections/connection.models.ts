/** Mirrors `DbKind` in src-tauri/src/db/mod.rs. */
export type DbKind = 'postgres' | 'mysql' | 'sqlserver' | 'sqlite';

/** Mirrors `TlsMode`: no TLS (servers on this machine), or TLS with certificate and host name checked. */
export type TlsMode = 'off' | 'verify';

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
}

/** Mirrors `LoadedProfiles`. */
export interface LoadedProfiles {
  readonly profiles: readonly Profile[];
  readonly notice: string | null;
}

/** Mirrors `ConnectionInfo`. */
export interface ConnectionInfo {
  readonly id: string;
  readonly serverVersion: string;
}

export const DEMO_ID = 'demo';

export const DB_KINDS: readonly {
  readonly kind: DbKind;
  readonly label: string;
  readonly port: number;
}[] = [
  { kind: 'postgres', label: 'PostgreSQL', port: 5432 },
  { kind: 'mysql', label: 'MySQL / MariaDB', port: 3306 },
  { kind: 'sqlserver', label: 'SQL Server', port: 1433 },
  { kind: 'sqlite', label: 'SQLite (Datei)', port: 0 },
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
    host: kind === 'sqlite' ? '' : 'localhost',
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
  };
}

/** Whether a host is this machine (TLS off is a sensible default only there). */
export function isLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/** `host:port/database` (or the file) as shown under the name. */
export function whereLabel(p: Profile): string {
  if (p.kind === 'sqlite') return p.database.trim();
  const port = p.port || defaultPort(p.kind);
  const db = p.database.trim();
  return `${p.user.trim()}@${p.host.trim()}:${port}${db ? '/' + db : ''}`;
}

/** Whether connecting may need a password. */
export function usesPassword(p: Pick<Profile, 'kind'>): boolean {
  return p.kind !== 'sqlite';
}
