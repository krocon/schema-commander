import { TestBed } from '@angular/core/testing';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ChartApi } from '../../core/chart/chart-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { SessionApi } from '../../core/session/session-api';
import { QueryColumn } from '../../core/sql/query.models';
import {
  FakeChartApi,
  FakeClipboardApi,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeQueryApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { QueryTab } from '../tabs/query-tab';
import { ChartPanel } from './chart-panel';

const COLUMNS: QueryColumn[] = [
  { name: 'id', kind: 'int', typeName: 'INT4' },
  { name: 'name', kind: 'text', typeName: 'TEXT' },
  { name: 'amount', kind: 'decimal', typeName: 'NUMERIC' },
];

async function settled(fixture: { whenStable(): Promise<unknown> }): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
}

describe('ChartPanel', () => {
  let api: FakeChartApi;
  let clipboard: FakeClipboardApi;
  let session: FakeSessionApi;
  let files: FakeFileDialogApi;
  let tab: QueryTab;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    api = new FakeChartApi();
    clipboard = new FakeClipboardApi();
    session = new FakeSessionApi();
    files = new FakeFileDialogApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: ChartApi, useValue: api },
        { provide: ClipboardApi, useValue: clipboard },
        { provide: SessionApi, useValue: session },
        { provide: FileDialogApi, useValue: files },
        { provide: ConnectionsApi, useValue: new FakeConnectionsApi() },
      ],
    });
    const store = TestBed.inject(ConnectionsStore);
    await store.load();
    tab = new QueryTab(
      {
        id: 't',
        title: 'T',
        customTitle: false,
        connection: 'demo',
        filePath: null,
        encoding: null,
      },
      {
        api: new FakeQueryApi(),
        connections: store,
        options: () => ({ stopOnError: true, timeoutMs: 0 }),
      },
    );
    // jsdom lays nothing out: the area of the chart gets a size
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 640,
      height: 320,
      left: 0,
      top: 0,
      right: 640,
      bottom: 320,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  });

  afterEach(() => vi.restoreAllMocks());

  async function panel(inputs: Record<string, unknown> = {}) {
    const fixture = TestBed.createComponent(ChartPanel);
    fixture.componentRef.setInput('tab', tab);
    fixture.componentRef.setInput('result', { resultId: 7, columns: COLUMNS });
    fixture.componentRef.setInput('rows', 3);
    for (const [key, value] of Object.entries(inputs)) fixture.componentRef.setInput(key, value);
    await settled(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('asks for a suggestion and draws it', async () => {
    const { el } = await panel();
    expect(tab.chartSpec()).toEqual(api.suggestion);
    expect(api.prepared.map((p) => [p.resultId, p.width])).toEqual([[7, 640]]);
    const svg = el.querySelector('svg[role=img]')!;
    expect(svg.getAttribute('aria-label')).toBe(
      'Linie-Diagramm von name; 3 Punkte. name: von 10 bis 30.',
    );
    // a NULL is a gap: two stretches, each a single point
    const line = el.querySelector('svg[role=img] path.line')!;
    expect(line.getAttribute('d')?.match(/M/g)?.length).toBe(2);
    expect(el.querySelector('.notes')?.textContent).toContain('1 NULL-Werte sind Lücken');
    expect(el.querySelector('.legend button')?.textContent?.trim()).toBe('name');
  });

  it('keeps the spec of the tab, and reads again when it changes', async () => {
    tab.chartSpec.set({ kind: 'bar', x: 1, ys: [2], group: null, agg: 'avg', sort: 'none' });
    const { fixture, el } = await panel();
    expect(api.prepared[0].spec.kind).toBe('bar');
    const kind = el.querySelector<HTMLSelectElement>('select')!;
    kind.value = 'scatter';
    kind.dispatchEvent(new Event('change'));
    await settled(fixture);
    expect(api.prepared.map((p) => p.spec.kind)).toEqual(['bar', 'scatter']);
    // the chart before is not kept
    expect(api.freed).toEqual([1]);
  });

  it('asks for a new suggestion when the spec does not fit the result', async () => {
    tab.chartSpec.set({ kind: 'line', x: 9, ys: [12], group: null, agg: 'sum', sort: 'none' });
    await panel();
    expect(tab.chartSpec()).toEqual(api.suggestion);
  });

  it('says so when nothing can be drawn', async () => {
    api.suggestion = null;
    const { el } = await panel();
    expect(el.querySelector('.notes')?.textContent).toContain('braucht eine Spalte mit Zahlen');
    expect(el.querySelector('svg[role=img]')).toBeNull();
    expect(api.prepared).toEqual([]);
  });

  it('waits for the statement to end', async () => {
    const { fixture, el } = await panel({ settled: false });
    expect(api.prepared).toEqual([]);
    expect(el.querySelector('.notes')?.textContent).toContain('wenn die Anweisung beendet ist');
    fixture.componentRef.setInput('settled', true);
    await settled(fixture);
    expect(api.prepared.length).toBe(1);
  });

  it('zooms through the backend without reading the result again', async () => {
    const { fixture, el } = await panel();
    const zoomIn = el.querySelector<HTMLButtonElement>('.zoom button')!;
    zoomIn.click();
    await settled(fixture);
    expect(api.zooms).toEqual([{ chartId: 1, range: [1.5, 2.5], width: 640 }]);
    expect(api.prepared.length).toBe(1);
    const reset = [...el.querySelectorAll<HTMLButtonElement>('.zoom button')].at(-1)!;
    reset.click();
    await settled(fixture);
    expect(api.zooms.at(-1)?.range).toBeNull();
  });

  it('prepares again when the backend no longer has the chart', async () => {
    const { fixture, el } = await panel();
    api.zoomError = { code: 'unknown_result', message: 'gone' };
    el.querySelector<HTMLButtonElement>('.zoom button')!.click();
    await settled(fixture);
    expect(api.prepared.length).toBe(2);
    expect(el.querySelector('.error')).toBeNull();
  });

  it('hides and shows a series', async () => {
    const { fixture, el } = await panel();
    const button = el.querySelector<HTMLButtonElement>('.legend button')!;
    button.click();
    await settled(fixture);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelector('svg[role=img] path.line')).toBeNull();
  });

  it('shows names of the result as text', async () => {
    api.data = {
      ...api.data,
      series: [{ name: '<img src=x onerror=alert(1)>', x: [1, 2], y: [1, 2], points: 2 }],
    };
    const { el } = await panel();
    expect(el.querySelector('.legend button')?.textContent).toContain('<img src=x');
    expect(el.querySelector('img')).toBeNull();
  });

  it('says why a chart could not be made', async () => {
    api.error = { code: 'too_large', message: 'too many points for a chart' };
    const { el } = await panel();
    expect(el.querySelector('.error')?.textContent).toContain('Zu viele Punkte');
    expect(el.querySelector('svg[role=img]')).toBeNull();
  });

  it('copies and saves the chart as SVG in the colours of the scheme', async () => {
    const { fixture, el } = await panel();
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('.bar > button')];
    buttons.find((b) => b.textContent?.includes('kopieren'))!.click();
    await settled(fixture);
    expect(clipboard.texts.at(-1)).toContain('<svg xmlns');
    expect(clipboard.texts.at(-1)).not.toContain('var(--');
    files.path = '/tmp/diagramm.svg';
    buttons.find((b) => b.textContent?.includes('speichern'))!.click();
    await settled(fixture);
    expect(session.disk.get('/tmp/diagramm.svg')?.encoding).toBe('utf-8');
    expect(session.disk.get('/tmp/diagramm.svg')?.text).toContain('<svg xmlns');
    expect(el.querySelector('.done')?.textContent).toContain('diagramm.svg');
  });

  it('frees its chart when it goes', async () => {
    const { fixture } = await panel();
    fixture.destroy();
    expect(api.freed).toEqual([1]);
  });
});
