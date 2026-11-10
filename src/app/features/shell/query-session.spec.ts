import { TestBed } from '@angular/core/testing';
import { QueryApi } from '../../core/sql/query-api';
import { FakeQueryApi } from '../../../testing/fake-apis';
import { QuerySession, statusText } from './query-session';

describe('QuerySession', () => {
  let api: FakeQueryApi;
  let session: QuerySession;

  beforeEach(() => {
    api = new FakeQueryApi();
    TestBed.configureTestingModule({ providers: [{ provide: QueryApi, useValue: api }] });
    session = TestBed.inject(QuerySession);
  });

  it('shows the rows of a statement', async () => {
    await session.run('select 1');
    const state = session.state();
    expect(state.kind).toBe('done');
    expect(api.statements).toEqual(['select 1']);
    expect(statusText(state)).toBe('2 Zeilen · 3 ms');
  });

  it('shows the message of the engine on an error', async () => {
    api.error = { code: 'invalid_query', message: 'near "selec": syntax error' };
    await session.run('selec 1');
    expect(session.state()).toEqual({
      kind: 'failed',
      sql: 'selec 1',
      message: 'near "selec": syntax error',
    });
  });

  it('drops the answer of an older statement', async () => {
    const first = session.run('select 1');
    api.result = { ...api.result, rows: [[9, 'late']] };
    const second = session.run('select 2');
    await Promise.all([first, second]);
    const state = session.state();
    expect(state.kind === 'done' && state.sql).toBe('select 2');
  });

  it('describes changed rows and cut off results', () => {
    const base = api.result;
    expect(
      statusText({ kind: 'done', sql: '', result: { ...base, rows: [], rowsAffected: 1 } }),
    ).toBe('1 Zeile geändert · 3 ms');
    expect(statusText({ kind: 'done', sql: '', result: { ...base, truncated: true } })).toBe(
      '2 Zeilen (abgeschnitten) · 3 ms',
    );
    expect(statusText({ kind: 'idle' })).toBe('Bereit');
  });
});
