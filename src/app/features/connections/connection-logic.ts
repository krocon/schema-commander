import {
  DbKind,
  Profile,
  defaultPort,
  isLocalHost,
} from '../../core/connections/connection.models';

/** Pure logic of the connection list and dialog (prompt 003). */

export interface ProfileGroup {
  /** `''` = the top level. */
  readonly folder: string;
  readonly profiles: readonly Profile[];
}

/** The profiles by folder: the top level first, then the folders by name; inside by name, the demo first. */
export function groupProfiles(profiles: readonly Profile[], filter = ''): ProfileGroup[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = profiles.filter((p) => {
    const hay = `${p.name} ${p.folder} ${p.host} ${p.database} ${p.kind}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const folders = [...new Set(shown.map((p) => p.folder.trim()))].sort((a, b) =>
    a === '' ? -1 : b === '' ? 1 : a.localeCompare(b),
  );
  return folders.map((folder) => ({
    folder,
    profiles: shown
      .filter((p) => p.folder.trim() === folder)
      .sort(
        (a, b) => Number(b.id === 'demo') - Number(a.id === 'demo') || a.name.localeCompare(b.name),
      ),
  }));
}

export type Field = 'name' | 'host' | 'port' | 'database' | 'user';

/** What is wrong with a profile, by field; empty = it can be stored. Mirrors `profiles::check` in Rust. */
export function profileProblems(p: Profile): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  // eslint-disable-next-line no-control-regex
  const control = /[\u0000-\u001f\u007f-\u009f]/;
  if (!p.name.trim()) out.name = 'Bitte einen Namen eingeben.';
  else if ([...p.name].length > 100 || control.test(p.name))
    out.name = 'Der Name ist nicht erlaubt.';
  if (!Number.isInteger(p.port) || p.port < 0 || p.port > 65535) {
    out.port = 'Der Port liegt zwischen 1 und 65535.';
  }
  if (p.kind === 'sqlite') {
    if (!p.database.trim()) out.database = 'Bitte eine Datei wählen.';
    return out;
  }
  const host = p.host.trim();
  if (!host) out.host = 'Bitte einen Host eingeben.';
  else if (!/^[A-Za-z0-9._:[\]%-]{1,253}$/.test(host)) {
    out.host = 'Nur der Name oder die Adresse des Rechners, ohne Leerzeichen, Pfad oder Benutzer.';
  }
  if (!p.user.trim()) out.user = 'Bitte einen Benutzer eingeben.';
  return out;
}

/** The profile after another database was chosen: its usual user, port back to the default. */
export function withKind(p: Profile, kind: DbKind): Profile {
  const users: Record<DbKind, string> = {
    postgres: 'postgres',
    mysql: 'root',
    sqlserver: 'sa',
    sqlite: '',
  };
  const usual = Object.values(users);
  return {
    ...p,
    kind,
    port: 0,
    host: kind === 'sqlite' ? '' : p.host || 'localhost',
    user: usual.includes(p.user.trim()) ? users[kind] : p.user,
    database: kind === 'sqlite' || p.kind === 'sqlite' ? '' : p.database,
  };
}

/** TLS is suggested for every host that is not this machine. */
export function suggestedTls(host: string): 'off' | 'verify' {
  return !host.trim() || isLocalHost(host) ? 'off' : 'verify';
}

/** The port as shown in the field: empty for the default. */
export function portText(p: Profile): string {
  return p.port ? String(p.port) : '';
}

export function portPlaceholder(kind: DbKind): string {
  return String(defaultPort(kind));
}

/** A name for a profile that has none yet: `user@host/database`, or the file's name. */
export function suggestedName(p: Profile): string {
  if (p.kind === 'sqlite') {
    const file = p.database.trim().split(/[\\/]/).pop() ?? '';
    return file;
  }
  const host = p.host.trim();
  if (!host) return '';
  const db = p.database.trim();
  return db ? `${db} @ ${host}` : host;
}
