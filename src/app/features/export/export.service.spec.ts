import { TestBed } from '@angular/core/testing';
import { ExportApi, ExportSpec } from '../../core/backend/export-api';
import { FakeExportApi } from '../../../testing/fake-apis';
import { ExportService, ExportSource } from './export.service';

const SPEC: ExportSpec = { format: 'csv', options: {}, bom: false, gzip: false, columns: [] };
const RESULT: ExportSource = {
  kind: 'result',
  resultId: 7,
  columns: [{ name: 'id', kind: 'int', typeName: 'INT4' }],
  rows: 100,
  ranges: [[2, 5]],
  sql: 'SELECT * FROM orders',
  connectionId: 'demo',
  name: 'orders',
  table: 'orders',
};
const QUERY: ExportSource = {
  kind: 'query',
  connectionId: 'pg',
  sql: 'SELECT * FROM shop.orders',
  name: 'orders',
  table: 'shop.orders',
};

describe('ExportService', () => {
  let api: FakeExportApi;
  let exporter: ExportService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    api = new FakeExportApi();
    TestBed.configureTestingModule({ providers: [{ provide: ExportApi, useValue: api }] });
    exporter = TestBed.inject(ExportService);
  });

  it('writes a result from the store and says what came of it', async () => {
    await exporter.start(RESULT, '/tmp/out/orders.csv', SPEC, false);
    expect(api.results).toHaveLength(1);
    expect(api.results[0]).toMatchObject({
      resultId: 7,
      rows: [[2, 5]],
      path: '/tmp/out/orders.csv',
    });
    expect(api.queries).toEqual([]);
    expect(exporter.job()).toMatchObject({
      state: 'done',
      message: '5 Zeilen nach orders.csv exportiert (120 B)',
    });
    expect(exporter.running()).toBe(false);
  });

  it('runs the statement again when asked to, and always for a table of the tree', async () => {
    await exporter.start(RESULT, '/tmp/a.csv', SPEC, true);
    await exporter.start(QUERY, '/tmp/b.csv', SPEC, false);
    expect(api.results).toEqual([]);
    expect(api.queries.map((q) => [q.connectionId, q.sql])).toEqual([
      ['demo', 'SELECT * FROM orders'],
      ['pg', 'SELECT * FROM shop.orders'],
    ]);
  });

  it('shows progress while it runs, takes one export at a time and can be stopped', async () => {
    api.hold = true;
    const running = exporter.start(RESULT, 'C:\\out\\orders.csv', SPEC, false);
    await Promise.resolve();
    expect(exporter.running()).toBe(true);
    expect(exporter.job()?.message).toBe('Export nach orders.csv: 1\u202f024 Zeilen …');
    await exporter.start(QUERY, '/tmp/second.csv', SPEC, false);
    expect(api.queries).toEqual([]);
    exporter.dismiss();
    expect(exporter.job()).not.toBeNull();
    exporter.cancel();
    await running;
    expect(api.cancelled).toEqual([exporter.job()!.id]);
    expect(exporter.job()).toMatchObject({
      state: 'cancelled',
      message: 'Export nach orders.csv abgebrochen; keine Datei geschrieben.',
    });
  });

  it('says why a file could not be written', async () => {
    api.fail = { code: 'permission_denied', message: 'no permission to write „orders.csv“' };
    await exporter.start(RESULT, '/tmp/orders.csv', SPEC, false);
    const job = exporter.job()!;
    expect(job.state).toBe('failed');
    expect(job.message).toContain('Export nach orders.csv gescheitert');
    exporter.reveal();
    expect(api.revealed).toEqual([]);
  });

  it('shows the file of a finished export and forgets its message when asked to', async () => {
    await exporter.start(RESULT, '/tmp/orders.csv', SPEC, false);
    exporter.reveal();
    expect(api.revealed).toEqual(['/tmp/orders.csv']);
    exporter.dismiss();
    expect(exporter.job()).toBeNull();
  });
});
