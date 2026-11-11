import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeClipboardApi,
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
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { ResultRef, RowWindow } from '../../core/sql/query.models';
import { ResultGrid } from './result-grid';

describe('ResultGrid', () => {
  const result: ResultRef = {
    resultId: 5,
    columns: [
      { name: 'id', kind: 'int', typeName: 'int4' },
      { name: 'name', kind: 'text', typeName: 'text' },
    ],
  };

  beforeEach(() => {
    // jsdom has none; the table watches its size with one
    vi.stubGlobal(
      'ResizeObserver',
      class {
        readonly observe = vi.fn();
        readonly unobserve = vi.fn();
        readonly disconnect = vi.fn();
      },
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ResultGrid],
      providers: [
        { provide: QueryApi, useValue: new FakeQueryApi() },
        { provide: ClipboardApi, useValue: new FakeClipboardApi() },
        { provide: SessionApi, useValue: new FakeSessionApi() },
        { provide: FileDialogApi, useValue: new FakeFileDialogApi() },
        { provide: ConnectionsApi, useValue: new FakeConnectionsApi() },
        { provide: SchemaApi, useValue: new FakeSchemaApi() },
        { provide: HistoryApi, useValue: new FakeHistoryApi() },
      ],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  async function show() {
    const fetch = vi.fn((_id: number, from: number, count: number): Promise<RowWindow> =>
      Promise.resolve(
        Array.from({ length: Math.min(count, 3 - from) }, (_, i) => [from + i, `n${from + i}`]),
      ),
    );
    const fixture = TestBed.createComponent(ResultGrid);
    fixture.componentRef.setInput('result', result);
    fixture.componentRef.setInput('rows', 3);
    fixture.componentRef.setInput('fetch', fetch);
    const settle = async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();
    };
    await settle();
    return { fixture, fetch, settle, settings: TestBed.inject(SettingsService) };
  }

  it('keeps its table when a setting changes that is not about it', async () => {
    const { fetch, settle, settings } = await show();
    expect(fetch).toHaveBeenCalledTimes(1);
    // the value panel, the search row, the sidebar …: the rows on screen stay, with cursor and position
    settings.update({ valuePanelVisible: true, sidebarWidth: 300 });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    // the row height is part of the table: that one builds it again
    settings.update({ resultRowHeight: 30 });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
