import { TestBed } from '@angular/core/testing';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { ExportApi } from '../../core/backend/export-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { HistoryApi } from '../../core/history/history-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { SessionApi } from '../../core/session/session-api';
import { QueryApi } from '../../core/sql/query-api';
import {
  FakeClipboardApi,
  FakeConnectionsApi,
  FakeExportApi,
  FakeFileDialogApi,
  FakeHistoryApi,
  FakeQueryApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { ExportService } from '../export/export.service';
import { TabsStore } from '../tabs/tabs.store';
import { CompareBar } from './compare-bar';
import { ResultCompareDialog } from './result-compare-dialog';
import { ResultCompareService } from './result-compare.service';

async function settled(fixture: { whenStable(): Promise<unknown> }): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
}

describe('comparing results (prompt 041)', () => {
  let query: FakeQueryApi;
  let tabs: TabsStore;
  let service: ResultCompareService;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    query = new FakeQueryApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: SessionApi, useValue: new FakeSessionApi() },
        { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
        { provide: ConnectionsApi, useValue: new FakeConnectionsApi() },
        { provide: QueryApi, useValue: query },
        { provide: SchemaApi, useValue: new FakeSchemaApi() },
        { provide: HistoryApi, useValue: new FakeHistoryApi() },
        { provide: ClipboardApi, useValue: new FakeClipboardApi() },
        { provide: ExportApi, useValue: new FakeExportApi() },
      ],
    });
    await TestBed.inject(ConnectionsStore).load();
    tabs = TestBed.inject(TabsStore);
    await tabs.load();
    service = TestBed.inject(ResultCompareService);
  });

  const tab = () => tabs.active()!;

  it('needs two results', async () => {
    await tab().run('select * from a');
    expect(service.can()).toBe(false);
    service.open();
    expect(service.request()).toBeNull();
    expect(tabs.notice()).toContain('zwei Ergebnisse');
  });

  it('opens with the result on screen on the right and the pinned one on the left', async () => {
    await tab().run('select * from a');
    tab().togglePin();
    await tab().run('select * from a');
    service.open();
    expect(service.request()).toMatchObject({ left: 'k1', right: 0 });
  });

  async function dialog() {
    await tab().runAll(['select * from a', 'select * from b']);
    service.open();
    const fixture = TestBed.createComponent(ResultCompareDialog);
    fixture.componentRef.setInput('request', service.request());
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    await settled(fixture);
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el, closed: () => closed };
  }

  it('offers the paired columns, proposes a key and compares', async () => {
    const { fixture, el, closed } = await dialog();
    const rows = [...el.querySelectorAll('tbody tr')];
    expect(rows.map((r) => r.querySelector('th')?.textContent)).toEqual(['id', 'name']);
    const keys = [...el.querySelectorAll<HTMLInputElement>('tbody td:nth-child(2) input')];
    expect(keys.map((k) => k.checked)).toEqual([true, false]);
    // a key column is not ignored: its box is off
    const ignore = [...el.querySelectorAll<HTMLInputElement>('tbody td:nth-child(3) input')];
    expect(ignore.map((k) => k.disabled)).toEqual([true, false]);
    ignore[1].click();
    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    await settled(fixture);
    expect(query.compares[0].spec).toMatchObject({ keys: [0], ignore: [1], decimals: null });
    expect(closed()).toBe(1);
    expect(tab().shownKept()?.compare).toBeTruthy();
    // the next time the tab compares the same way
    expect(service.recalled(tab())).toMatchObject({ keys: ['id'], ignore: ['name'] });
  });

  it('does not compare without a key – unless by position', async () => {
    const { fixture, el } = await dialog();
    el.querySelector<HTMLInputElement>('tbody td:nth-child(2) input')!.click();
    await settled(fixture);
    const submit = el.querySelector<HTMLButtonElement>('button[type=submit]')!;
    expect(submit.disabled).toBe(true);
    expect(el.querySelector('.status')?.textContent).toContain('Schlüsselspalte');
    el.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click();
    await settled(fixture);
    expect(submit.disabled).toBe(false);
    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    await settled(fixture);
    expect(query.compares[0].spec.keys).toEqual([]);
  });

  it('refuses the same result twice', async () => {
    const { fixture, el } = await dialog();
    const left = el.querySelector<HTMLSelectElement>('#rc-left')!;
    left.value = '0';
    left.dispatchEvent(new Event('change'));
    await settled(fixture);
    expect(el.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(true);
    expect(el.querySelector('.status')?.textContent).toContain('verschiedene');
  });

  it('shows how far the comparison is and stops it', async () => {
    const { fixture, el, closed } = await dialog();
    query.compareGate = new Promise<void>(() => undefined);
    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    await settled(fixture);
    expect(el.querySelector('.status')?.textContent).toContain('50 %');
    const stop = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Anhalten'),
    );
    stop!.click();
    await settled(fixture);
    expect(query.cancelledCompares.length).toBe(1);
    expect(tab().comparing()).toBeNull();
    expect(closed()).toBe(0);
  });

  it('runs again and compares at once the way the tab compared before', async () => {
    const { fixture, el } = await dialog();
    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    await settled(fixture);
    service.close();
    tab().show(0);
    await service.runAgain();
    expect(service.request()).toBeNull();
    expect(query.compares.length).toBe(2);
    expect(query.compares[1].spec.keys).toEqual([0]);
    expect(tab().shownKept()?.compare?.leftTitle).toBe('a');
  });

  it('asks how to compare when the tab never did', async () => {
    await tab().run('select * from a');
    await service.runAgain();
    expect(query.compares.length).toBe(0);
    expect(service.request()).toMatchObject({ left: 'k1', right: 0 });
  });

  describe('the bar above the outcome', () => {
    async function bar(report = {}) {
      query.compareReport = report;
      await tab().runAll(['select * from a', 'select * from b']);
      const spec = {
        left: 1,
        right: 2,
        keys: [0],
        ignore: [],
        trim: false,
        ignoreCase: false,
        decimals: null,
      };
      await tab().compare(spec, 'alt', 'neu');
      const fixture = TestBed.createComponent(CompareBar);
      fixture.componentRef.setInput('tab', tab());
      fixture.componentRef.setInput('compare', tab().shownKept()!.compare);
      await settled(fixture);
      return { fixture, el: fixture.nativeElement as HTMLElement };
    }

    it('sums the comparison up', async () => {
      const { el } = await bar();
      expect(el.querySelector('.sides')?.textContent).toBe('alt ↔ neu');
      const figures = [...el.querySelectorAll('.figures li')].map((li) =>
        li.textContent?.replace(/\s+/g, ' ').trim(),
      );
      expect(figures).toEqual(['1 gleich', '1 geändert', '0 nur links', '1 nur rechts']);
      expect(el.querySelector('.notes')?.textContent).toContain('Unterschiede je Spalte: name 1');
    });

    it('names keys that are not unique, as text', async () => {
      const { el } = await bar({
        duplicateLeft: 2,
        duplicateRight: 0,
        duplicateKeys: ['<img src=x onerror=alert(1)>'],
      });
      expect(el.querySelector('.warn')?.textContent).toContain('<img src=x onerror=alert(1)>');
      expect(el.querySelector('img')).toBeNull();
      expect(el.querySelector('.figures .duplicates')?.textContent).toContain('2');
    });

    it('switches between all rows and the differences', async () => {
      const { fixture, el } = await bar();
      const only = el.querySelector<HTMLInputElement>('.only input')!;
      expect(only.checked).toBe(true);
      only.click();
      await settled(fixture);
      expect(tab().shownKept()?.compare?.onlyDifferences).toBe(false);
      expect(tab().state()).toMatchObject({ rows: 4 });
    });

    it('exports the rows that differ', async () => {
      const { el } = await bar();
      const button = [...el.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('exportieren'),
      );
      button!.click();
      expect(TestBed.inject(ExportService).request()).toMatchObject({
        kind: 'result',
        resultId: 5003,
        rows: 3,
        sql: '',
        name: 'alt-neu',
      });
    });

    it('says when the results are the same', async () => {
      const { el } = await bar({ diffRows: 0, changed: 0, rightOnly: 0, changedByColumn: [] });
      expect(el.querySelector('.ok')?.textContent).toContain('gleich');
    });
  });
});
