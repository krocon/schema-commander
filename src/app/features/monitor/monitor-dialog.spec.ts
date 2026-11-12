import { TestBed } from '@angular/core/testing';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { MonitorApi, ServerSession } from '../../core/monitor/monitor-api';
import { DEMO_PROFILE, FakeConnectionsApi, FakeMonitorApi } from '../../../testing/fake-apis';
import { ConfirmService } from '../../shared/confirm';
import { MonitorDialog } from './monitor-dialog';
import { MonitorService } from './monitor.service';

async function settled(fixture: { whenStable(): Promise<unknown> }): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
}

const session = (id: string, over: Partial<ServerSession> = {}): ServerSession => ({
  id,
  user: 'app',
  database: 'shop',
  application: 'psql',
  client: '10.0.0.1',
  state: 'active',
  queryMs: 1200,
  txMs: 1500,
  wait: '',
  statement: 'UPDATE orders SET paid = true',
  blockedBy: [],
  own: false,
  this: false,
  ...over,
});

describe('MonitorDialog', () => {
  let api: FakeMonitorApi;
  let monitor: MonitorService;
  let confirm: ConfirmService;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    api = new FakeMonitorApi();
    api.next = {
      ...api.next,
      sessions: [
        session('11', { user: 'anna' }),
        session('12', { user: 'bert', blockedBy: ['11'], wait: 'Lock' }),
        session('13', {
          own: true,
          this: true,
          queryMs: null,
          txMs: null,
          state: 'idle',
          statement: '',
        }),
      ],
    };
    const connections = new FakeConnectionsApi();
    connections.profiles = [
      { ...DEMO_PROFILE, id: 'pg', name: 'Shop', kind: 'postgres' },
      { ...DEMO_PROFILE, id: 'ro', name: 'Nur lesen', kind: 'postgres', protection: 'readonly' },
    ];
    TestBed.configureTestingModule({
      providers: [
        { provide: MonitorApi, useValue: api },
        { provide: ConnectionsApi, useValue: connections },
      ],
    });
    await TestBed.inject(ConnectionsStore).load();
    monitor = TestBed.inject(MonitorService);
    confirm = TestBed.inject(ConfirmService);
  });

  afterEach(() => monitor.close());

  async function open(id = 'pg') {
    monitor.open(id);
    const fixture = TestBed.createComponent(MonitorDialog);
    fixture.componentRef.setInput('connectionId', id);
    await settled(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const rows = () => [...el.querySelectorAll<HTMLTableRowElement>('tbody tr')];
    const button = (text: string) =>
      [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
    return { fixture, el, rows, button };
  }

  it('shows the sessions, the figures and who blocks whom', async () => {
    const { el, rows } = await open();
    expect(el.querySelector('h2')?.textContent).toBe('Server-Monitor: Shop');
    expect(rows().map((r) => r.cells[0].textContent.trim())).toEqual(['11', '12', '13']);
    expect(rows()[1].classList.contains('blocked')).toBe(true);
    expect(rows()[1].textContent).toContain('wartet auf 11');
    expect(rows()[2].textContent).toContain('diese App');
    expect(el.querySelector('.figures')?.textContent).toContain('3 von 100');
    const tree = [...el.querySelectorAll('.tree li')].map((li) =>
      li.textContent.replace(/\s+/g, ' ').trim(),
    );
    expect(tree).toEqual(['11 anna hält 1 Sitzung auf', '↳ 12 bert']);
  });

  it('keeps the choice and the order over a new reading', async () => {
    const { fixture, el, rows, button } = await open();
    button('Benutzer')!.click();
    button('Benutzer')!.click();
    rows()
      .find((r) => r.cells[0].textContent.trim() === '12')!
      .click();
    await settled(fixture);
    expect(el.querySelector('pre')?.textContent).toBe('UPDATE orders SET paid = true');
    api.next = {
      ...api.next,
      sessions: [
        session('12', { user: 'bert', statement: 'COMMIT' }),
        session('14', { user: 'zoe' }),
      ],
    };
    await monitor.refresh();
    await settled(fixture);
    expect(rows().map((r) => r.cells[0].textContent.trim())).toEqual(['14', '12']);
    expect(el.querySelector('tr.chosen')?.textContent).toContain('bert');
    expect(el.querySelector('pre')?.textContent).toBe('COMMIT');
    // the chosen session has gone: nothing is chosen, nothing can be ended
    api.next = { ...api.next, sessions: [session('14', { user: 'zoe' })] };
    await monitor.refresh();
    await settled(fixture);
    expect(el.querySelector('pre')).toBeNull();
    expect(button('Sitzung beenden')).toBeUndefined();
  });

  it('filters the sessions', async () => {
    const { fixture, el, rows } = await open();
    const input = el.querySelector<HTMLInputElement>('input[type=search]')!;
    input.value = 'BERT';
    input.dispatchEvent(new Event('input'));
    await settled(fixture);
    expect(rows().map((r) => r.cells[0].textContent.trim())).toEqual(['12']);
    expect(el.querySelector('caption')?.textContent.trim()).toBe('Sitzungen: 1 von 3');
  });

  it('ends a session only after the question, and says what goes', async () => {
    const { fixture, rows, button } = await open();
    rows()[0].click();
    await settled(fixture);
    button('Sitzung beenden')!.click();
    await settled(fixture);
    expect(api.kills).toEqual([]);
    const request = confirm.request()!;
    expect(request.message).toContain('anna');
    expect(request.message).toContain('UPDATE orders SET paid = true');
    confirm.answer(false);
    await settled(fixture);
    expect(api.kills).toEqual([]);

    button('Ihre Anweisung abbrechen')!.click();
    await settled(fixture);
    confirm.answer(true);
    await settled(fixture);
    expect(api.kills).toEqual([{ connectionId: 'pg', sessionId: '11', terminate: false }]);
    expect(api.readings.length).toBeGreaterThanOrEqual(2);
  });

  it('offers no way to end the session the monitor asks with', async () => {
    const { fixture, el, rows, button } = await open();
    rows()[2].click();
    await settled(fixture);
    expect(button('Sitzung beenden')).toBeUndefined();
    expect(el.querySelector('.detail')?.textContent).toContain('Monitor');
  });

  it('offers no cancelling where the server cannot, and nothing on a connection that only reads', async () => {
    api.next = { ...api.next, canCancel: false };
    const first = await open();
    first.rows()[0].click();
    await settled(first.fixture);
    expect(first.button('Ihre Anweisung abbrechen')).toBeUndefined();
    expect(first.button('Sitzung beenden')).toBeDefined();
    first.fixture.destroy();

    const second = await open('ro');
    second.rows()[0].click();
    await settled(second.fixture);
    expect(second.button('Sitzung beenden')).toBeUndefined();
    expect(second.el.querySelector('.detail')?.textContent).toContain('liest nur');
  });

  it('shows what the server says as text, never as markup', async () => {
    api.next = {
      ...api.next,
      sessions: [session('1', { user: '<b>x</b>', statement: '<img src=x onerror=alert(1)>' })],
    };
    const { fixture, el, rows } = await open();
    rows()[0].click();
    await settled(fixture);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('tbody b')).toBeNull();
    expect(el.querySelector('pre')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('says what could not be read and closes its session on the server', async () => {
    api.next = { ...api.next, missing: [{ part: 'locks', reason: 'permission denied' }] };
    const { el } = await open();
    expect(el.textContent).toContain('Nicht lesbar (Sperren): permission denied');
    monitor.close();
    expect(api.closes).toEqual(['pg']);
  });

  it('never reads twice at once and drops an answer that comes after closing', async () => {
    let release!: () => void;
    api.activity = (id: string) => {
      api.readings.push(id);
      return new Promise((resolve) => (release = () => resolve(api.next)));
    };
    monitor.open('pg');
    void monitor.refresh();
    void monitor.refresh();
    expect(api.readings).toHaveLength(1);
    monitor.close();
    release();
    await new Promise((resolve) => setTimeout(resolve));
    expect(monitor.activity()).toBeNull();
  });
});
