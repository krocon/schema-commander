import { BackupInfo } from '../../core/backup/backup-api';
import {
  DEFAULT_DUMP,
  MAX_LINES,
  dumpTool,
  fileName,
  fitted,
  formatsOf,
  olderThanServer,
  restoreGate,
  restoreTool,
  saveFilters,
  sizeText,
  tool,
  withLine,
} from './backup-logic';

const INFO: BackupInfo = {
  tools: [
    { tool: 'pgDump', path: '/usr/bin/pg_dump', version: 'pg_dump 15.2', major: 15 },
    { tool: 'psql', path: null, version: null, major: null },
  ],
  serverMajor: 16,
};

describe('backup logic', () => {
  it('knows the tool of a database, and when there is none', () => {
    expect(dumpTool('postgres')).toBe('pgDump');
    expect(dumpTool('mysql')).toBe('mysqlDump');
    expect(dumpTool('sqlserver')).toBeNull();
    expect(dumpTool('sqlite')).toBeNull();
    expect(formatsOf('postgres')).toEqual(['sql', 'custom', 'directory']);
    expect(formatsOf('mysql')).toEqual(['sql']);
  });

  it('picks the tool that restores a file', () => {
    expect(restoreTool('postgres', 'pgCustom')).toBe('pgRestore');
    expect(restoreTool('postgres', 'pgDirectory')).toBe('pgRestore');
    expect(restoreTool('postgres', 'sqlGzip')).toBe('psql');
    expect(restoreTool('mysql', 'sql')).toBe('mysql');
    // an archive of PostgreSQL is nothing MySQL restores
    expect(restoreTool('mysql', 'pgCustom')).toBeNull();
    expect(restoreTool('sqlite', 'sql')).toBeNull();
  });

  it('warns about a tool that is older than the server', () => {
    expect(tool(INFO, 'pgDump')?.path).toBe('/usr/bin/pg_dump');
    expect(tool(INFO, 'mysql')).toBeNull();
    expect(tool(null, 'pgDump')).toBeNull();
    expect(olderThanServer(INFO, 'pgDump')).toBe(true);
    expect(olderThanServer({ ...INFO, serverMajor: 15 }, 'pgDump')).toBe(false);
    expect(olderThanServer({ ...INFO, serverMajor: null }, 'pgDump')).toBe(false);
    // a tool that is not there is not „older“
    expect(olderThanServer(INFO, 'psql')).toBe(false);
  });

  it('fits a spec to what the tool of the database can do', () => {
    const wish = {
      ...DEFAULT_DUMP,
      format: 'custom' as const,
      gzip: true,
      noOwner: true,
      schemas: ['public'],
    };
    expect(fitted('postgres', wish)).toEqual({ ...wish, gzip: false });
    expect(fitted('mysql', wish)).toEqual({
      ...wish,
      format: 'sql',
      gzip: true,
      noOwner: false,
      schemas: [],
    });
  });

  it('names the file after what is backed up and the day', () => {
    const day = new Date(2026, 10, 12);
    expect(fileName('shop', { format: 'sql', gzip: false }, day)).toBe('shop-2026-11-12.sql');
    expect(fileName('shop', { format: 'sql', gzip: true }, day)).toBe('shop-2026-11-12.sql.gz');
    expect(fileName('shop', { format: 'custom', gzip: true }, day)).toBe('shop-2026-11-12.dump');
    expect(fileName('shop', { format: 'directory', gzip: false }, day)).toBe('shop-2026-11-12');
    // nothing of a name that could be a path
    expect(fileName('../../etc/passwd', { format: 'sql', gzip: false }, day)).toBe(
      'etc_passwd-2026-11-12.sql',
    );
    expect(fileName('Größe & Co', { format: 'sql', gzip: false }, day)).toBe(
      'Größe_Co-2026-11-12.sql',
    );
    expect(fileName('///', { format: 'sql', gzip: false }, day)).toBe('backup-2026-11-12.sql');
    expect(saveFilters({ format: 'sql', gzip: true })[0].extensions).toEqual(['gz']);
    expect(saveFilters({ format: 'custom', gzip: false })[0].extensions).toEqual(['dump']);
    expect(saveFilters({ format: 'directory', gzip: false })).toEqual([]);
  });

  it('asks before a restore by the protection of the connection', () => {
    expect(restoreGate('readonly', 'Prod', 'Prod', true)).toBe('readOnly');
    expect(restoreGate('ask', 'Prod', '', true)).toBe('typeName');
    expect(restoreGate('ask', 'Prod', 'prod', true)).toBe('typeName');
    expect(restoreGate('ask', 'Prod', ' Prod ', false)).toBeNull();
    expect(restoreGate('free', 'Dev', '', false)).toBe('confirm');
    expect(restoreGate('free', 'Dev', '', true)).toBeNull();
  });

  it('keeps the newest lines of what a tool says', () => {
    let lines: string[] = [];
    for (let i = 0; i < MAX_LINES + 20; i++) lines = withLine(lines, `line ${i}`);
    expect(lines.length).toBe(MAX_LINES);
    expect(lines[0]).toBe('line 20');
    expect(lines.at(-1)).toBe(`line ${MAX_LINES + 19}`);
  });

  it('writes sizes for people', () => {
    expect(sizeText(512, 'de')).toBe('512 B');
    expect(sizeText(1536, 'de')).toBe('1,5 KB');
    expect(sizeText(3 * 1024 ** 3, 'en')).toBe('3.0 GB');
  });
});
