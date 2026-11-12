import { Injectable } from '@angular/core';
import { call } from '../backend/call';

/** Mirrors `SessionRow` in src-tauri/src/db/monitor.rs (prompt 046): a session on the server. */
export interface ServerSession {
  readonly id: string;
  readonly user: string;
  readonly database: string;
  readonly application: string;
  readonly client: string;
  /** In the words of the server (`active`, `idle in transaction`, `Sleep`). */
  readonly state: string;
  /** How long its statement runs; `null`: it runs none. */
  readonly queryMs: number | null;
  /** How long its transaction is open; `null`: none, or the server does not say. */
  readonly txMs: number | null;
  readonly wait: string;
  /** Its statement, as far as the server shows it – data of whoever runs it. */
  readonly statement: string;
  /** The sessions it waits for. */
  readonly blockedBy: readonly string[];
  /** A session of this app. */
  readonly own: boolean;
  /** The session the monitor itself asks with. */
  readonly this: boolean;
}

/** Mirrors `Figures`. */
export interface ServerFigures {
  readonly version: string;
  readonly connections: number | null;
  readonly maxConnections: number | null;
  /** Since the server started: a rate needs two readings. */
  readonly transactions: number | null;
  readonly databaseBytes: number | null;
  readonly uptimeS: number | null;
}

/** Mirrors `Activity`: one reading. */
export interface ServerActivity {
  readonly sessions: readonly ServerSession[];
  readonly figures: ServerFigures;
  readonly cut: boolean;
  /** Parts that could not be read, with what the server said. */
  readonly missing: readonly { readonly part: string; readonly reason: string }[];
  /** A statement can be cancelled without ending its session. */
  readonly canCancel: boolean;
}

/** What happens on a server, and ending a statement or session there (prompt 046). */
export abstract class MonitorApi {
  /** Rejects with `unsupported` for a database without a server (SQLite). */
  abstract activity(connectionId: string): Promise<ServerActivity>;
  /**
   * Cancels the statement of a session, or ends the session (`terminate`). `false`: there was nothing to
   * end any more. `permission_denied` on a connection that only reads, or when the server refuses.
   */
  abstract kill(connectionId: string, sessionId: string, terminate: boolean): Promise<boolean>;
  /** The monitor was closed: its own session on the server goes. */
  abstract close(connectionId: string): Promise<void>;
}

@Injectable()
export class TauriMonitorApi extends MonitorApi {
  activity(connectionId: string): Promise<ServerActivity> {
    return call('monitor_activity', { id: connectionId });
  }

  kill(connectionId: string, sessionId: string, terminate: boolean): Promise<boolean> {
    return call('monitor_kill', { id: connectionId, sessionId, terminate });
  }

  close(connectionId: string): Promise<void> {
    return call('monitor_close', { id: connectionId });
  }
}
