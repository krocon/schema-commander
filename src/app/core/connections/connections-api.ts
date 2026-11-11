import { Injectable } from '@angular/core';
import { call } from '../backend/call';
import { ConnectionInfo, LoadedProfiles, Profile } from './connection.models';

/**
 * Connections (prompt 003): the stored profiles and opening them. A password only ever travels towards the
 * backend (to connect, or into the keychain) – nothing here returns one.
 */
export abstract class ConnectionsApi {
  abstract list(): Promise<LoadedProfiles>;
  /** Stores a profile and returns it with its id. */
  abstract save(profile: Profile, password: string | null): Promise<Profile>;
  abstract delete(id: string): Promise<void>;
  /** Tries a profile without keeping the connection; resolves with the server's version. */
  abstract test(profile: Profile, password: string | null): Promise<string>;
  /** Connects; rejects with `secret_required` when a password is needed and none is known. */
  abstract open(id: string, password: string | null): Promise<ConnectionInfo>;
  abstract close(id: string): Promise<void>;
}

@Injectable()
export class TauriConnectionsApi extends ConnectionsApi {
  list(): Promise<LoadedProfiles> {
    return call('list_connections');
  }

  save(profile: Profile, password: string | null): Promise<Profile> {
    return call('save_connection', { profile, password });
  }

  delete(id: string): Promise<void> {
    return call('delete_connection', { id });
  }

  test(profile: Profile, password: string | null): Promise<string> {
    return call('test_connection', { profile, password });
  }

  open(id: string, password: string | null): Promise<ConnectionInfo> {
    return call('open_connection', { id, password });
  }

  close(id: string): Promise<void> {
    return call('close_connection', { id });
  }
}
