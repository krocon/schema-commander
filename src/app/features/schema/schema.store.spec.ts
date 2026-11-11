import { TestBed } from '@angular/core/testing';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { SchemaApi } from '../../core/schema/schema-api';
import { FakeConnectionsApi, FakeSchemaApi } from '../../../testing/fake-apis';
import { groupId, objectId, schemaId } from './schema-logic';
import { SEARCH_DELAY_MS, SchemaStore } from './schema.store';

describe('SchemaStore', () => {
  let api: FakeSchemaApi;
  let connections: ConnectionsStore;
  let store: SchemaStore;

  const settle = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    TestBed.tick();
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  const labels = () => store.rows().map((r) => `${'  '.repeat(r.level - 1)}${r.label}`);

  beforeEach(async () => {
    TestBed.resetTestingModule();
    api = new FakeSchemaApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: ConnectionsApi, useValue: new FakeConnectionsApi() },
        { provide: SchemaApi, useValue: api },
      ],
    });
    connections = TestBed.inject(ConnectionsStore);
    await connections.load();
    store = TestBed.inject(SchemaStore);
  });

  afterEach(() => vi.useRealTimers());

  async function connect() {
    await connections.connect('demo');
    await settle();
  }

  it('shows nothing while the connection is closed', async () => {
    await connections.disconnect('demo');
    await settle();
    api.calls.length = 0;
    expect(store.connected()).toBe(false);
    expect(store.rows()).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  it('reads the schemas when the connection opens and opens the current one with its tables', async () => {
    await connect();
    expect(api.calls).toEqual(['schemas', 'objects public']);
    expect(labels()).toEqual([
      'archive',
      'public',
      '  Tabellen',
      '    customer',
      '    orders',
      '  Views',
      '  Routinen',
    ]);
  });

  it('reads a schema once, when it is opened', async () => {
    await connect();
    store.toggle(schemaId('archive'));
    expect(labels()[1]).toBe('  Lädt …');
    await settle();
    expect(labels().slice(0, 3)).toEqual(['archive', '  Tabellen', '    Old Orders']);
    store.toggle(schemaId('archive'));
    store.toggle(schemaId('archive'));
    await settle();
    expect(api.calls.filter((c) => c === 'objects archive')).toHaveLength(1);
  });

  it('reads the parts of a table when it is opened', async () => {
    await connect();
    const orders = store.rows().find((r) => r.label === 'orders');
    store.toggle(orders!.id);
    await settle();
    expect(api.calls).toContain('table public.orders');
    expect(labels()).toContain('      customer_id');
    expect(labels()).toContain('        orders_pkey');
  });

  it('shows a failure at its node and keeps the rest', async () => {
    await connect();
    api.fail = { code: 'permission_denied', message: 'permission denied for schema archive' };
    store.toggle(schemaId('archive'));
    await settle();
    const rows = store.rows();
    expect(rows[1].error).toBe(true);
    expect(rows[1].label).toContain('permission denied');
    expect(labels()).toContain('    orders');
  });

  it('reads again on refresh and keeps what was open', async () => {
    await connect();
    store.toggle(schemaId('archive'));
    await settle();
    api.calls.length = 0;
    api.objectList['public'] = [
      ...api.objectList['public'],
      { kind: 'table', name: 'zebra', quoted: 'zebra', detail: '', rows: 0 },
    ];
    store.refresh();
    await settle();
    expect([...api.calls].sort()).toEqual(['objects archive', 'objects public', 'schemas']);
    expect(labels()).toContain('    zebra');
    expect(labels()).toContain('    Old Orders');
  });

  it('drops an answer that was asked before a refresh', async () => {
    await connect();
    api.hold();
    store.toggle(schemaId('archive'));
    await settle();
    const late = api.objectList['archive'];
    api.objectList = { ...api.objectList, archive: [] };
    // the old question is still on its way with the old answer
    const release = api.release.bind(api);
    store.refresh();
    release();
    await settle();
    expect(late).toHaveLength(1);
    expect(labels().slice(0, 2)).toEqual(['archive', '  leer']);
  });

  it('reads again after a statement that changes the schema, and only then', async () => {
    await connect();
    api.calls.length = 0;
    store.ran('demo', ['SELECT 1', 'UPDATE t SET a = 1']);
    await settle();
    expect(api.calls).toEqual([]);
    store.ran('demo', ['SELECT 1', 'CREATE TABLE zebra (a int)']);
    await settle();
    expect(api.calls).toContain('schemas');
    // a connection whose tree was never read has nothing to refresh
    api.calls.length = 0;
    store.ran('other', ['DROP TABLE x']);
    await settle();
    expect(api.calls).toEqual([]);
  });

  it('forgets what it read when the connection closes, but not what was open', async () => {
    await connect();
    store.toggle(schemaId('archive'));
    await settle();
    await connections.disconnect('demo');
    await settle();
    expect(store.rows()).toEqual([]);
    api.calls.length = 0;
    await connect();
    expect([...api.calls].sort()).toEqual(['objects archive', 'objects public', 'schemas']);
    expect(labels()).toContain('    Old Orders');
  });

  it('filters what is loaded at once and asks the server for the rest a little later', async () => {
    await connect();
    vi.useFakeTimers();
    api.calls.length = 0;
    store.setFilter('ord');
    expect(labels()).toEqual(['public', '  Tabellen', '    orders', '  Views', '    big_orders']);
    expect(api.calls).toEqual([]);
    store.setFilter('orde');
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS + 10);
    vi.useRealTimers();
    await settle();
    // one question, for the text that stayed
    expect(api.calls).toEqual(['search orde']);
    expect(labels().slice(0, 3)).toEqual(['archive', '  Tabellen', '    Old Orders']);
  });

  it('does not ask the server for one letter or when everything is loaded', async () => {
    await connect();
    store.toggle(schemaId('archive'));
    await settle();
    vi.useFakeTimers();
    api.calls.length = 0;
    store.setFilter('o');
    store.setFilter('ord');
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS * 3);
    expect(api.calls).toEqual([]);
  });

  it('keeps the active row by its id while the tree changes', async () => {
    await connect();
    const orders = store.rows().find((r) => r.label === 'orders')!;
    store.activeId.set(orders.id);
    store.toggle(groupId('public', 'view'));
    expect(store.activeRow()?.label).toBe('orders');
    expect(orders.id).toBe(objectId('public', { kind: 'table', name: 'orders', detail: '' }));
    store.toggle(groupId('public', 'table'));
    expect(store.activeRow()).toBeNull();
  });

  it('gives the parts of a table to a template, reading them if need be', async () => {
    await connect();
    const row = store.rows().find((r) => r.label === 'customer')!;
    const info = await store.table(row.schema!, row.object!);
    expect(info?.columns.map((c) => c.name)).toEqual(['id', 'customer_id', 'note']);
    await store.table(row.schema!, row.object!);
    expect(api.calls.filter((c) => c === 'table public.customer')).toHaveLength(1);
  });
});
