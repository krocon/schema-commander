import { McpLogEntry } from '../../core/mcp/mcp-api';
import { DEFAULT_AI, readAi } from '../../core/settings/settings.models';
import {
  MAX_LOG,
  PROPOSAL_MS,
  claudeCommand,
  configOf,
  expired,
  levelOf,
  levelsFor,
  lineCount,
  oneLine,
  patternsOf,
  proposalOf,
  serverConfig,
  withEntry,
  withLevel,
} from './mcp-logic';

const entry = (id: number): McpLogEntry => ({
  id,
  at: 0,
  tool: 'run_query',
  connection: 'pg',
  statement: 'SELECT 1',
  rows: 1,
  ok: true,
  code: '',
  ms: 3,
});

describe('mcp-logic', () => {
  it('is off for everything until the user says otherwise', () => {
    expect(DEFAULT_AI.enabled).toBe(false);
    expect(levelOf(DEFAULT_AI, { id: 'dev', protection: 'free' })).toBe('off');
    const open = {
      ...DEFAULT_AI,
      defaultAccess: 'read' as const,
      access: { ro: 'write' as const },
    };
    // the default counts only where there is no protection
    expect(levelOf(open, { id: 'dev', protection: 'free' })).toBe('read');
    expect(levelOf(open, { id: 'prod', protection: 'ask' })).toBe('off');
    expect(levelOf(open, { id: 'other', protection: 'readonly' })).toBe('off');
    // a connection that only reads never writes, whatever was set
    expect(levelOf(open, { id: 'ro', protection: 'readonly' })).toBe('read');
    expect(levelsFor({ protection: 'readonly' })).toEqual(['off', 'schema', 'read']);
    expect(levelsFor({ protection: 'ask' })).toContain('write');
  });

  it('sets and takes back the level of a connection', () => {
    const set = withLevel(DEFAULT_AI, 'pg', 'schema');
    expect(set.access).toEqual({ pg: 'schema' });
    expect(withLevel(set, 'pg', null).access).toEqual({});
    expect(DEFAULT_AI.access).toEqual({});
  });

  it('sends the backend the rules without the switch', () => {
    const config = configOf({ ...DEFAULT_AI, enabled: true, maxRows: 50 });
    expect(config).toEqual({
      defaultAccess: 'off',
      access: {},
      maxRows: 50,
      maxChars: 100_000,
      exclude: [],
      structureOnly: false,
    });
    expect('enabled' in config).toBe(false);
  });

  it('reads stored settings strictly: what is wrong is off', () => {
    expect(readAi(null)).toEqual(DEFAULT_AI);
    expect(readAi({ enabled: 'yes', defaultAccess: 'all' })).toEqual(DEFAULT_AI);
    const read = readAi({
      enabled: true,
      defaultAccess: 'schema',
      access: { pg: 'read', 'bad id!': 'write', x: 'everything' },
      maxRows: 99_999,
      maxChars: 5,
      exclude: [' IBAN ', 7, ''],
      structureOnly: true,
    });
    expect(read).toEqual({
      enabled: true,
      defaultAccess: 'schema',
      access: { pg: 'read' },
      maxRows: 1000,
      maxChars: 1000,
      exclude: ['iban'],
      structureOnly: true,
    });
  });

  it('reads the patterns of a text field', () => {
    expect(patternsOf(' IBAN \n\nsalary, iban\n')).toEqual(['iban', 'salary']);
  });

  it('keeps the newest calls first and no more than the limit', () => {
    let log: McpLogEntry[] = [];
    for (let i = 1; i <= MAX_LOG + 5; i++) log = withEntry(log, entry(i));
    expect(log).toHaveLength(MAX_LOG);
    expect(log[0].id).toBe(MAX_LOG + 5);
    expect(oneLine('SELECT 1\n   FROM t')).toBe('SELECT 1 FROM t');
    expect(oneLine('x'.repeat(200), 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('writes the configuration for an assistant', () => {
    const path = '/Applications/Schema Commander.app/Contents/MacOS/schema-commander-mcp';
    expect(JSON.parse(serverConfig(path))).toEqual({
      mcpServers: { 'schema-commander': { command: path } },
    });
    expect(claudeCommand('/usr/bin/schema-commander-mcp')).toBe(
      'claude mcp add schema-commander -- /usr/bin/schema-commander-mcp',
    );
    // a path with spaces or a quote stays one word of the shell
    expect(claudeCommand(path)).toBe(`claude mcp add schema-commander -- '${path}'`);
    expect(claudeCommand("/a/it's/x")).toBe(`claude mcp add schema-commander -- '/a/it'\\''s/x'`);
  });

  it('reads a proposal and nothing else', () => {
    expect(
      proposalOf(7, { connection: 'pg', sql: 'DELETE FROM t', reason: 'why', writes: true }, 1000),
    ).toEqual({
      id: 7,
      connectionId: 'pg',
      sql: 'DELETE FROM t',
      reason: 'why',
      writes: true,
      dangerous: false,
      at: 1000,
    });
    const old = proposalOf(7, { connection: 'pg', sql: 'x', dangerous: true }, 1000)!;
    expect(old.dangerous).toBe(true);
    expect(expired(old, 1000 + PROPOSAL_MS)).toBe(false);
    expect(expired(old, 1001 + PROPOSAL_MS)).toBe(true);
    expect(lineCount('a\nb\nc')).toBe(3);
    // what is not said to only read counts as writing
    expect(proposalOf(7, { connection: 'pg', sql: 'x' })?.writes).toBe(true);
    expect(proposalOf(7, { connection: 'pg', sql: '  ' })).toBeNull();
    expect(proposalOf(7, { sql: 'SELECT 1' })).toBeNull();
    expect(proposalOf(7, { connection: 1, sql: 'SELECT 1' })).toBeNull();
  });
});
