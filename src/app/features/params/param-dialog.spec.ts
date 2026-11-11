import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsService } from '../../core/settings/settings.service';
import { ParamDialog } from './param-dialog';
import { ParamValue } from './param-logic';
import { ParamService } from './param.service';

describe('ParamDialog', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
    TestBed.configureTestingModule({ imports: [ParamDialog] });
  });

  function open(sqls: string[], values: Record<string, ParamValue> = {}) {
    const service = TestBed.inject(ParamService);
    const answered = service.ask({ connectionId: 'pg-1', dialect: 'postgres', sqls, values });
    const fixture = TestBed.createComponent(ParamDialog);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const names = () => [...el.querySelectorAll('.name')].map((n) => n.textContent?.trim());
    const field = (i: number) => el.querySelector<HTMLInputElement>(`#param-${i}`)!;
    const type = (i: number, text: string) => {
      field(i).value = text;
      field(i).dispatchEvent(new Event('input'));
      fixture.detectChanges();
    };
    const choose = (i: number, value: string) => {
      const select = el.querySelectorAll<HTMLSelectElement>('select.type')[i];
      select.value = value;
      select.dispatchEvent(new Event('change'));
      fixture.detectChanges();
    };
    const submit = () => {
      el.querySelector('form')!.dispatchEvent(new Event('submit'));
      fixture.detectChanges();
    };
    return { service, answered, fixture, el, names, field, type, choose, submit };
  }

  it('shows a labelled field per parameter with the value given last, and the first has the focus', async () => {
    const { el, names, field } = open(['select :kunde, :ab', 'select :kunde'], {
      kunde: { type: 'auto', text: '42' },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(names()).toEqual(['kunde', 'ab']);
    expect(field(0).value).toBe('42');
    expect(field(0).getAttribute('aria-label')).toBe('Wert von kunde');
    expect(document.activeElement).toBe(field(0));
    // what `Automatic` reads the text as is said
    expect(el.querySelector('#param-reads-0')?.textContent).toBe('ganze Zahl');
    expect(el.querySelector('#param-reads-1')?.textContent).toBe('Text');
  });

  it('answers with the values on Enter (submit) and closes', async () => {
    const { service, answered, type, choose, submit } = open(['select :kunde, :ab']);
    type(0, '7');
    choose(1, 'date');
    type(1, '11.11.2026');
    submit();
    expect(await answered).toEqual({
      kunde: { type: 'auto', text: '7' },
      ab: { type: 'date', text: '11.11.2026' },
    });
    expect(service.request()).toBeNull();
  });

  it('does not answer while a value is not what its type says, and names the parameter', async () => {
    const { el, service, type, choose, submit, field } = open(['select :ab']);
    choose(0, 'date');
    type(0, 'gestern');
    submit();
    expect(service.request()).not.toBeNull();
    expect(el.querySelector('[role=alert]')?.textContent).toContain('ab ist kein Datum');
    expect(field(0).getAttribute('aria-invalid')).toBe('true');
    type(0, '2026-01-01');
    expect(el.querySelector('[role=alert]')).toBeNull();
  });

  it('reads a value in an IN (…) as a list without being told', () => {
    const { el, type } = open(['select * from t where id in (:ids)']);
    type(0, '1, 2, 3');
    expect(el.querySelector('#param-reads-0')?.textContent).toBe('3 Einträge');
  });

  it('answers no on cancel', async () => {
    const { el, answered } = open(['select :a']);
    el.querySelector<HTMLButtonElement>('footer button')!.click();
    expect(await answered).toBeNull();
  });

  it('sets which forms are parameters on this connection, and the fields follow', () => {
    const { el, names, fixture } = open(["select :a, j ? 'k', $1"]);
    expect(names()).toEqual(['a', '$1']);
    const boxes = () => [...el.querySelectorAll<HTMLInputElement>('.forms input')];
    const labels = [...el.querySelectorAll('.forms code')].map((c) => c.textContent);
    expect(labels).toEqual([':name', '${name}', '?', '$1', '$name', '@name']);
    expect(boxes().map((b) => b.checked)).toEqual([true, true, false, true, false, false]);
    // `?` on: the JSON operator of this statement becomes a parameter – the user's choice
    boxes()[2].checked = true;
    boxes()[2].dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(names()).toEqual(['a', '?1', '$1']);
    const settings = TestBed.inject(SettingsService);
    expect(settings.settings().paramForms).toEqual({
      'pg-1': ['colon', 'brace', 'question', 'dollarNumber'],
    });
    el.querySelector<HTMLButtonElement>('.forms button')!.click();
    fixture.detectChanges();
    expect(names()).toEqual(['a', '$1']);
    expect(settings.settings().paramForms).toEqual({});
  });

  it('a NULL has no text to type and a list takes lines', () => {
    const { el, choose, field } = open(['select :a']);
    choose(0, 'null');
    expect(field(0).disabled).toBe(true);
    expect(el.querySelector('#param-reads-0')?.textContent).toBe('NULL');
    choose(0, 'list');
    expect(el.querySelector('textarea#param-0')).not.toBeNull();
    expect(el.querySelector('#param-reads-0')?.textContent).toBe('0 Einträge');
  });
});
