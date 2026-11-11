import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeConnectionsApi,
  FakeFileDialogApi,
  FakeHistoryApi,
  FakeQueryApi,
  FakeSchemaApi,
  FakeSessionApi,
} from '../../../testing/fake-apis';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { HistoryApi } from '../../core/history/history-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { SessionApi } from '../../core/session/session-api';
import { QueryApi } from '../../core/sql/query-api';
import { TabsStore } from '../tabs/tabs.store';
import { HistoryPanel } from './history-panel';

describe('HistoryPanel', () => {
  let history: FakeHistoryApi;

  beforeEach(() => {
    TestBed.resetTestingModule();
    history = new FakeHistoryApi();
    TestBed.configureTestingModule({
      imports: [HistoryPanel],
      providers: [
        { provide: SessionApi, useValue: new FakeSessionApi() },
        { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
        { provide: ConnectionsApi, useValue: new FakeConnectionsApi() },
        { provide: QueryApi, useValue: new FakeQueryApi() },
        { provide: SchemaApi, useValue: new FakeSchemaApi() },
        { provide: HistoryApi, useValue: history },
      ],
    });
  });

  async function open() {
    for (const [i, sql] of ['SELECT 1', 'SELECT 2', 'DELETE FROM t'].entries()) {
      await history.add(
        {
          at: 1_700_000_000_000 + i,
          connectionId: 'demo',
          connectionName: 'Demo',
          database: '',
          sql,
          elapsedMs: 1,
          rows: 1,
          outcome: i === 2 ? 'failed' : 'ok',
          message: null,
          tab: 'tab-1',
          origin: 'user',
        },
        { maxEntries: 100, maxDays: 0 },
      );
    }
    const fixture = TestBed.createComponent(HistoryPanel);
    const settle = async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();
    };
    await settle();
    const el = fixture.nativeElement as HTMLElement;
    const options = () => [...el.querySelectorAll<HTMLElement>('[role=option]')];
    const list = el.querySelector<HTMLElement>('[role=listbox]')!;
    const key = async (k: string) => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      await settle();
    };
    return { fixture, el, options, list, key, settle };
  }

  it('lists the latest statements of the user, the failed ones marked', async () => {
    const { options, list } = await open();
    expect(options().map((o) => o.querySelector('code')?.textContent)).toEqual([
      'DELETE FROM t',
      'SELECT 2',
      'SELECT 1',
    ]);
    expect(options()[0].classList.contains('failed')).toBe(true);
    expect(history.filters.at(-1)).toMatchObject({ userOnly: true, limit: 100 });
    // one stop in the tab order
    expect(list.tabIndex).toBe(0);
  });

  it('moves with the arrows and puts the chosen statement into the editor in front', async () => {
    const { options, list, key } = await open();
    const store = TestBed.inject(TabsStore);
    await store.load();
    const inserted: string[] = [];
    store.active()!.insert = (text: string) => void inserted.push(text);
    await key('ArrowDown');
    await key('ArrowDown');
    expect(options()[1].getAttribute('aria-selected')).toBe('true');
    expect(list.getAttribute('aria-activedescendant')).toBe(options()[1].id);
    await key('End');
    expect(options()[2].getAttribute('aria-selected')).toBe('true');
    await key('Home');
    await key('Enter');
    expect(inserted).toEqual(['DELETE FROM t']);
  });

  it('searches after a moment and says when nothing matches', async () => {
    const { el, options, settle } = await open();
    const field = el.querySelector<HTMLInputElement>('input[type=search]')!;
    field.value = 'select';
    field.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 250));
    await settle();
    expect(options().length).toBe(2);
    field.value = 'nothing like it';
    field.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 250));
    await settle();
    expect(options().length).toBe(0);
    expect(el.querySelector('.message')?.textContent).toContain('Keine Einträge');
  });
});
