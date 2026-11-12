import {
  DbKind,
  Profile,
  defaultPort,
  isLocalHost,
  isFileKind,
} from '../../core/connections/connection.models';
import { CONNECTION_DIALOG_TEXTS } from './connection-dialog-texts';
import { CONNECTION_TEXTS } from './connection-texts';

/** Pure logic of the connection list and dialog (prompt 003). */

/** The name of a database as the list and the dialogs show it. */
export function kindName(kind: DbKind): string {
  return CONNECTION_TEXTS.kinds[kind] ?? kind;
}

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

export type Field =
  | 'name'
  | 'host'
  | 'port'
  | 'database'
  | 'user'
  | 'clientKey'
  | 'tls'
  | 'sshHost'
  | 'sshPort'
  | 'sshUser';

/** The stage of a connect an error belongs to, as a prefix for its message (`''` when it says so itself). */
export function stageOf(code: string): string {
  switch (code) {
    case 'host_key_changed':
    case 'ssh_secret_required':
      return CONNECTION_DIALOG_TEXTS.stageSsh;
    case 'tls_failed':
      return CONNECTION_DIALOG_TEXTS.stageTls;
    case 'auth_failed':
    case 'secret_required':
      return CONNECTION_DIALOG_TEXTS.stageAuth;
    default:
      return '';
  }
}

/** What is wrong with a profile, by field; empty = it can be stored. Mirrors `profiles::check` in Rust. */
export function profileProblems(p: Profile): Partial<Record<Field, string>> {
  const t = CONNECTION_DIALOG_TEXTS;
  const out: Partial<Record<Field, string>> = {};
  // eslint-disable-next-line no-control-regex
  const control = /[\u0000-\u001f\u007f-\u009f]/;
  if (!p.name.trim()) out.name = t.nameMissing;
  else if ([...p.name].length > 100 || control.test(p.name)) out.name = t.nameInvalid;
  if (!Number.isInteger(p.port) || p.port < 0 || p.port > 65535) {
    out.port = t.portRange;
  }
  if (isFileKind(p.kind)) {
    if (!p.database.trim()) out.database = t.fileMissing;
    return out;
  }
  const host = p.host.trim();
  if (!host) out.host = t.hostMissing;
  else if (!/^[A-Za-z0-9._:[\]%-]{1,253}$/.test(host)) {
    out.host = t.hostInvalid;
  }
  // libSQL logs in with a token alone: the password of the profile
  if (!p.user.trim() && p.kind !== 'libsql') out.user = t.userMissing;
  if (p.kind === 'trino' && !p.database.trim()) out.database = t.catalogMissing;
  if (p.kind === 'd1') {
    const id = /^[A-Za-z0-9-]{1,64}$/;
    if (!id.test(p.database.trim())) out.database = t.d1DatabaseMissing;
    if (!id.test(p.user.trim())) out.user = t.d1AccountMissing;
  }
  if (p.kind === 'oracle') {
    if (!p.database.trim()) out.database = t.serviceMissing;
    if (p.tls === 'prefer' || p.tls === 'require') out.tls = t.oracleTlsChecked;
  }
  if (!p.clientCert.trim() !== !p.clientKey.trim()) {
    out.clientKey = t.certPair;
  }
  if (p.caFile.trim() && p.tls !== 'verify-ca' && p.tls !== 'verify') {
    out.tls = t.caNeedsVerify;
  }
  if (p.ssh) {
    const sshHost = p.ssh.host.trim();
    if (!sshHost || !/^[A-Za-z0-9._:[\]%-]{1,253}$/.test(sshHost)) {
      out.sshHost = t.sshHostMissing;
    }
    if (!Number.isInteger(p.ssh.port) || p.ssh.port < 0 || p.ssh.port > 65535) {
      out.sshPort = t.sshPortRange;
    }
    if (!p.ssh.user.trim()) out.sshUser = t.sshUserMissing;
    if (p.tls === 'verify') {
      out.tls = t.tlsThroughSsh;
    }
  }
  return out;
}

/** Where Cloudflare's API answers. */
export const D1_HOST = 'api.cloudflare.com';

/** The profile after another database was chosen: its usual user, port back to the default. */
export function withKind(p: Profile, kind: DbKind): Profile {
  const users: Record<DbKind, string> = {
    postgres: 'postgres',
    mysql: 'root',
    sqlserver: 'sa',
    sqlite: '',
    oracle: 'system',
    duckdb: '',
    clickhouse: 'default',
    trino: 'trino',
    libsql: '',
    d1: '',
  };
  const usual = Object.values(users);
  return {
    ...p,
    kind,
    port: 0,
    // D1 is reached at Cloudflare, over TLS – nowhere else
    host: isFileKind(kind)
      ? ''
      : kind === 'd1'
        ? D1_HOST
        : p.kind === 'd1'
          ? 'localhost'
          : p.host || 'localhost',
    tls: kind === 'd1' ? 'verify' : p.kind === 'd1' ? 'off' : p.tls,
    user: usual.includes(p.user.trim()) ? users[kind] : p.user,
    database: isFileKind(kind) || isFileKind(p.kind) ? '' : p.database,
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
  if (isFileKind(p.kind)) {
    const file = p.database.trim().split(/[\\/]/).pop() ?? '';
    return file;
  }
  const host = p.host.trim();
  if (!host) return '';
  const db = p.database.trim();
  return db ? `${db} @ ${host}` : host;
}
