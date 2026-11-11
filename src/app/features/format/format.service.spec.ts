import { TestBed } from '@angular/core/testing';
import { FORMAT_JOB_BASE, FormatApi } from '../../core/format/format-api';
import { SettingsService } from '../../core/settings/settings.service';
import { FakeFormatApi } from '../../../testing/fake-apis';
import { BIG_TEXT } from './format-logic';
import { FormatService } from './format.service';

describe('FormatService', () => {
  let api: FakeFormatApi;
  let service: FormatService;

  beforeEach(() => {
    api = new FakeFormatApi();
    TestBed.configureTestingModule({ providers: [{ provide: FormatApi, useValue: api }] });
    service = TestBed.inject(FormatService);
  });

  it('formats with the style of the settings, as a job of its own number range', async () => {
    TestBed.inject(SettingsService).update({ formatIndent: 2, formatKeywordCase: 'lower' });
    expect(await service.run('select 1', 'mysql', 'format', true)).toBe('SELECT 1');
    expect(api.calls).toEqual([
      {
        jobId: FORMAT_JOB_BASE,
        sql: 'select 1',
        dialect: 'mysql',
        mode: 'format',
        crlf: true,
        style: {
          keywordCase: 'lower',
          indent: 2,
          comma: 'trailing',
          width: 100,
          andOr: 'leading',
          blankLines: 1,
        },
      },
    ]);
    expect(service.running()).toBe(false);
  });

  it('formats one text at a time and stops the one that runs', async () => {
    api.hold = true;
    const first = service.run('a', 'postgres', 'format', false);
    expect(service.running()).toBe(true);
    // a short text does not show in the status line
    expect(service.visible()).toBe(false);
    expect(await service.run('b', 'postgres', 'format', false)).toBeNull();
    service.cancel();
    expect(api.cancelled).toEqual([FORMAT_JOB_BASE]);
    api.finish();
    expect(await first).toBe('A');
    expect(service.running()).toBe(false);
    service.cancel();
    expect(api.cancelled).toHaveLength(1);
  });

  it('shows a long text in the status line while it is formatted', async () => {
    api.hold = true;
    const run = service.run('x'.repeat(BIG_TEXT), 'postgres', 'upper', false);
    expect(service.visible()).toBe(true);
    api.finish();
    await run;
    expect(service.visible()).toBe(false);
  });

  it('is free again after a refusal and says what happened', async () => {
    api.fail = { code: 'format_incomplete', message: 'x' };
    const refused = await service.run('a', 'postgres', 'format', false).catch((e) => e);
    expect(service.running()).toBe(false);
    expect(service.failure(refused)).toContain('Nicht formatiert');
    expect(service.failure({ code: 'cancelled', message: '' })).toContain('abgebrochen');
    expect(service.notice('done')).toBeNull();
    expect(service.notice('unchanged')).toContain('Nichts zu ändern');
    expect(service.notice('stale')).toContain('bearbeitet');
  });

  it('formats the sample of the settings dialog in the style asked for', async () => {
    const style = {
      keywordCase: 'preserve',
      indent: 3,
      comma: 'leading',
      width: 60,
      andOr: 'trailing',
      blankLines: 0,
    } as const;
    await service.preview(style);
    expect(api.calls[0].style).toEqual(style);
    expect(api.calls[0].mode).toBe('format');
    expect(service.running()).toBe(false);
  });
});
