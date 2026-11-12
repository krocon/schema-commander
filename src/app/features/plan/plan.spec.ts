import { TestBed } from '@angular/core/testing';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { Plan, PlanApi, PlanNode } from '../../core/plan/plan-api';
import { SessionApi } from '../../core/session/session-api';
import { QueryApi } from '../../core/sql/query-api';
import { ConfirmService } from '../../shared/confirm';
import {
  FakeClipboardApi,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakePlanApi,
  FakeQueryApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { GuardService } from '../guard/guard.service';
import { QueryTab } from '../tabs/query-tab';
import { PlanDialog } from './plan-dialog';
import {
  amount,
  ancestors,
  duration,
  expensive,
  factor,
  planHints,
  planRows,
  planText,
  scaleOf,
  selfShare,
} from './plan-logic';
import { PlanService } from './plan.service';

const node = (op: string, over: Partial<PlanNode> = {}): PlanNode => ({
  op,
  object: '',
  detail: '',
  estRows: null,
  actRows: null,
  cost: null,
  timeMs: null,
  selfMs: null,
  loops: null,
  buffers: null,
  extra: [],
  hints: [],
  children: [],
  ...over,
});

const PLAN: Plan = {
  nodes: [
    node('Sort', {
      estRows: 200,
      actRows: 170,
      cost: 480,
      timeMs: 12,
      selfMs: 1,
      detail: 'total DESC',
      children: [
        node('Hash Join', {
          estRows: 16000,
          actRows: 17500,
          cost: 440,
          timeMs: 11,
          selfMs: 3,
          children: [
            node('Seq Scan', {
              object: 'book',
              detail: '(price > 5)',
              estRows: 100,
              actRows: 17500,
              cost: 380,
              timeMs: 8,
              selfMs: 8,
              buffers: 'hit 130',
              hints: ['scanFilter', 'misestimate'],
              extra: [['Rows Removed by Filter', '2500']],
            }),
            node('Hash', { estRows: 200, actRows: 200, cost: 4, timeMs: 0.04, selfMs: 0.04 }),
          ],
        }),
      ],
    }),
  ],
  raw: '[{"Plan": "<b>raw</b>"}]',
  format: 'json',
  analyzed: true,
  totalMs: 12.4,
  known: true,
  cut: false,
};

describe('plan logic', () => {
  it('lays the tree out as rows and hides what is below a closed node', () => {
    const rows = planRows(PLAN.nodes, new Set());
    expect(rows.map((r) => `${r.id} ${'·'.repeat(r.depth)}${r.node.op}`)).toEqual([
      '0 Sort',
      '0.0 ·Hash Join',
      '0.0.0 ··Seq Scan',
      '0.0.1 ··Hash',
    ]);
    expect(planRows(PLAN.nodes, new Set(['0.0'])).map((r) => r.node.op)).toEqual([
      'Sort',
      'Hash Join',
    ]);
    expect(ancestors('0.0.1')).toEqual(['0', '0.0']);
    expect(ancestors('0')).toEqual([]);
  });

  it('shows what stands out', () => {
    const scale = scaleOf(PLAN);
    expect(scale).toMatchObject({ maxSelf: 8, timed: true, counted: true, buffered: true });
    const [sort, join, scan, hash] = planRows(PLAN.nodes, new Set()).map((r) => r.node);
    expect([sort, join, scan, hash].map((n) => expensive(n, scale))).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(selfShare(scan, scale)).toBe(100);
    expect(selfShare(join, scale)).toBe(38);
    // how far the estimate was off
    expect(factor(scan)).toBe('×175');
    expect(factor(sort)).toBe('');
    expect(factor(node('x', { estRows: 5000, actRows: 100 }))).toBe('÷50');
    expect(factor(node('x', { estRows: 100, actRows: 250 }))).toBe('×2,5');
    expect(factor(node('x', { estRows: 100 }))).toBe('');
    expect(planHints(PLAN).map((h) => `${h.row} ${h.hint}`)).toEqual([
      '0.0.0 scanFilter',
      '0.0.0 misestimate',
    ]);
    // a plan without times has nothing expensive
    const estimated = scaleOf({ ...PLAN, nodes: [node('Scan', { estRows: 5, cost: 1 })] });
    expect(estimated).toMatchObject({ timed: false, counted: false, buffered: false });
    expect(expensive(node('Scan'), estimated)).toBe(false);
  });

  it('writes numbers and times so they read well', () => {
    expect(amount(17500)).toBe('17.500');
    expect(amount(0.25)).toBe('0,25');
    expect(amount(3)).toBe('3');
    expect(amount(null)).toBe('');
    expect(duration(0.04)).toBe('0,04 ms');
    expect(duration(8)).toBe('8 ms');
    expect(duration(48.26)).toBe('48,3 ms');
    expect(duration(250.4)).toBe('250 ms');
    expect(duration(12_400)).toBe('12,4 s');
    expect(duration(null)).toBe('');
    expect(planText(PLAN).split('\n').slice(0, 4)).toEqual([
      'Sort  ·  est 200  ·  act 170  ·  self 1 ms  ·  total 12 ms  ·  cost 480',
      '  total DESC',
      '  Hash Join  ·  est 16.000  ·  act 17.500  ·  self 3 ms  ·  total 11 ms  ·  cost 440',
      '    Seq Scan book  ·  est 100  ·  act 17.500  ·  self 8 ms  ·  total 8 ms  ·  cost 380',
    ]);
  });
});

/** A tab that has a statement under its caret. */
const tabWith = (sql: string) =>
  ({
    currentStatement: () => Promise.resolve(sql),
    connectionId: () => 'demo',
  }) as unknown as QueryTab;

async function settled(fixture?: { whenStable(): Promise<unknown> }): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  await fixture?.whenStable();
}

describe('plans', () => {
  let api: FakePlanApi;
  let queries: FakeQueryApi;
  let clipboard: FakeClipboardApi;
  let files: FakeFileDialogApi;
  let session: FakeSessionApi;
  let plans: PlanService;

  beforeEach(async () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    TestBed.resetTestingModule();
    api = new FakePlanApi();
    api.plan = PLAN;
    queries = new FakeQueryApi();
    clipboard = new FakeClipboardApi();
    files = new FakeFileDialogApi();
    session = new FakeSessionApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: PlanApi, useValue: api },
        { provide: QueryApi, useValue: queries },
        { provide: ClipboardApi, useValue: clipboard },
        { provide: FileDialogApi, useValue: files },
        { provide: SessionApi, useValue: session },
        { provide: ConnectionsApi, useValue: new FakeConnectionsApi() },
      ],
    });
    await TestBed.inject(ConnectionsStore).load();
    plans = TestBed.inject(PlanService);
  });

  it('asks for an estimate without running or asking anything', async () => {
    await plans.show(tabWith('  SELECT 1  '), false);
    expect(api.asked).toEqual([
      { connectionId: 'demo', sql: 'SELECT 1', analyze: false, confirmation: null },
    ]);
    expect(TestBed.inject(ConfirmService).request()).toBeNull();
    expect(plans.view()).toMatchObject({ sql: 'SELECT 1', analyze: false, loading: false });
    // no statement at the caret: said, not asked
    await plans.show(tabWith('   '), false);
    expect(api.asked.length).toBe(1);
    expect(plans.view()?.error).toBe('An der Schreibmarke steht keine Anweisung.');
  });

  it('says that a plan with execution runs the statement, and asks the guard', async () => {
    const confirm = TestBed.inject(ConfirmService);
    const guard = TestBed.inject(GuardService);
    // no: nothing is asked of the database
    let done = plans.show(tabWith('UPDATE t SET a = 1'), true);
    await settled();
    expect(confirm.request()?.message).toContain('führt die Datenbank die Anweisung aus');
    confirm.answer(false);
    await done;
    expect(api.asked).toEqual([]);
    // yes, on a connection that wants a confirmation for what writes
    queries.verdict = () => ({ class: 'write', need: 'confirm' });
    done = plans.show(tabWith('UPDATE t SET a = 1'), true);
    await settled();
    confirm.answer(true);
    await settled();
    expect(guard.request()?.statements.map((s) => s.sql)).toEqual(['UPDATE t SET a = 1']);
    guard.answer({ typedName: null });
    await done;
    expect(api.asked.length).toBe(1);
    expect(api.asked[0]).toMatchObject({ sql: 'UPDATE t SET a = 1', analyze: true });
    expect(api.asked[0].confirmation).toMatch(/^token-/);
    // the guard hears a no: nothing runs
    done = plans.show(tabWith('DELETE FROM t'), true);
    await settled();
    confirm.answer(true);
    await settled();
    guard.answer(null);
    await done;
    expect(api.asked.length).toBe(1);
  });

  async function dialog() {
    await plans.show(tabWith('SELECT * FROM book'), false);
    const fixture = TestBed.createComponent(PlanDialog);
    fixture.componentRef.setInput('view', plans.view());
    await settled(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const click = async (text: string) => {
      const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
      expect(button, text).toBeDefined();
      button?.click();
      await settled(fixture);
    };
    return { fixture, el, click };
  }

  it('shows the plan as a tree with what stands out', async () => {
    const { el, click, fixture } = await dialog();
    const ops = () => [...el.querySelectorAll('tbody .op')].map((b) => b.textContent?.trim());
    expect(ops()).toEqual(['Sort', 'Hash Join', 'Seq Scan', 'Hash']);
    const scan = el.querySelectorAll('tbody tr')[2];
    expect(scan.className).toContain('costly');
    expect(scan.getAttribute('aria-level')).toBe('3');
    expect([...scan.querySelectorAll('td')].map((td) => td.textContent?.trim())).toEqual([
      'book',
      '100',
      '17.500',
      '×175',
      '8 ms',
      '8 ms',
      '380',
      'hit 130',
    ]);
    expect(scan.querySelector('.fill')?.getAttribute('style')).toContain('width: 100%');
    // closing a node hides what is below it
    el.querySelectorAll<HTMLButtonElement>('button.twist')[1].click();
    await settled(fixture);
    expect(ops()).toEqual(['Sort', 'Hash Join']);
    // a hint leads to its node, whatever is closed, and shows what the database said
    await click('Seq Scan book');
    expect(ops().length).toBe(4);
    expect(el.querySelector('tr.current .op')?.textContent?.trim()).toBe('Seq Scan');
    expect(el.querySelector('section dl')?.textContent).toContain('Rows Removed by Filter');
    expect(el.querySelector('section .mono')?.textContent).toBe('(price > 5)');
    expect(el.textContent).toContain('Hinweise, keine Urteile');
  });

  it('shows the raw plan as text, copies and saves', async () => {
    const { el, click } = await dialog();
    expect(el.querySelector('.raw')).toBeNull();
    await click('Rohplan zeigen');
    expect(el.querySelector('.raw')?.textContent).toBe('[{"Plan": "<b>raw</b>"}]');
    expect(el.querySelector('.raw b')).toBeNull();
    await click('Als Text kopieren');
    expect(clipboard.texts[0]).toContain('Seq Scan book');
    files.path = '/out/plan.json';
    await click('Rohplan speichern');
    expect(session.disk.get('/out/plan.json')?.text).toBe(PLAN.raw);
    expect(files.asked.at(-1)).toContain('plan.json');
  });

  it('shows a plan it does not understand as it came, and says why there is none', async () => {
    api.plan = { ...PLAN, known: false, nodes: [node('unknown')], raw: 'QUANTUM PLAN v9' };
    const unknown = await dialog();
    expect(unknown.el.querySelector('table')).toBeNull();
    expect(unknown.el.querySelector('.raw')?.textContent).toBe('QUANTUM PLAN v9');
    expect(unknown.el.textContent).toContain('eine Form, die die App nicht kennt');
    api.fail = { code: 'invalid_query', message: 'syntax error at or near "SELEC"' };
    const failed = await dialog();
    expect(failed.el.querySelector('.problem')?.textContent).toContain('Kein Plan');
  });
});
