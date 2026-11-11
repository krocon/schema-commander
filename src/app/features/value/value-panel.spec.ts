import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeClipboardApi,
  FakeFileDialogApi,
  FakeQueryApi,
  FakeThemeApi,
  FakeWindowApi,
} from '../../../testing/fake-apis';
import { WindowApi } from '../../core/backend/window-api';
import { ThemeApi } from '../../core/theme/theme-api';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { QueryApi } from '../../core/sql/query-api';
import { ColKind } from '../../core/sql/query.models';
import { FIRST_PART } from './value-logic';
import { ValuePanel } from './value-panel';
import { ActiveCell, ValueService } from './value.service';

const cell = (row: number, col = 0, kind: ColKind = 'text', name = 'note'): ActiveCell => ({
  resultId: 1,
  row,
  col,
  column: { name, kind, typeName: kind.toUpperCase() },
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ValuePanel', () => {
  let api: FakeQueryApi;
  let files: FakeFileDialogApi;
  let clipboard: FakeClipboardApi;

  beforeEach(() => {
    TestBed.resetTestingModule();
    api = new FakeQueryApi();
    files = new FakeFileDialogApi();
    clipboard = new FakeClipboardApi();
    TestBed.configureTestingModule({
      imports: [ValuePanel],
      providers: [
        { provide: QueryApi, useValue: api },
        { provide: FileDialogApi, useValue: files },
        { provide: ClipboardApi, useValue: clipboard },
        { provide: WindowApi, useValue: new FakeWindowApi() },
        { provide: ThemeApi, useValue: new FakeThemeApi() },
      ],
    });
  });

  function open() {
    const fixture = TestBed.createComponent(ValuePanel);
    const el = fixture.nativeElement as HTMLElement;
    const show = async (c: ActiveCell | null, ms = 180) => {
      fixture.componentRef.setInput('cell', c);
      fixture.detectChanges();
      await wait(ms);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    return { fixture, el, show, panel: fixture.componentInstance };
  }

  it('says what to do while no cell is chosen, and names NULL', async () => {
    const { el, show } = open();
    await show(null);
    expect(el.textContent).toContain('Eine Zelle wählen');
    expect(el.getAttribute('role')).toBe('region');
    await show(cell(0));
    expect(el.textContent).toContain('NULL – die Zelle hat keinen Wert.');
    expect(el.querySelector<HTMLButtonElement>('.tools button')?.disabled).toBe(true);
  });

  it('shows the whole text of a cell with its column, type and size', async () => {
    api.values.set('1:3:0', { text: 'Köln 😀\nzweite Zeile' });
    const { el, show, panel } = open();
    await show(cell(3));
    expect(panel.shown()).toBe('Köln 😀\nzweite Zeile');
    expect(el.querySelector('.column')?.textContent).toBe('note');
    expect(el.querySelector('header')?.textContent).toContain('TEXT');
    // characters as a person counts them: the emoji is one
    expect(el.querySelector('header')?.textContent).toContain('19 Zeichen');
    expect(api.valueCalls).toEqual([{ resultId: 1, row: 3, col: 0, from: 0, max: FIRST_PART }]);
  });

  it('lays JSON out and offers the text as it is', async () => {
    api.values.set('1:0:0', { text: '{"a":[1,2],"b":"x"}' });
    const { el, show, panel, fixture } = open();
    await show(cell(0, 0, 'json'));
    expect(panel.shown()).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": "x"\n}');
    const select = el.querySelector<HTMLSelectElement>('select')!;
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual(['JSON', 'Text']);
    select.value = 'text';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await wait(0);
    expect(panel.shown()).toBe('{"a":[1,2],"b":"x"}');
  });

  it('follows the cursor with a breath and drops what was overtaken', async () => {
    api.values.set('1:1:0', { text: 'eins' });
    api.values.set('1:2:0', { text: 'zwei' });
    api.values.set('1:3:0', { text: 'drei' });
    const { show, panel } = open();
    // running through cells: none of them is asked for
    await show(cell(1), 20);
    await show(cell(2), 20);
    expect(api.valueCalls).toEqual([]);
    await show(cell(3));
    expect(api.valueCalls.map((c) => c.row)).toEqual([3]);
    expect(panel.shown()).toBe('drei');
    // an answer that comes after the cursor has moved on is not shown
    let release!: () => void;
    api.valueGate = new Promise<void>((r) => (release = r));
    await show(cell(1));
    api.valueGate = null;
    await show(cell(2));
    expect(panel.shown()).toBe('zwei');
    release();
    await wait(20);
    expect(panel.shown()).toBe('zwei');
  });

  it('reads a value of a few megabytes whole and a larger one only on request', async () => {
    const medium = 'x'.repeat(FIRST_PART + 1000);
    const large = 'y'.repeat(5 * 1024 * 1024);
    api.values.set('1:0:0', { text: medium });
    api.values.set('1:1:0', { text: large });
    const { el, show, panel, fixture } = open();
    await show(cell(0));
    expect(panel.shown().length).toBe(medium.length);
    expect(el.querySelector('.note')).toBeNull();
    await show(cell(1));
    expect(panel.shown().length).toBe(FIRST_PART);
    expect(el.querySelector('.note')?.textContent).toContain(
      'Gezeigt sind die ersten 256.0 KB von 5.0 MB',
    );
    const before = api.valueCalls.length;
    el.querySelector<HTMLButtonElement>('.note button')!.click();
    await wait(50);
    fixture.detectChanges();
    expect(panel.shown().length).toBe(large.length);
    // piece by piece, each from where the last one ended
    const parts = api.valueCalls.slice(before);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].from).toBe(FIRST_PART);
    expect(el.querySelector('.note')).toBeNull();
  });

  it('shows binary data as hex, and as a picture when its header is a sane one', async () => {
    const bytes = new Uint8Array(40).map((_, i) => i + 60);
    api.values.set('1:0:0', { bytes });
    api.values.set('1:1:0', { bytes, image: { mime: 'image/png', width: 16, height: 16 } });
    api.values.set('1:2:0', { bytes, image: { mime: 'image/png', width: 4e9, height: 4e9 } });
    const created: string[] = [];
    URL.createObjectURL = (blob: Blob) => {
      created.push(blob.type);
      return `blob:test-${created.length}`;
    };
    URL.revokeObjectURL = () => undefined;
    const { el, show, panel, fixture } = open();
    await show(cell(0, 0, 'bytes'));
    expect(panel.shown()).toContain('00000000  3c 3d 3e 3f');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('header')?.textContent).toContain('40 B, binär');
    await show(cell(1, 0, 'bytes', 'foto'));
    const img = el.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('blob:test-1');
    expect(img.alt).toBe('Bild in der Spalte foto');
    expect(created).toEqual(['image/png']);
    expect(el.querySelector('header')?.textContent).toContain('image/png, 16 × 16');
    // data that only claims to be a picture: the window falls back to the bytes
    img.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    await wait(0);
    fixture.detectChanges();
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('lassen sich aber nicht zeichnen');
    // a header that claims four billion pixels a side is never handed to the picture decoder
    await show(cell(2, 0, 'bytes'));
    expect(el.querySelector('img')).toBeNull();
    expect(created.length).toBe(1);
  });

  it('shows a number in other bases and an instant in other zones', async () => {
    api.values.set('1:0:0', { text: '255' });
    api.values.set('1:0:1', { text: '2026-11-11 12:30:00+01:00' });
    const { el, show, fixture } = open();
    const choose = async (view: string) => {
      const select = el.querySelector<HTMLSelectElement>('select')!;
      select.value = view;
      select.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      await wait(0);
      fixture.detectChanges();
    };
    await show(cell(0, 0, 'int'));
    await choose('number');
    expect([...el.querySelectorAll('dd')].map((d) => d.textContent)).toEqual([
      '255',
      '0xFF',
      '0b11111111',
    ]);
    await show(cell(0, 1, 'timestampTz'));
    await choose('date');
    expect(el.querySelector('.forms')?.textContent).toContain('2026-11-11 11:30:00Z');
    expect(el.querySelector('.forms')?.textContent).toContain('Mittwoch');
  });

  it('says so when the result is gone', async () => {
    api.error = { code: 'unknown_result', message: 'no result 1' };
    const { el, show } = open();
    await show(cell(0));
    expect(el.querySelector('[role=alert]')?.textContent).toContain('gibt es nicht mehr');
  });

  it('copies and saves the whole value in the backend', async () => {
    const service = TestBed.inject(ValueService);
    service.cell.set(cell(4, 2, 'json', 'Daten / roh'));
    await service.copy();
    expect(api.copiedValues).toEqual(['1:4:2']);
    expect(service.notice()).toContain('kopiert');
    files.path = '/tmp/out.json';
    await service.save('json');
    // the name suggested is made of the column
    expect(files.asked.at(-1)).toBe('Wert speichern: Daten_roh.json');
    expect(api.savedValues).toEqual(['1:4:2 → /tmp/out.json']);
    files.path = null;
    await service.save('json');
    expect(api.savedValues.length).toBe(1);
    service.forget(1);
    expect(service.cell()).toBeNull();
  });
});
