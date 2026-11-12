import { translatable } from '../../core/i18n/i18n';
import { MCP_DE } from './mcp-texts.de';

/** Texts of AI control over MCP (prompt 048). English is the source. */
export const MCP_EN = {
  title: 'AI control (MCP)',
  intro:
    'An AI assistant on this computer (Claude Code and others) can read the structure of your databases, run reading queries and propose statements – only while this is on, and only as far as you allow below.',
  leaves:
    'What an assistant reads goes to the assistant and so to its provider. Allow only what may leave this computer.',
  enabled: 'AI control is on',
  off: 'Off: no port listens, no assistant can reach this app.',
  running: 'On. Only programs on this computer that can read your files can connect.',
  connected: (n: number) =>
    n === 0
      ? 'No assistant connected'
      : n === 1
        ? '1 assistant connected'
        : `${n} assistants connected`,
  disconnect: 'Disconnect',
  badge: (n: number) => (n === 1 ? 'AI connected' : `AI connected (${n})`),
  badgeHint: 'An AI assistant is connected. Open AI control.',
  setup: 'Set up the assistant',
  sidecar: 'Program of the MCP server',
  sidecarMissing: 'The program was not found next to the app. In development: pnpm mcp:dev.',
  copyCommand: 'Copy the command for Claude Code',
  copyConfig: 'Copy the entry for a config file',
  copied: 'Copied.',
  test: 'Test the connection',
  testing: 'Testing …',
  testOk: (server: string, version: string, tools: number) =>
    `Works: ${server} ${version}, ${tools} tools, and the app answered.`,
  testFailed: (step: string, code: string) => `Failed at "${step}": ${code}`,
  steps: {
    start: 'starting the program',
    initialize: 'the handshake',
    tools: 'listing the tools',
    app: 'asking the app',
  },
  limits: 'What may leave',
  structureOnly: 'Only structure, never data',
  maxRows: 'Rows per answer',
  maxChars: 'Characters per answer',
  exclude: 'Never send columns whose name contains',
  excludeHint:
    'One per line. Always hidden: password, passwd, pwd, secret, token, api_key, private_key, credential.',
  access: 'What an assistant may do, per connection',
  defaultAccess: 'Connections without protection',
  connection: 'Connection',
  level: 'Access',
  levels: {
    off: 'off',
    schema: 'structure only',
    read: 'reading queries',
    write: 'writing as a proposal',
  },
  byDefault: (level: string) => `default (${level})`,
  protectedHint: 'protected: off unless you say otherwise',
  log: 'Protocol',
  logHint: 'Every call of an assistant since the app started. Kept in memory only.',
  logEmpty: 'No calls yet.',
  clearLog: 'Empty the protocol',
  columns: {
    time: 'Time',
    tool: 'Tool',
    connection: 'Connection',
    statement: 'Statement',
    rows: 'Rows',
    outcome: 'Outcome',
  },
  ok: 'ok',
  close: 'Close',
  proposalTitle: 'An AI assistant proposes a statement',
  proposalWrites: 'This statement changes data or structure.',
  proposalReads: 'This statement only reads.',
  proposalOn: (connection: string) => `On: ${connection}`,
  proposalReason: 'Its reason, in its own words',
  proposalNote:
    'Read the statement itself: the reason is what the assistant says, not what the statement does. It runs like one you typed, with the safeguards of the connection.',
  run: 'Run it',
  toTab: 'Only open in a tab',
  decline: 'Decline',
  unknownConnection: 'this connection is not known any more',
};

export type McpTexts = typeof MCP_EN;
export const MCP_TEXTS = translatable('mcp', MCP_EN, { de: MCP_DE });
