import { TestBed } from '@angular/core/testing';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { HistoryApi } from '../../core/history/history-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { DiagramData, ForeignKey } from '../../core/schema/schema.models';
import { SessionApi } from '../../core/session/session-api';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import {
  FakeClipboardApi,
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeHistoryApi,
  FakeQueryApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { ObjectDetailsService } from '../details/details.service';
import { TabsStore } from '../tabs/tabs.store';
import { DiagramTarget } from './diagram.service';
import { ErDiagramDialog } from './er-diagram-dialog';
import { nodeId } from './er-model';

const col = (name: string, pk = false, nullable = false) => ({
  name,
  typeName: 'integer',
  nullable,
  pk,
});
const fk = (table: string, column: string, refTable: string): ForeignKey => ({
  name: `${table}_${column}`,
  schema: 'public',
  table,
  columns: [column],
  refSchema: 'public',
  refTable,
  refColumns: ['id'],
});
const DATA: DiagramData = {
  tables: [
    { schema: 'public', name: 'author', columns: [col('id', true), col('name')] },
    { schema: 'public', name: 'book', columns: [col('id', true), col('author_id')] },
    { schema: 'public', name: 'copy', columns: [col('id', true), col('book_id', false, true)] },
    { schema: 'public', name: '<b>log</b>', columns: [col('id', true)] },
  ],
  keys: [fk('book', 'author_id', 'author'), fk('copy', 'book_id', 'book')],
  unique: [],
  cut: false,
};

async function settled(fixture: { whenStable(): Promise<unknown> }): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
}

describe('ErDiagramDialog', () => {
  let schema: FakeSchemaApi;
  let clipboard: FakeClipboardApi;
  let files: FakeFileDialogApi;
  let session: FakeSessionApi;
  let queries: FakeQueryApi;

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    TestBed.resetTestingModule();
    schema = new FakeSchemaApi();
    schema.diagramData = DATA;
    clipboard = new FakeClipboardApi();
    files = new FakeFileDialogApi();
    session = new FakeSessionApi();
    queries = new FakeQueryApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: SchemaApi, useValue: schema },
        { provide: ClipboardApi, useValue: clipboard },
        { provide: FileDialogApi, useValue: files },
        { provide: SessionApi, useValue: session },
        { provide: QueryApi, useValue: queries },
        { provide: HistoryApi, useValue: new FakeHistoryApi() },
        { provide: ConnectionsApi, useValue: new FakeConnectionsApi() },
      ],
    });
  });

  async function open(
    target: DiagramTarget = { connectionId: 'demo', schema: 'public', table: null },
  ) {
    await TestBed.inject(ConnectionsStore).load();
    await TestBed.inject(TabsStore).load();
    const fixture = TestBed.createComponent(ErDiagramDialog);
    fixture.componentRef.setInput('target', target);
    await settled(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const click = async (text: string) => {
      const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
      expect(button, text).toBeDefined();
      button?.click();
      await settled(fixture);
    };
    const pick = async (selector: string, value: string) => {
      const select = el.querySelector<HTMLSelectElement>(selector)!;
      select.value = value;
      select.dispatchEvent(new Event('change'));
      await settled(fixture);
    };
    const names = () => [...el.querySelectorAll('svg .node .title')].map((n) => n.textContent);
    return { fixture, el, click, pick, names };
  }

  it('draws the tables and keys of a schema and lists the same', async () => {
    const { el, names } = await open();
    expect(schema.calls).toContain('diagram public');
    expect(names().sort()).toEqual(['<b>log</b>', 'author', 'book', 'copy']);
    // a name from the database is text, never markup
    expect(el.querySelector('svg b')).toBeNull();
    expect(el.querySelectorAll('svg path.edge').length).toBe(2);
    expect([...el.querySelectorAll('#er-tables option')].map((o) => o.textContent)).toEqual([
      '<b>log</b>',
      'author',
      'book',
      'copy',
    ]);
    // the relations in words: who points where, and how many
    const lines = [...el.querySelectorAll('.relations li')].map((li) =>
      li.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(lines).toEqual([
      'book: author_id → author (id) viele → genau eine',
      'copy: book_id → book (id) viele → höchstens eine',
    ]);
    expect(el.querySelector('.status')?.textContent).toContain('4 Tabellen, 2 Beziehungen');
    expect(el.querySelector('svg')?.getAttribute('aria-label')).toContain('4 Tabellen');
  });

  it('shows a table with its neighbours, as far as asked', async () => {
    const { names, pick } = await open({ connectionId: 'demo', schema: 'public', table: 'author' });
    expect(names().sort()).toEqual(['author', 'book']);
    await pick('header label:nth-of-type(2) select', '2');
    expect(names().sort()).toEqual(['author', 'book', 'copy']);
  });

  it('selects, removes and adds tables from the list', async () => {
    const { el, pick, click, names } = await open();
    await pick('#er-tables', nodeId('public', 'book'));
    expect(el.querySelector('svg .node.selected .title')?.textContent).toBe('book');
    expect(el.querySelectorAll('svg path.edge.hot').length).toBe(2);
    expect(el.querySelectorAll('.relations li').length).toBe(2);
    await click('Aus dem Diagramm nehmen');
    expect(names().sort()).toEqual(['<b>log</b>', 'author', 'copy']);
    expect(el.querySelectorAll('svg path.edge').length).toBe(0);
    await pick('#er-add', nodeId('public', 'book'));
    expect(names().length).toBe(4);
    expect(el.querySelectorAll('svg path.edge').length).toBe(2);
  });

  it('finds tables by name and shows more or less of them', async () => {
    const { fixture, el, pick } = await open();
    const find = el.querySelector<HTMLInputElement>('header input')!;
    find.value = 'BOO';
    find.dispatchEvent(new Event('input'));
    await settled(fixture);
    expect([...el.querySelectorAll('svg .node.found .title')].map((n) => n.textContent)).toEqual([
      'book',
    ]);
    expect(el.querySelectorAll('svg .node.faded').length).toBe(3);
    expect(el.querySelector('#er-tables option')?.textContent).toBe('book');
    // keys by default; all columns with their types; names only
    expect(el.querySelectorAll('svg .node text.type').length).toBe(0);
    await pick('header label:nth-of-type(1) select', 'all');
    expect(el.querySelectorAll('svg .node text.type').length).toBe(7);
    await pick('header label:nth-of-type(1) select', 'names');
    expect(el.querySelectorAll('svg .node text').length).toBe(4);
  });

  it('opens the data and the details of a table', async () => {
    const { pick, click } = await open();
    await pick('#er-tables', nodeId('public', 'copy'));
    await click('Einzelheiten');
    expect(TestBed.inject(ObjectDetailsService).current()).toMatchObject({
      schema: 'public',
      name: 'copy',
      kind: 'table',
    });
    await click('Daten öffnen');
    expect(queries.tableQueries.at(-1)?.query).toMatchObject({ schema: 'public', table: 'copy' });
  });

  it('exports as Mermaid, DBML and an SVG file with fixed colours', async () => {
    const { el, click } = await open();
    await click('Als Mermaid kopieren');
    expect(clipboard.texts.at(-1)).toContain('author ||--o{ book : "author_id"');
    await click('Als DBML kopieren');
    expect(clipboard.texts.at(-1)).toContain('Ref: public.book.author_id > public.author.id');
    files.path = '/out/public.svg';
    await click('Als SVG speichern');
    const written = session.disk.get('/out/public.svg')?.text ?? '';
    expect(written.startsWith('<svg xmlns=')).toBe(true);
    expect(written).not.toContain('var(');
    expect(written).toContain('&lt;b&gt;log&lt;/b&gt;');
    expect(el.querySelector('.status')?.textContent).toBe('Gespeichert als public.svg.');
  });

  it('remembers where a table was moved to, per diagram', async () => {
    const settings = TestBed.inject(SettingsService);
    const key = 'demo|public|';
    settings.update({ diagramPlaces: { [key]: { [nodeId('public', 'copy')]: [700, 300] } } });
    const { el, click } = await open();
    const copy = [...el.querySelectorAll<SVGGElement>('svg .node')].find(
      (n) => n.querySelector('.title')?.textContent === 'copy',
    );
    expect(copy?.getAttribute('transform')).toBe('translate(700,300)');
    await click('Neu anordnen');
    expect(settings.settings().diagramPlaces[key]).toBeUndefined();
    expect(
      [...el.querySelectorAll<SVGGElement>('svg .node')]
        .find((n) => n.querySelector('.title')?.textContent === 'copy')
        ?.getAttribute('transform'),
    ).not.toBe('translate(700,300)');
  });

  it('says why a schema could not be read, and when it has no tables', async () => {
    schema.diagramData = { tables: [], keys: [], unique: [], cut: false };
    const empty = await open();
    expect(empty.el.querySelector('.status')?.textContent).toBe(
      'Dieses Schema hat keine Tabellen.',
    );
    schema.fail = { code: 'permission_denied', message: 'no' };
    const failed = await open();
    expect(failed.el.querySelector('.status')?.textContent).toContain('ließ sich nicht lesen');
  });
});
