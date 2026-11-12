import { Injectable } from '@angular/core';
import { Channel, isTauri } from '@tauri-apps/api/core';
import { call } from '../backend/call';
import { AiSettings } from '../settings/settings.models';

/** Mirrors `McpStatus` in src-tauri/src/commands.rs (prompt 048). */
export interface McpStatus {
  /** The bridge listens. */
  readonly running: boolean;
  /** Assistants connected right now. */
  readonly connections: number;
  /** The path of the sidecar program, for the configuration of the assistant. */
  readonly sidecar: string;
  readonly sidecarFound: boolean;
}

/** Mirrors `LogEntry` in src-tauri/src/mcp.rs: one call of an assistant. Kept in memory only. */
export interface McpLogEntry {
  readonly id: number;
  /** Milliseconds since the epoch. */
  readonly at: number;
  readonly tool: string;
  readonly connection: string;
  readonly statement: string;
  readonly rows: number | null;
  readonly ok: boolean;
  readonly code: string;
  readonly ms: number;
}

/** Mirrors `McpEvent`. */
export type McpEvent =
  | { readonly kind: 'status'; readonly connections: number }
  | { readonly kind: 'call'; readonly entry: McpLogEntry }
  | {
      readonly kind: 'request';
      readonly id: number;
      readonly tool: string;
      readonly args: Readonly<Record<string, unknown>>;
    };

/** Mirrors `Probe` in src-tauri/mcp/src/probe.rs: how far the connection test got. */
export interface McpProbe {
  readonly ok: boolean;
  readonly step: 'start' | 'initialize' | 'tools' | 'app';
  readonly code: string | null;
  readonly server: string | null;
  readonly version: string | null;
  readonly protocol: string | null;
  readonly tools: number;
  readonly app: boolean;
}

/** The part of the settings the backend enforces (`Config`). */
export type McpConfig = Omit<AiSettings, 'enabled'>;

/** AI control over MCP (prompt 048). */
export abstract class McpApi {
  abstract subscribe(onEvent: (event: McpEvent) => void): Promise<void>;
  abstract status(): Promise<McpStatus>;
  /** Turns the bridge on with what the user allows. */
  abstract start(config: McpConfig): Promise<McpStatus>;
  /** Turns it off: the port closes, every assistant is cut off. */
  abstract stop(): Promise<McpStatus>;
  abstract configure(config: McpConfig): Promise<void>;
  /** Cuts every assistant off; AI control stays on. */
  abstract disconnect(): Promise<void>;
  /** The window's answer to a request. */
  abstract reply(
    id: number,
    result: unknown,
    error?: { code: string; message: string },
  ): Promise<boolean>;
  /** Starts the sidecar like an assistant does and asks the app through it. */
  abstract test(): Promise<McpProbe>;
}

@Injectable()
export class TauriMcpApi extends McpApi {
  async subscribe(onEvent: (event: McpEvent) => void): Promise<void> {
    if (!isTauri()) return call('mcp_subscribe');
    const channel = new Channel<McpEvent>();
    channel.onmessage = onEvent;
    return call('mcp_subscribe', { onEvent: channel });
  }

  status(): Promise<McpStatus> {
    return call('mcp_status');
  }

  start(config: McpConfig): Promise<McpStatus> {
    return call('mcp_start', { config });
  }

  stop(): Promise<McpStatus> {
    return call('mcp_stop');
  }

  configure(config: McpConfig): Promise<void> {
    return call('mcp_configure', { config });
  }

  disconnect(): Promise<void> {
    return call('mcp_disconnect');
  }

  reply(id: number, result: unknown, error?: { code: string; message: string }): Promise<boolean> {
    return call('mcp_reply', { id, result: error ? null : result, error: error ?? null });
  }

  test(): Promise<McpProbe> {
    return call('mcp_test');
  }
}
