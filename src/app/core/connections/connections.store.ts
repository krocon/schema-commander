import { Injectable, computed, inject, signal } from '@angular/core';
import { AppError, describeError, toAppError } from '../errors/app-error';
import { SettingsService } from '../settings/settings.service';
import {
  DEMO_ID,
  ImportPick,
  ImportPreview,
  ImportSource,
  Profile,
  SshCredentials,
  SshHost,
  UrlDraft,
  usesPassword,
} from './connection.models';
import { ConnectionsApi } from './connections-api';

export type ConnectionState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'open'; readonly serverVersion: string }
  | { readonly kind: 'failed'; readonly message: string };

/** The app asks for the password of a connection. */
export interface PasswordRequest {
  readonly id: string;
  /** The password tried before was refused. */
  readonly wrong: boolean;
  /** What is asked for: the login of the database, or what unlocks its SSH tunnel. */
  readonly kind: 'database' | 'ssh';
}

/** The app asks whether the key an SSH server shows is the right one. */
export interface HostKeyRequest {
  readonly id: string;
  readonly host: string;
  readonly keyType: string;
  readonly fingerprint: string;
}

/**
 * Key type and fingerprint from a `host_key_unknown` error: its message ends with them.
 */
export function shownHostKey(message: string): { keyType: string; fingerprint: string } | null {
  const found = /([a-z0-9@.-]+) (SHA256:[A-Za-z0-9+/=]+)\s*$/.exec(message);
  return found ? { keyType: found[1], fingerprint: found[2] } : null;
}

const CLOSED: ConnectionState = { kind: 'closed' };

/**
 * The connections of the app (prompt 003): the stored profiles, which of them are open, and the active one –
 * the connection statements run on. Nothing connects without the user asking for it (connect, or run a
 * statement on a closed connection); the demo database in memory is opened at the start.
 */
@Injectable({ providedIn: 'root' })
export class ConnectionsStore {
  private readonly api = inject(ConnectionsApi);
  private readonly settings = inject(SettingsService);

  readonly profiles = signal<readonly Profile[]>([]);
  /** What reading the profiles had to say (broken file, ignored entries). */
  readonly notice = signal<string | null>(null);
  private readonly states = signal<Readonly<Record<string, ConnectionState>>>({});
  /** The password dialog is open for this connection. */
  readonly passwordRequest = signal<PasswordRequest | null>(null);
  /** An SSH server shows a key nobody confirmed yet. */
  readonly hostKeyRequest = signal<HostKeyRequest | null>(null);
  private hostKeyWaiter: ((trust: boolean) => void) | null = null;
  private passwordWaiters: ((password: string | null) => void)[] = [];
  private readonly activated: ((id: string) => void)[] = [];
  /** A connection attempt per id, so two callers share one. */
  private readonly opening = new Map<string, Promise<boolean>>();

  /** The connection statements run on; falls back to the demo when the stored one is gone. */
  readonly activeId = computed(() => {
    const id = this.settings.settings().activeConnection;
    return this.profiles().some((p) => p.id === id) ? id : DEMO_ID;
  });
  readonly active = computed(() => this.profiles().find((p) => p.id === this.activeId()) ?? null);
  readonly activeState = computed(() => this.state(this.activeId()));

  state(id: string): ConnectionState {
    return this.states()[id] ?? CLOSED;
  }

  /** Reads the profiles (at the start) and opens the demo database when it is the active one. */
  async load(): Promise<void> {
    try {
      const loaded = await this.api.list();
      this.profiles.set(loaded.profiles);
      this.notice.set(loaded.notice);
    } catch (e) {
      // no backend (browser, tests without a fake): no connections
      console.warn('connections could not be loaded', e);
      return;
    }
    if (this.activeId() === DEMO_ID) void this.connect(DEMO_ID);
  }

  /** Makes a connection the active one and tells who listens (the tab in front takes it). */
  activate(id: string): void {
    if (!this.profiles().some((p) => p.id === id)) return;
    this.settings.update({ activeConnection: id });
    for (const listener of this.activated) listener(id);
  }

  /** Called right away, in the same turn, whenever a connection is made the active one. */
  onActivated(listener: (id: string) => void): void {
    this.activated.push(listener);
  }

  /**
   * Connects (once, however many ask). Asks for the password when the backend needs one. Resolves with
   * whether the connection is open; the reason of a failure is in the state.
   */
  connect(id: string): Promise<boolean> {
    if (this.state(id).kind === 'open') return Promise.resolve(true);
    let attempt = this.opening.get(id);
    if (!attempt) {
      attempt = this.open(id).finally(() => this.opening.delete(id));
      this.opening.set(id, attempt);
    }
    return attempt;
  }

  private async open(id: string): Promise<boolean> {
    let password: string | null = null;
    let sshSecret: string | null = null;
    let trustFingerprint: string | null = null;
    for (;;) {
      this.setState(id, { kind: 'connecting' });
      try {
        const info = await this.api.open(id, password, { secret: sshSecret, trustFingerprint });
        this.setState(id, { kind: 'open', serverVersion: info.serverVersion });
        return true;
      } catch (e) {
        const error = toAppError(e);
        const profile = this.profiles().find((p) => p.id === id);
        // the stages of the SSH tunnel come first: its host key, then what unlocks it
        if (error.code === 'host_key_unknown') {
          const shown = shownHostKey(error.message);
          const yes =
            shown !== null &&
            (await this.askHostKey({ id, host: profile?.ssh?.host ?? '', ...shown }));
          if (!yes) {
            this.setState(id, CLOSED);
            return false;
          }
          trustFingerprint = shown.fingerprint;
          continue;
        }
        if (error.code === 'ssh_secret_required') {
          sshSecret = await this.askPassword(id, sshSecret !== null, 'ssh');
          if (sshSecret === null) {
            this.setState(id, CLOSED);
            return false;
          }
          continue;
        }
        const ask =
          error.code === 'secret_required' ||
          (error.code === 'auth_failed' && !!profile && usesPassword(profile));
        if (!ask) {
          this.setState(id, { kind: 'failed', message: describeError(error) });
          return false;
        }
        password = await this.askPassword(id, error.code === 'auth_failed', 'database');
        if (password === null) {
          this.setState(
            id,
            error.code === 'auth_failed'
              ? { kind: 'failed', message: describeError(error) }
              : CLOSED,
          );
          return false;
        }
      }
    }
  }

  async disconnect(id: string): Promise<void> {
    await this.api.close(id).catch(() => undefined);
    this.setState(id, CLOSED);
  }

  /** The backend lost the connection (cancelled or broken statement): it shows as closed. */
  markClosed(id: string): void {
    if (this.state(id).kind === 'open') this.setState(id, CLOSED);
  }

  /** Stores a profile; rejects with an `AppError`. A changed open connection keeps running as it was. */
  async save(profile: Profile, password: string | null): Promise<Profile> {
    const stored = await this.api.save(profile, password);
    const others = this.profiles().filter((p) => p.id !== stored.id);
    const demo = others.filter((p) => p.id === DEMO_ID);
    const rest = [...others.filter((p) => p.id !== DEMO_ID), stored].sort(
      (a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name),
    );
    this.profiles.set([...demo, ...rest]);
    return stored;
  }

  async remove(id: string): Promise<void> {
    await this.api.delete(id);
    this.profiles.update((all) => all.filter((p) => p.id !== id));
    this.setState(id, CLOSED);
  }

  test(profile: Profile, password: string | null, ssh?: SshCredentials): Promise<string> {
    return this.api.test(profile, password, ssh);
  }

  sshHosts(): Promise<SshHost[]> {
    return this.api.sshHosts();
  }

  parseUrl(text: string): Promise<UrlDraft> {
    return this.api.parseUrl(text);
  }

  importPreview(source: ImportSource, path: string | null): Promise<ImportPreview> {
    return this.api.importPreview(source, path);
  }

  /** Stores the picked connections of a source; they join the list. */
  async importConnections(
    source: ImportSource,
    path: string | null,
    picks: readonly ImportPick[],
  ): Promise<Profile[]> {
    const stored = await this.api.importConnections(source, path, picks);
    const ids = new Set(stored.map((p) => p.id));
    this.profiles.update((all) => [...all.filter((p) => !ids.has(p.id)), ...stored]);
    return stored;
  }

  exportConnections(path: string): Promise<void> {
    return this.api.exportConnections(path);
  }

  /** The password dialog answers (`null` = cancelled). */
  answerPassword(password: string | null): void {
    this.passwordRequest.set(null);
    const waiters = this.passwordWaiters;
    this.passwordWaiters = [];
    for (const resolve of waiters) resolve(password);
  }

  /** The host key dialog answers. */
  answerHostKey(trust: boolean): void {
    this.hostKeyRequest.set(null);
    const waiter = this.hostKeyWaiter;
    this.hostKeyWaiter = null;
    waiter?.(trust);
  }

  private askHostKey(request: HostKeyRequest): Promise<boolean> {
    this.hostKeyWaiter?.(false);
    this.hostKeyRequest.set(request);
    return new Promise((resolve) => (this.hostKeyWaiter = resolve));
  }

  private askPassword(
    id: string,
    wrong: boolean,
    kind: PasswordRequest['kind'],
  ): Promise<string | null> {
    this.passwordRequest.set({ id, wrong, kind });
    return new Promise((resolve) => this.passwordWaiters.push(resolve));
  }

  private setState(id: string, state: ConnectionState): void {
    this.states.update((all) => ({ ...all, [id]: state }));
  }
}

export type { AppError };
