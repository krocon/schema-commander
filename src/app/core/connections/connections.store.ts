import { Injectable, computed, inject, signal } from '@angular/core';
import { AppError, describeError, toAppError } from '../errors/app-error';
import { SettingsService } from '../settings/settings.service';
import { DEMO_ID, Profile, usesPassword } from './connection.models';
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
  private passwordWaiters: ((password: string | null) => void)[] = [];
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

  activate(id: string): void {
    if (this.profiles().some((p) => p.id === id)) this.settings.update({ activeConnection: id });
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
    for (;;) {
      this.setState(id, { kind: 'connecting' });
      try {
        const info = await this.api.open(id, password);
        this.setState(id, { kind: 'open', serverVersion: info.serverVersion });
        return true;
      } catch (e) {
        const error = toAppError(e);
        const profile = this.profiles().find((p) => p.id === id);
        const ask =
          error.code === 'secret_required' ||
          (error.code === 'auth_failed' && !!profile && usesPassword(profile));
        if (!ask) {
          this.setState(id, { kind: 'failed', message: describeError(error) });
          return false;
        }
        password = await this.askPassword(id, error.code === 'auth_failed');
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

  test(profile: Profile, password: string | null): Promise<string> {
    return this.api.test(profile, password);
  }

  /** The password dialog answers (`null` = cancelled). */
  answerPassword(password: string | null): void {
    this.passwordRequest.set(null);
    const waiters = this.passwordWaiters;
    this.passwordWaiters = [];
    for (const resolve of waiters) resolve(password);
  }

  private askPassword(id: string, wrong: boolean): Promise<string | null> {
    this.passwordRequest.set({ id, wrong });
    return new Promise((resolve) => this.passwordWaiters.push(resolve));
  }

  private setState(id: string, state: ConnectionState): void {
    this.states.update((all) => ({ ...all, [id]: state }));
  }
}

export type { AppError };
