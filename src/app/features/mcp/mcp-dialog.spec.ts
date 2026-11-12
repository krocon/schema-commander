import { TestBed } from '@angular/core/testing';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { HistoryApi } from '../../core/history/history-api';
import { McpApi } from '../../core/mcp/mcp-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { SessionApi } from '../../core/session/session-api';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import {
  DEMO_PROFILE,
  FakeClipboardApi,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeHistoryApi,
  FakeMcpApi,
  FakeQueryApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { TabsStore } from '../tabs/tabs.store';
import { McpDialog } from './mcp-dialog';
import { McpProposalDialog, READY_MS } from './mcp-proposal-dialog';
import { McpService } from './mcp.service';

async function settled(fixture?: { whenStable(): Promise<unknown> }): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture?.whenStable();
  }
}

describe('AI control (MCP)', () => {
  let api: FakeMcpApi;
  let clipboard: FakeClipboardApi;
  let query: FakeQueryApi;
  let mcp: McpService;
  let settings: SettingsService;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    api = new FakeMcpApi();
    clipboard = new FakeClipboardApi();
    query = new FakeQueryApi();
    const connections = new FakeConnectionsApi();
    connections.profiles = [
      { ...DEMO_PROFILE, id: 'dev', name: 'Dev', kind: 'postgres' },
      { ...DEMO_PROFILE, id: 'prod', name: 'Prod', kind: 'postgres', protection: 'ask' },
    ];
    TestBed.configureTestingModule({
      providers: [
        { provide: McpApi, useValue: api },
        { provide: SessionApi, useValue: new FakeSessionApi() },
        { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
        { provide: ConnectionsApi, useValue: connections },
        { provide: QueryApi, useValue: query },
        { provide: SchemaApi, useValue: new FakeSchemaApi() },
        { provide: HistoryApi, useValue: new FakeHistoryApi() },
        { provide: ClipboardApi, useValue: clipboard },
      ],
    });
    const store = TestBed.inject(ConnectionsStore);
    await store.load();
    await store.connect('dev');
    settings = TestBed.inject(SettingsService);
    mcp = TestBed.inject(McpService);
  });

  async function open() {
    const fixture = TestBed.createComponent(McpDialog);
    await settled(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string) =>
      [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
    return { fixture, el, button };
  }

  it('is off at the start: nothing is started', async () => {
    await mcp.init();
    expect(api.started).toEqual([]);
    expect(mcp.status().running).toBe(false);
    const { el } = await open();
    expect(el.textContent).toContain('Kein Port lauscht');
    expect(el.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
  });

  it('turns on and off, remembers it, and starts again with the app', async () => {
    const { fixture, el } = await open();
    const box = el.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    box.click();
    await settled(fixture);
    expect(api.started).toHaveLength(1);
    expect(settings.settings().ai.enabled).toBe(true);
    expect(el.textContent).toContain('Kein Assistent verbunden');
    // the app starts again: on, because the user had it on
    await mcp.init();
    expect(api.started).toHaveLength(2);
    box.click();
    await settled(fixture);
    expect(api.stops).toBe(1);
    expect(settings.settings().ai.enabled).toBe(false);
  });

  it('sends every change of the rules to the backend', async () => {
    const { fixture, el } = await open();
    const prod = el.querySelector<HTMLSelectElement>('select[aria-label="Prod"]')!;
    // a protected connection is off by default, and says so
    expect(prod.selectedOptions[0].textContent.trim()).toBe('Vorgabe (aus)');
    prod.value = 'read';
    prod.dispatchEvent(new Event('change'));
    await settled(fixture);
    expect(api.configured.at(-1)?.access).toEqual({ prod: 'read' });
    const area = el.querySelector('textarea')!;
    area.value = 'IBAN\nsalary';
    area.dispatchEvent(new Event('change'));
    await settled(fixture);
    expect(api.configured.at(-1)?.exclude).toEqual(['iban', 'salary']);
    expect(settings.settings().ai.access).toEqual({ prod: 'read' });
  });

  it('says so when the backend did not take the new rules', async () => {
    await mcp.setEnabled(true);
    api.failConfigure = { code: 'unsupported', message: 'no' };
    await mcp.update({ ...mcp.ai(), structureOnly: true });
    expect(mcp.problem()).not.toBe('');
  });

  it('copies the configuration and tests the connection', async () => {
    await mcp.setEnabled(true);
    const { fixture, el, button } = await open();
    button('Befehl für Claude Code kopieren')!.click();
    await settled(fixture);
    expect(clipboard.texts.at(-1)).toContain("claude mcp add schema-commander -- '/Applications/");
    button('Verbindung testen')!.click();
    await settled(fixture);
    expect(el.textContent).toContain('Geht: schema-commander 0.1.0, 8 Werkzeuge');
    api.probe = { ...api.probe, ok: false, step: 'app', code: 'not_running' };
    button('Verbindung testen')!.click();
    await settled(fixture);
    expect(el.textContent).toContain('Gescheitert bei „Frage an die App“: not_running');
  });

  it('shows who is connected, cuts them off, and keeps the protocol', async () => {
    await mcp.setEnabled(true);
    const { fixture, el, button } = await open();
    api.emit({ kind: 'status', connections: 1 });
    api.emit({
      kind: 'call',
      entry: {
        id: 1,
        at: Date.UTC(2026, 10, 12, 10, 0, 0),
        tool: 'run_query',
        connection: 'dev',
        statement: '<img src=x onerror=alert(1)> SELECT 1',
        rows: 3,
        ok: true,
        code: '',
        ms: 4,
      },
    });
    api.emit({
      kind: 'call',
      entry: {
        id: 2,
        at: Date.UTC(2026, 10, 12, 10, 0, 1),
        tool: 'run_query',
        connection: 'prod',
        statement: 'DELETE FROM t',
        rows: null,
        ok: false,
        code: 'access_denied',
        ms: 0,
      },
    });
    await settled(fixture);
    expect(el.textContent).toContain('1 Assistent verbunden');
    const rows = [...el.querySelectorAll('table.log tbody tr')];
    // newest first; names of connections instead of ids; a statement is text, not markup
    expect(rows[0].textContent).toContain('Prod');
    expect(rows[0].textContent).toContain('access_denied');
    expect(rows[1].textContent).toContain('<img src=x onerror=alert(1)> SELECT 1');
    expect(el.querySelector('table.log img')).toBeNull();
    button('Trennen')!.click();
    expect(api.disconnects).toBe(1);
    button('Protokoll leeren')!.click();
    await settled(fixture);
    expect(mcp.log()).toEqual([]);
  });

  it('puts text into a tab without running anything', async () => {
    await mcp.setEnabled(true);
    api.emit({
      kind: 'request',
      id: 5,
      tool: 'write_to_tab',
      args: { text: 'DELETE FROM t', connection: 'dev' },
    });
    await settled();
    const tab = TestBed.inject(TabsStore).tabs().at(-1)!;
    expect(tab.startText).toBe('DELETE FROM t');
    expect(query.statements).toEqual([]);
    expect(api.replies).toEqual([{ id: 5, result: { opened: true } }]);
  });

  it('shows a proposal and runs it only after the click', async () => {
    await mcp.setEnabled(true);
    api.emit({
      kind: 'request',
      id: 9,
      tool: 'propose_query',
      args: {
        connection: 'dev',
        sql: 'UPDATE t SET a = 1',
        reason: '<b>trust me</b>',
        writes: true,
      },
    });
    await settled();
    const proposal = mcp.proposal()!;
    const fixture = TestBed.createComponent(McpProposalDialog);
    fixture.componentRef.setInput('proposal', proposal);
    fixture.componentRef.setInput('connection', mcp.connectionName(proposal));
    await settled(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('pre')?.textContent).toBe('UPDATE t SET a = 1');
    expect(el.textContent).toContain('Auf: Dev');
    expect(el.textContent).toContain('ändert Daten oder Struktur');
    // the reason is the assistant's text: shown as text
    expect(el.querySelector('.reason')?.textContent).toBe('<b>trust me</b>');
    expect(el.querySelector('.reason b')).toBeNull();
    // nothing ran, nothing was answered yet
    expect(query.statements).toEqual([]);
    expect(api.replies).toEqual([]);
    await mcp.answer('run');
    await settled();
    expect(query.statements.map((r) => r.sql)).toEqual(['UPDATE t SET a = 1']);
    expect(api.replies[0].id).toBe(9);
    expect(api.replies[0].result).toMatchObject({ accepted: true, ran: true });
    expect(mcp.proposal()).toBeNull();
  });

  it('declines a proposal, or only opens it, without running', async () => {
    await mcp.setEnabled(true);
    const propose = (id: number) =>
      api.emit({
        kind: 'request',
        id,
        tool: 'propose_query',
        args: { connection: 'dev', sql: 'DROP TABLE t', reason: '', writes: true },
      });
    propose(1);
    propose(2);
    await settled();
    // one at a time, in their order
    expect(mcp.proposal()?.id).toBe(1);
    await mcp.answer('decline');
    expect(mcp.proposal()?.id).toBe(2);
    await mcp.answer('tab');
    await settled();
    expect(query.statements).toEqual([]);
    expect(api.replies).toEqual([
      { id: 1, result: { accepted: false } },
      { id: 2, result: { accepted: false, opened_in_tab: true } },
    ]);
    expect(TestBed.inject(TabsStore).tabs().at(-1)!.startText).toBe('DROP TABLE t');
  });

  it('keeps "run" off for a moment, says what destroys, and makes a dialog per proposal', async () => {
    const make = async (id: number, sql: string, dangerous: boolean) => {
      const fixture = TestBed.createComponent(McpProposalDialog);
      fixture.componentRef.setInput('proposal', {
        id,
        connectionId: 'dev',
        sql,
        reason: '',
        writes: true,
        dangerous,
        at: Date.now(),
      });
      fixture.componentRef.setInput('connection', 'Dev');
      await settled(fixture);
      return fixture;
    };
    const fixture = await make(
      1,
      Array.from({ length: 30 }, () => 'DROP TABLE t;').join('\n'),
      true,
    );
    const el = fixture.nativeElement as HTMLElement;
    const run = [...el.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Ausführen',
    )!;
    // a click that was meant for the dialog before lands on nothing
    expect(run.disabled).toBe(true);
    expect(el.textContent).toContain('zerstört oder gibt weg');
    expect(el.textContent).toContain('30 Zeilen');
    await new Promise((resolve) => setTimeout(resolve, READY_MS + 50));
    await settled(fixture);
    expect(run.disabled).toBe(false);
    // the list the app draws from holds one proposal at a time, each with its own id
    await mcp.setEnabled(true);
    for (const id of [11, 12]) {
      api.emit({
        kind: 'request',
        id,
        tool: 'propose_query',
        args: { connection: 'dev', sql: 'DELETE FROM t' },
      });
    }
    await settled();
    expect(mcp.shownProposals().map((p) => p.id)).toEqual([11]);
    await mcp.answer('decline');
    expect(mcp.shownProposals().map((p) => p.id)).toEqual([12]);
  });

  it('does not run a proposal nobody waits for any more, and tells the assistant little of an error', async () => {
    await mcp.setEnabled(true);
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now');
    spy.mockReturnValue(now);
    api.emit({
      kind: 'request',
      id: 21,
      tool: 'propose_query',
      args: { connection: 'dev', sql: 'DELETE FROM t' },
    });
    await settled();
    spy.mockReturnValue(now + 301_000);
    await mcp.answer('run');
    await settled();
    spy.mockRestore();
    expect(query.statements).toEqual([]);
    expect(api.replies.at(-1)).toEqual({ id: 21, result: { accepted: false } });
    expect(mcp.problem()).toContain('wartet nicht mehr');
    // an error goes back cut; with "structure only" just that there was one
    query.error = { code: 'invalid_query', message: `secret-${'x'.repeat(1000)}` };
    api.emit({
      kind: 'request',
      id: 22,
      tool: 'propose_query',
      args: { connection: 'dev', sql: 'SELECT boom()' },
    });
    await settled();
    await mcp.answer('run');
    await settled();
    const first = api.replies.at(-1)!.result as { error: string };
    expect(first.error.length).toBeLessThanOrEqual(300);
    await mcp.update({ ...mcp.ai(), structureOnly: true });
    api.emit({
      kind: 'request',
      id: 23,
      tool: 'propose_query',
      args: { connection: 'dev', sql: 'SELECT boom()' },
    });
    await settled();
    await mcp.answer('run');
    await settled();
    expect((api.replies.at(-1)!.result as { error: string }).error).toBe('the statement failed');
  });

  it('opens no more than twenty tabs for an assistant', async () => {
    await mcp.setEnabled(true);
    for (let id = 1; id <= 21; id++) {
      api.emit({ kind: 'request', id, tool: 'write_to_tab', args: { text: 'SELECT 1' } });
    }
    await settled();
    expect(api.replies.filter((r) => !r.error)).toHaveLength(20);
    expect(api.replies.at(-1)?.error?.code).toBe('limit_exceeded');
  });

  it('answers what it does not understand, and forgets proposals when turned off', async () => {
    await mcp.setEnabled(true);
    api.emit({ kind: 'request', id: 3, tool: 'propose_query', args: { sql: 'x' } });
    api.emit({ kind: 'request', id: 4, tool: 'run_shell', args: {} });
    await settled();
    expect(api.replies.map((r) => r.error?.code)).toEqual(['invalid_args', 'invalid_args']);
    api.emit({
      kind: 'request',
      id: 6,
      tool: 'propose_query',
      args: { connection: 'dev', sql: 'DELETE FROM t' },
    });
    await settled();
    expect(mcp.proposal()).not.toBeNull();
    await mcp.setEnabled(false);
    expect(mcp.proposal()).toBeNull();
  });
});
