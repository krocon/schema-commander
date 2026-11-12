/** AI control over MCP (prompt 048): what is sent to the backend, the protocol, the config to copy. Pure. */
import { Profile } from '../../core/connections/connection.models';
import { McpConfig, McpLogEntry } from '../../core/mcp/mcp-api';
import { AiLevel, AiSettings } from '../../core/settings/settings.models';

/** Calls kept in the protocol. */
export const MAX_LOG = 500;

/** What the backend enforces: the settings without the switch. */
export function configOf(ai: AiSettings): McpConfig {
  return {
    defaultAccess: ai.defaultAccess,
    access: ai.access,
    maxRows: ai.maxRows,
    maxChars: ai.maxChars,
    exclude: ai.exclude,
    structureOnly: ai.structureOnly,
  };
}

/**
 * What an assistant may do on a connection – the rule of the backend (`Config::level`), for display: a
 * protected connection is off unless the user set a level, and one that only reads never writes.
 */
export function levelOf(ai: AiSettings, profile: Pick<Profile, 'id' | 'protection'>): AiLevel {
  const own = ai.access[profile.id];
  const level = own ?? (profile.protection === 'free' ? ai.defaultAccess : 'off');
  return profile.protection === 'readonly' && level === 'write' ? 'read' : level;
}

/** The levels a connection can be given. */
export function levelsFor(profile: Pick<Profile, 'protection'>): AiLevel[] {
  return profile.protection === 'readonly'
    ? ['off', 'schema', 'read']
    : ['off', 'schema', 'read', 'write'];
}

/** The settings with another level for a connection; `null`: back to the default. */
export function withLevel(ai: AiSettings, id: string, level: AiLevel | null): AiSettings {
  const access = { ...ai.access };
  if (level === null) delete access[id];
  else access[id] = level;
  return { ...ai, access };
}

/** The patterns of a text field: one per line or comma, trimmed, lower case, no doubles. */
export function patternsOf(text: string): string[] {
  const all = text
    .split(/[\n,]/)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== '' && p.length <= 64);
  return [...new Set(all)].slice(0, 100);
}

/** The protocol with one more call: newest first, at most `MAX_LOG`. */
export function withEntry(log: readonly McpLogEntry[], entry: McpLogEntry): McpLogEntry[] {
  return [entry, ...log].slice(0, MAX_LOG);
}

/** A statement on one line, for a row of the protocol. */
export function oneLine(statement: string, chars = 160): string {
  const line = statement.replace(/\s+/g, ' ').trim();
  return line.length > chars ? `${line.slice(0, chars)}…` : line;
}

/** The entry for the configuration file of an assistant (`mcpServers`). */
export function serverConfig(sidecar: string): string {
  return JSON.stringify({ mcpServers: { 'schema-commander': { command: sidecar } } }, null, 2);
}

/** The command line that adds the server to Claude Code; the path quoted for a shell. */
export function claudeCommand(sidecar: string): string {
  const quoted = /^[A-Za-z0-9_./:\\-]+$/.test(sidecar)
    ? sidecar
    : `'${sidecar.replaceAll("'", "'\\''")}'`;
  return `claude mcp add schema-commander -- ${quoted}`;
}

/** A proposal of an assistant, as the dialog shows it. */
export interface Proposal {
  readonly id: number;
  readonly connectionId: string;
  readonly sql: string;
  readonly reason: string;
  readonly writes: boolean;
}

/** Reads a request of the backend as a proposal; `null` when it is none. */
export function proposalOf(id: number, args: Readonly<Record<string, unknown>>): Proposal | null {
  const { connection, sql, reason, writes } = args;
  if (typeof connection !== 'string' || typeof sql !== 'string' || sql.trim() === '') return null;
  return {
    id,
    connectionId: connection,
    sql,
    reason: typeof reason === 'string' ? reason : '',
    writes: writes !== false,
  };
}
