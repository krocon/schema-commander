import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeConnectionsApi, FakeQueryApi } from '../../../testing/fake-apis';
import { ConnectionsApi } from '../../core/connections/connections-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { QueryColumn } from '../../core/sql/query.models';
import { QueryTab } from '../tabs/query-tab';
import { FilterBar } from './filter-bar';
import { EMPTY_SPEC } from './filter-logic';

const columns: QueryColumn[] = [
  { name: 'id', kind: 'int', typeName: 'INT4' },
  { name: 'name', kind: 'text', typeName: 'TEXT' },
];

describe('FilterBar', () => {
  let api: FakeQueryApi;
  let tab: QueryTab;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    api = new FakeQueryApi();
    TestBed.configureTestingModule({
      imports: [FilterBar],
      providers: [{ provide: ConnectionsApi, useValue: new FakeConnectionsApi() }],
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
      { api, connections: store, options: () => ({ stopOnError: true, timeoutMs: 0 }) },
    );
  });

  async function open(local = false) {
    const fixture = TestBed.createComponent(FilterBar);
    fixture.componentRef.setInput('tab', tab);
    fixture.componentRef.setInput('columns', columns);
    fixture.componentRef.setInput('total', 3400);
    fixture.componentRef.setInput('local', local);
    const settle = async (ms = 0) => {
      fixture.detectChanges();
      await new Promise((r) => setTimeout(r, ms));
      await fixture.whenStable();
      fixture.detectChanges();
    };
    await settle();
    const el = fixture.nativeElement as HTMLElement;
    const set = async (control: Element, value: string, event = 'input') => {
      (control as HTMLInputElement).value = value;
      control.dispatchEvent(new Event(event));
      await settle();
    };
    return { fixture, el, settle, set };
  }

  it('shows nothing for a result that is no table and has no local filter', async () => {
    await tab.run('select 1');
    const { el } = await open();
    expect(el.querySelector('form')).toBeNull();
    expect(el.querySelector('.local')).toBeNull();
  });

  it('builds conditions with named controls and applies them on Enter', async () => {
    await tab.openTable({ schema: null, table: 'orders', spec: EMPTY_SPEC });
    const { el, set, settle } = await open();
    const form = el.querySelector('form')!;
    expect(form.getAttribute('aria-label')).toBe('Filter der Tabelle');
    el.querySelector<HTMLButtonElement>('form > button')!.click();
    await settle();
    const selects = () => [...el.querySelectorAll<HTMLSelectElement>('.condition select')];
    expect(selects().map((s) => s.getAttribute('aria-label'))).toEqual([
      'Spalte der Bedingung 1',
      'Operator der Bedingung 1',
    ]);
    await set(selects()[0], 'name', 'change');
    await set(selects()[1], 'contains', 'change');
    await set(el.querySelector('.condition input')!, "O'Brien");
    await set(el.querySelector('.where')!, 'id > 5');
    form.dispatchEvent(new Event('submit'));
    await settle(10);
    expect(api.tableQueries.at(-1)?.query).toMatchObject({
      conditions: [{ column: 'name', op: 'contains', values: ["O'Brien"], kind: 'text' }],
      whereSql: 'id > 5',
    });
    // the bar says that the view is filtered, and resets it
    expect(el.querySelector('.badge')?.textContent).toBe('gefiltert');
    const reset = [...el.querySelectorAll<HTMLButtonElement>('form button')].find(
      (b) => b.textContent?.trim() === 'Zurücksetzen',
    )!;
    reset.click();
    await settle(10);
    expect(api.tableQueries.at(-1)?.query.conditions).toEqual([]);
    expect(el.querySelector('.badge')).toBeNull();
    expect(el.querySelectorAll('.condition').length).toBe(0);
  });

  it('shows between with two values and a row without a value is left out', async () => {
    await tab.openTable({ schema: null, table: 'orders', spec: EMPTY_SPEC });
    const { el, set, settle } = await open();
    el.querySelector<HTMLButtonElement>('form > button')!.click();
    el.querySelector<HTMLButtonElement>('form > button')!.click();
    await settle();
    const first = el.querySelectorAll('.condition')[0];
    await set(first.querySelectorAll('select')[0], 'id', 'change');
    await set(first.querySelectorAll('select')[1], 'between', 'change');
    const inputs = el.querySelectorAll('.condition')[0].querySelectorAll('input');
    expect(inputs.length).toBe(2);
    await set(inputs[0], '1');
    await set(inputs[1], '9');
    // two conditions: how they are joined can be chosen
    expect(
      el.querySelector('select[aria-label="Wie die Bedingungen verknüpft sind"]'),
    ).not.toBeNull();
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle(10);
    expect(api.tableQueries.at(-1)?.query.conditions).toEqual([
      { column: 'id', op: 'between', values: ['1', '9'], kind: 'number', typeName: 'INT4' },
    ]);
  });

  it('filters a result locally after a pause in typing and says how many rows are left', async () => {
    await tab.run('select 1');
    const { el, set, settle } = await open(true);
    const search = el.querySelector<HTMLInputElement>('input[type=search]')!;
    await set(search, 'an');
    await set(search, 'anna');
    expect(api.views.length).toBe(0);
    await settle(450);
    expect(api.views.map((v) => v.spec.text)).toEqual(['anna']);
    expect(el.querySelector('.count')?.textContent?.trim()).toBe('2 von 3.400');
    // only one column
    await set(el.querySelector('.local select')!, '1', 'change');
    await settle(10);
    expect(api.views.at(-1)?.spec).toMatchObject({ text: 'anna', column: 1 });
    [...el.querySelectorAll<HTMLButtonElement>('.local button')][0].click();
    await settle(10);
    expect(tab.localView()).toBeNull();
    expect(search.value).toBe('');
  });
});
