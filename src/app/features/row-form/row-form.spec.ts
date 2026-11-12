import { TestBed } from '@angular/core/testing';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { HistoryApi } from '../../core/history/history-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { SessionApi } from '../../core/session/session-api';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { Cell, QueryColumn, RowWindow } from '../../core/sql/query.models';
import {
  FakeClipboardApi,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeHistoryApi,
  FakeQueryApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { EditMarks } from '../edit/edit-buffer';
import { CopyService } from '../results/copy.service';
import { QueryTab } from '../tabs/query-tab';
import { ActiveCell } from '../value/value.service';
import { RowForm } from './row-form';

const COLUMNS: QueryColumn[] = [
  { name: 'id', kind: 'int', typeName: 'INT4' },
  { name: 'name', kind: 'text', typeName: 'TEXT' },
  { name: 'note', kind: 'text', typeName: 'TEXT' },
];
const ROWS: Cell[][] = [
  [1, 'Ada', null],
  [2, '<b>Bob</b>', 'x'.repeat(400)],
  [3, 'Ada', 'late'],
];

async function settled(fixture: { whenStable(): Promise<unknown> }): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
}

describe('RowForm', () => {
  let clipboard: FakeClipboardApi;
  let moved: (readonly [number, number | null])[];
  let windows: [number, number, number][];

  beforeEach(() => {
    TestBed.resetTestingModule();
    clipboard = new FakeClipboardApi();
    moved = [];
    windows = [];
    const queries = new FakeQueryApi();
    queries.window = (resultId: number, from: number, count: number): Promise<RowWindow> => {
      windows.push([resultId, from, count]);
      return Promise.resolve(ROWS.slice(from, from + count));
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: QueryApi, useValue: queries },
        { provide: ClipboardApi, useValue: clipboard },
        { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
        { provide: SessionApi, useValue: new FakeSessionApi() },
        { provide: SchemaApi, useValue: new FakeSchemaApi() },
        { provide: HistoryApi, useValue: new FakeHistoryApi() },
        { provide: ConnectionsApi, useValue: new FakeConnectionsApi() },
      ],
    });
  });

  const cellAt = (row: number, col = 0): ActiveCell => ({
    resultId: 7,
    row,
    col,
    column: COLUMNS[col],
  });

  async function open(cell: ActiveCell | null, edits: EditMarks | null = null) {
    const fixture = TestBed.createComponent(RowForm);
    const tab = { grid: { goTo: (row: number, col: number | null) => moved.push([row, col]) } };
    fixture.componentRef.setInput('cell', cell);
    fixture.componentRef.setInput('result', { resultId: 7, columns: COLUMNS });
    fixture.componentRef.setInput('rows', ROWS.length);
    fixture.componentRef.setInput('tab', tab as unknown as QueryTab);
    fixture.componentRef.setInput('edits', edits);
    await settled(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const click = async (label: string) => {
      const button = [...el.querySelectorAll('button')].find(
        (b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label,
      );
      expect(button, label).toBeDefined();
      button?.click();
      await settled(fixture);
    };
    const lines = () =>
      [...el.querySelectorAll('tbody tr')].map(
        (tr) =>
          `${tr.querySelector('th')?.textContent?.trim()}=${tr.querySelector('.value')?.textContent}`,
      );
    return { fixture, el, click, lines };
  }

  it('shows the row under the cursor as fields, as text', async () => {
    const { el, lines, fixture } = await open(cellAt(1, 1));
    expect(windows).toEqual([[7, 1, 1]]);
    expect(el.querySelector('.count')?.textContent).toBe('Zeile 2 von 3');
    expect(lines().slice(0, 2)).toEqual(['id=2', 'name=<b>Bob</b>']);
    expect(el.querySelector('tbody b')).toBeNull();
    // the field the cursor is on is marked; a long value offers the value panel
    expect(el.querySelector('tr.current th')?.textContent?.trim()).toBe('name');
    expect(
      el.querySelector('button[aria-label="note ganz in der Wert-Ansicht zeigen"]'),
    ).not.toBeNull();
    // another row: read again; the same row, another column: not
    fixture.componentRef.setInput('cell', cellAt(1, 2));
    await settled(fixture);
    expect(windows.length).toBe(1);
    fixture.componentRef.setInput('cell', cellAt(2, 2));
    await settled(fixture);
    expect(windows.at(-1)).toEqual([7, 2, 1]);
    expect(lines()[2]).toBe('note=late');
  });

  it('moves the cursor of the grid: other rows, the same field', async () => {
    const { el, click, fixture } = await open(cellAt(1, 2));
    await click('Nächste Zeile');
    await click('Vorige Zeile');
    await click('Erste Zeile');
    await click('Letzte Zeile');
    expect(moved).toEqual([
      [2, 2],
      [0, 2],
      [0, 2],
      [2, 2],
    ]);
    const go = el.querySelector<HTMLInputElement>('.goto')!;
    go.value = '3';
    go.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    go.value = '99';
    go.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settled(fixture);
    expect(moved.at(-1)).toEqual([2, 2]);
    expect(moved.length).toBe(5);
    // a field: the cursor goes to its column
    await click('id');
    expect(moved.at(-1)).toEqual([1, 0]);
  });

  it('filters the fields and shows what waits in the edit buffer', async () => {
    const edits = {
      at: (row: number, column: number) =>
        row === 0 && column === 1 ? { kind: 'value', text: 'Ada L.' } : null,
    } as unknown as EditMarks;
    const { el, lines, fixture } = await open(cellAt(0), edits);
    expect(lines()).toEqual(['id=1', 'name=Ada L.', 'note=NULL']);
    expect(el.querySelector('tr.changed th')?.textContent?.trim()).toBe('name');
    const boxes = el.querySelectorAll<HTMLInputElement>('.checks input');
    boxes[0].click();
    await settled(fixture);
    expect(lines()).toEqual(['id=1', 'name=Ada L.']);
    boxes[1].click();
    await settled(fixture);
    expect(lines()).toEqual(['name=Ada L.']);
    expect(el.querySelector('footer .status')?.textContent).toBe('1 von 3 Spalten');
    boxes[0].click();
    boxes[1].click();
    const find = el.querySelector<HTMLInputElement>('input[type=search]')!;
    find.value = 'NO';
    find.dispatchEvent(new Event('input'));
    await settled(fixture);
    expect(lines()).toEqual(['note=NULL']);
    // where a result can be edited, a field can be
    expect(el.querySelector('button[aria-label="note bearbeiten"]')).not.toBeNull();
  });

  it('lays the marked rows side by side and marks what differs', async () => {
    const copier = TestBed.inject(CopyService);
    vi.spyOn(copier, 'selection').mockReturnValue({ rows: [[0, 2]], columns: [] });
    const { el, fixture } = await open(cellAt(0));
    const compare = el.querySelectorAll<HTMLInputElement>('.checks input')[2];
    expect(compare.disabled).toBe(false);
    compare.click();
    await settled(fixture);
    expect([...el.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).toEqual([
      'Spalte',
      'Zeile 1',
      'Zeile 2',
      'Zeile 3',
    ]);
    const rows = [...el.querySelectorAll('tbody tr')];
    expect(rows.map((tr) => tr.className.includes('differs'))).toEqual([true, true, true]);
    expect([...rows[1].querySelectorAll('td')].map((td) => td.textContent)).toEqual([
      'Ada',
      '<b>Bob</b>',
      'Ada',
    ]);
    expect(el.querySelector('.count')?.textContent).toBe('3 Zeilen nebeneinander');
  });

  it('copies a field, the row as a list and as JSON; a long value goes to the value panel', async () => {
    const { el, click } = await open(cellAt(0));
    await click('Den Wert von name kopieren');
    await click('Als „Name: Wert“ kopieren');
    await click('Als JSON kopieren');
    expect(clipboard.texts[0]).toBe('Ada');
    expect(clipboard.texts[1]).toBe('id: 1\nname: Ada\nnote: NULL\n');
    expect(JSON.parse(clipboard.texts[2])).toEqual({ id: 1, name: 'Ada', note: null });
    expect(el.querySelector('footer .status')?.textContent).toBe('Kopiert.');
    const long = await open(cellAt(1));
    await long.click('note ganz in der Wert-Ansicht zeigen');
    expect(moved.at(-1)).toEqual([1, 2]);
    expect(TestBed.inject(SettingsService).settings()).toMatchObject({
      rowFormVisible: false,
      valuePanelVisible: true,
    });
  });

  it('says what to do without a row', async () => {
    const { el } = await open(null);
    expect(el.textContent).toContain('Den Cursor auf eine Zeile des Ergebnisses setzen.');
    expect(el.querySelector<HTMLButtonElement>('.nav button')?.disabled).toBe(true);
  });
});
