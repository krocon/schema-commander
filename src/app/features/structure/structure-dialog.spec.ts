import { TestBed } from '@angular/core/testing';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { HistoryApi } from '../../core/history/history-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { SessionApi } from '../../core/session/session-api';
import { QueryApi } from '../../core/sql/query-api';
import { StructureApi } from '../../core/structure/structure-api';
import {
  DEMO_PROFILE,
  FakeClipboardApi,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeHistoryApi,
  FakeQueryApi,
  FakeSchemaApi,
  FakeSessionApi,
  FakeStructureApi,
} from '../../../testing/fake-apis';
import { GuardService } from '../guard/guard.service';
import { TabsStore } from '../tabs/tabs.store';
import { StructureDialog } from './structure-dialog';
import { StructTarget, StructureService } from './structure.service';

async function settled(fixture: { whenStable(): Promise<unknown> }): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
}

describe('StructureDialog', () => {
  let api: FakeStructureApi;
  let query: FakeQueryApi;
  let schema: FakeSchemaApi;
  let connections: FakeConnectionsApi;
  let tabs: TabsStore;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    api = new FakeStructureApi();
    query = new FakeQueryApi();
    schema = new FakeSchemaApi();
    connections = new FakeConnectionsApi();
    connections.profiles = [
      { ...DEMO_PROFILE, kind: 'postgres' },
      { ...DEMO_PROFILE, id: 'ro', name: 'Prod', protection: 'readonly' },
    ];
    TestBed.configureTestingModule({
      providers: [
        { provide: StructureApi, useValue: api },
        { provide: SessionApi, useValue: new FakeSessionApi() },
        { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
        { provide: ConnectionsApi, useValue: connections },
        { provide: QueryApi, useValue: query },
        { provide: SchemaApi, useValue: schema },
        { provide: HistoryApi, useValue: new FakeHistoryApi() },
        { provide: ClipboardApi, useValue: new FakeClipboardApi() },
      ],
    });
    await TestBed.inject(ConnectionsStore).load();
    tabs = TestBed.inject(TabsStore);
    await tabs.load();
  });

  async function dialog(target: Partial<StructTarget> = {}) {
    const fixture = TestBed.createComponent(StructureDialog);
    fixture.componentRef.setInput('target', {
      connectionId: 'demo',
      schema: 'shop',
      table: 'orders',
      mode: 'edit',
      ...target,
    });
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    await settled(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string) =>
      [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes(text),
      )!;
    const type = async (input: HTMLInputElement, value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await settled(fixture);
    };
    return { fixture, el, button, type, closed: () => closed };
  }

  it('shows the table as it was read', async () => {
    const { el } = await dialog();
    expect(api.loads).toEqual(['demo/shop.orders']);
    expect(el.querySelector('h2')?.textContent).toBe('Struktur von orders');
    const names = [
      ...el.querySelectorAll<HTMLInputElement>('table:first-of-type tbody td:first-child input'),
    ];
    expect(names.map((i) => i.value)).toEqual(['id', 'note']);
    expect(el.querySelector('datalist')?.querySelectorAll('option').length).toBeGreaterThan(5);
  });

  it('sends the table before and after, shows the statements and runs them', async () => {
    const { el, button, type, closed, fixture } = await dialog();
    const note = el.querySelectorAll<HTMLInputElement>(
      'table:first-of-type tbody td:first-child input',
    )[1];
    await type(note, 'remark');
    button('Anweisungen zeigen').click();
    await settled(fixture);
    expect(api.plans[0]).toMatchObject({
      kind: 'change',
      schema: 'shop',
      renames: [{ from: 'note', to: 'remark' }],
    });
    expect(el.querySelector('.ops')?.textContent).toContain('Spalte umbenennen');
    expect(el.querySelector('.steps pre')?.textContent).toBe(
      'ALTER TABLE shop.orders ADD COLUMN x integer;',
    );
    expect(el.textContent).toContain('in einer Transaktion');
    button('Ausführen').click();
    await settled(fixture);
    expect(api.applied.length).toBe(1);
    expect(api.applied[0].request).toBe(api.plans[0]);
    expect(closed()).toBe(1);
    expect(tabs.notice()).toBe('Erledigt: 1 Anweisung.');
    // the tree reads the schema again
    expect(schema.calls.some((c) => c.startsWith('refreshNames'))).toBe(false);
  });

  it('does not run a step that may lose data before the user said so', async () => {
    api.nextPlan = {
      steps: [
        { sql: 'ALTER TABLE shop.orders DROP COLUMN note;', danger: 'the column goes', note: null },
      ],
      transactional: false,
      incomplete: false,
    };
    const { el, button, fixture } = await dialog();
    button('Anweisungen zeigen').click();
    await settled(fixture);
    expect(el.querySelector('.steps li.danger .badge')?.textContent).toBe('Kann Daten kosten');
    expect(el.textContent).toContain('für sich fest');
    expect(button('Ausführen').disabled).toBe(true);
    el.querySelector<HTMLInputElement>('.understood input')!.click();
    await settled(fixture);
    expect(button('Ausführen').disabled).toBe(false);
  });

  it('does not run a plan of which a part is not written (review 043, M3)', async () => {
    api.nextPlan = {
      steps: [
        {
          sql: 'ALTER TABLE shop.orders ALTER COLUMN note SET NOT NULL;',
          danger: null,
          note: null,
        },
        { sql: '', danger: null, note: 'the primary key differs: change it by hand' },
      ],
      transactional: true,
      incomplete: true,
    };
    const { el, button, fixture } = await dialog();
    button('Anweisungen zeigen').click();
    await settled(fixture);
    expect(el.textContent).toContain('nicht geschrieben');
    expect(button('Ausführen').disabled).toBe(true);
    expect(button('Als Skript öffnen').disabled).toBe(false);
  });

  it('asks the guard where the connection wants that, and a no runs nothing', async () => {
    query.verdict = () => ({ class: 'ddl', need: 'confirm' });
    const { button, fixture, closed } = await dialog();
    button('Anweisungen zeigen').click();
    await settled(fixture);
    const guard = TestBed.inject(GuardService);
    button('Ausführen').click();
    await settled(fixture);
    expect(guard.request()?.statements.length).toBe(1);
    guard.answer(null);
    await settled(fixture);
    expect(api.applied).toEqual([]);
    expect(closed()).toBe(0);
    // a yes: the tokens go with the request
    button('Ausführen').click();
    await settled(fixture);
    guard.answer({ typedName: null });
    await settled(fixture);
    expect(api.applied[0].confirmations.length).toBe(1);
    expect(api.applied[0].confirmations[0]).toBeTruthy();
  });

  it('says which statement failed and what stays', async () => {
    api.ran = {
      done: 0,
      failed: 0,
      error: { code: 'invalid_query', message: 'column "x" already exists' },
      transactional: true,
      rolledBack: true,
    };
    const { el, button, fixture, closed } = await dialog();
    button('Anweisungen zeigen').click();
    await settled(fixture);
    button('Ausführen').click();
    await settled(fixture);
    const outcome = el.querySelector('.outcome')?.textContent ?? '';
    expect(outcome).toContain('Anweisung 1 von 1 ist fehlgeschlagen');
    expect(outcome).toContain('already exists');
    expect(outcome).toContain('zurückgerollt');
    expect(closed()).toBe(0);
  });

  it('is off on a connection that only reads', async () => {
    const { el, button } = await dialog({ connectionId: 'ro' });
    expect(el.querySelector('[role=alert]')?.textContent).toContain('nur lesend');
    expect(button('Anweisungen zeigen').disabled).toBe(true);
  });

  it('keeps a table that makes no sense from being sent', async () => {
    const { el, button, type } = await dialog({ table: null });
    expect(el.querySelector('h2')?.textContent).toBe('Neue Tabelle in shop');
    expect(el.querySelector('.status')?.textContent).toContain('braucht einen Namen');
    expect(button('Anweisungen zeigen').disabled).toBe(true);
    await type(el.querySelector<HTMLInputElement>('.table-name input')!, 'neu');
    expect(button('Anweisungen zeigen').disabled).toBe(false);
    expect(api.loads).toEqual([]);
  });

  it('asks before a table is dropped', async () => {
    api.nextPlan = {
      steps: [{ sql: 'DROP TABLE shop.orders;', danger: 'drops the table', note: null }],
      transactional: true,
      incomplete: false,
    };
    const { el, button } = await dialog({ mode: 'drop' });
    expect(el.querySelector('h2')?.textContent).toBe('orders löschen');
    expect(api.plans[0]).toEqual({ kind: 'drop', schema: 'shop', table: 'orders' });
    expect(el.querySelector('.steps pre')?.textContent).toBe('DROP TABLE shop.orders;');
    expect(button('Ausführen').disabled).toBe(true);
    // there is no form to go back to
    expect(button('Zurück')).toBeUndefined();
  });

  it('copies a table under a name, with its rows if asked', async () => {
    const { el, button, fixture } = await dialog({ mode: 'duplicate' });
    expect(el.querySelector<HTMLInputElement>('#st-copy')?.value).toBe('orders_copy');
    el.querySelector<HTMLInputElement>('.copy .check input')!.click();
    await settled(fixture);
    button('Anweisungen zeigen').click();
    await settled(fixture);
    expect(api.plans[0]).toMatchObject({
      kind: 'duplicate',
      schema: 'shop',
      name: 'orders_copy',
      data: true,
    });
  });

  it('opens the statements as a script in a new tab', async () => {
    api.nextPlan = {
      steps: [
        { sql: 'ALTER TABLE t ADD a int;', danger: null, note: null },
        { sql: 'ALTER TABLE t DROP COLUMN b;', danger: 'the column goes', note: null },
      ],
      transactional: true,
      incomplete: false,
    };
    const { button, fixture, closed } = await dialog();
    button('Anweisungen zeigen').click();
    await settled(fixture);
    const before = tabs.tabs().length;
    button('Als Skript öffnen').click();
    await settled(fixture);
    expect(tabs.tabs().length).toBe(before + 1);
    const text = tabs.active()?.startText ?? '';
    expect(text).toContain('ALTER TABLE t ADD a int;');
    expect(text).toContain('-- DANGER: ALTER TABLE t DROP COLUMN b;');
    expect(closed()).toBe(1);
  });

  it('shows text of the database as text', async () => {
    api.table = {
      ...api.table,
      columns: [
        { name: '<img src=x onerror=alert(1)>', typeName: 'int', nullable: true, default: null },
      ],
      pk: [],
      indexes: [],
    };
    api.nextPlan = {
      steps: [{ sql: 'ALTER TABLE "<b>x</b>" ADD a int;', danger: '<i>why</i>', note: null }],
      transactional: true,
      incomplete: false,
    };
    const { el, button, fixture } = await dialog();
    button('Anweisungen zeigen').click();
    await settled(fixture);
    expect(el.querySelector('img, b:not(.ops b), i')).toBeNull();
    expect(el.querySelector('.steps pre')?.textContent).toContain('<b>x</b>');
  });

  it('says so when the table cannot be read', async () => {
    api.loadError = { code: 'not_found', message: 'no such table' };
    const { el } = await dialog();
    expect(el.querySelector('[role=alert]')?.textContent).toBeTruthy();
    expect(el.querySelector('table')).toBeNull();
  });

  it('refreshes the schema after a run', async () => {
    const service = TestBed.inject(StructureService);
    const plan = {
      steps: [{ sql: 'CREATE TABLE shop.neu (id int);', danger: null, note: null }],
      transactional: true,
      incomplete: false,
    };
    const outcome = await service.run('demo', { kind: 'drop', schema: 'shop', table: 'x' }, plan);
    expect(outcome).toEqual({ kind: 'done', statements: 1 });
    expect(query.statements).toEqual([]);
  });
});
