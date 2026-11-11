import { Injectable } from '@angular/core';
import { call } from '../backend/call';
import {
  ConnectionInfo,
  LoadedProfiles,
  Profile,
  SshCredentials,
  SshHost,
} from './connection.models';

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
  /**
   * Tries a profile without keeping the connection; resolves with the server's version. The error names
   * the stage that failed (see `open`).
   */
  abstract test(profile: Profile, password: string | null, ssh?: SshCredentials): Promise<string>;
  /**
   * Connects. Rejects by stage: `connection_failed` (SSH server or database not reachable),
   * `host_key_unknown` (the message ends with key type and fingerprint; a call that names this fingerprint
   * records it), `host_key_changed` (no way past), `ssh_secret_required` (password or passphrase of the
   * tunnel missing or wrong), `tls_failed`, `secret_required` / `auth_failed` (the database login).
   */
  abstract open(id: string, password: string | null, ssh?: SshCredentials): Promise<ConnectionInfo>;
  /** The hosts of `~/.ssh/config`, to fill in a jump host. */
  abstract sshHosts(): Promise<SshHost[]>;
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

  test(profile: Profile, password: string | null, ssh?: SshCredentials): Promise<string> {
    return call('test_connection', {
      profile,
      password,
      sshSecret: ssh?.secret ?? null,
      trustFingerprint: ssh?.trustFingerprint ?? null,
    });
  }

  open(id: string, password: string | null, ssh?: SshCredentials): Promise<ConnectionInfo> {
    return call('open_connection', {
      id,
      password,
      sshSecret: ssh?.secret ?? null,
      trustFingerprint: ssh?.trustFingerprint ?? null,
    });
  }

  sshHosts(): Promise<SshHost[]> {
    return call('ssh_config_hosts');
  }

  close(id: string): Promise<void> {
    return call('close_connection', { id });
  }
}
