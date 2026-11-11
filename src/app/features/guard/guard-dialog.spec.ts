import { TestBed } from '@angular/core/testing';
import { GuardDialog } from './guard-dialog';
import { GuardAnswer, GuardRequest } from './guard-logic';

const CONNECTION = {
  name: 'Kasse Hamburg',
  database: 'shop',
  label: 'PROD',
  protection: 'ask' as const,
  color: 2,
};
const WRITE: GuardRequest = {
  connection: CONNECTION,
  statements: [
    { sql: 'UPDATE t SET a = 1 WHERE b = 2', verdict: { class: 'write', need: 'confirm' } },
  ],
  total: 1,
};
const DANGEROUS: GuardRequest = {
  connection: CONNECTION,
  statements: [
    ...WRITE.statements,
    { sql: 'DELETE FROM <b>kunde</b>', verdict: { class: 'dangerous', need: 'type_name' } },
  ],
  total: 3,
};

describe('GuardDialog', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    TestBed.resetTestingModule();
  });

  async function open(request: GuardRequest) {
    const fixture = TestBed.createComponent(GuardDialog);
    fixture.componentRef.setInput('request', request);
    const answers: (GuardAnswer | null)[] = [];
    fixture.componentInstance.answered.subscribe((a) => answers.push(a));
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement, answers };
  }

  it('names the connection, the database and the statement, as text', async () => {
    const { el } = await open(DANGEROUS);
    expect(el.querySelector('.where')?.textContent).toContain('Kasse Hamburg');
    expect(el.querySelector('.where')?.textContent).toContain('shop');
    expect(el.querySelector('.badge')?.textContent).toBe('PROD');
    expect(el.querySelectorAll('pre')[1].textContent).toBe('DELETE FROM <b>kunde</b>');
    expect(el.querySelector('pre b')).toBeNull();
    expect(el.querySelector('.note')?.textContent).toContain('3 Anweisungen');
  });

  it('runs a write on a yes and nothing on a no', async () => {
    const { el, answers } = await open(WRITE);
    expect(el.querySelector('#guard-name')).toBeNull();
    // the focus is on the way out, not on the way in
    expect(document.activeElement?.textContent).toBe('Abbrechen');
    el.querySelector<HTMLButtonElement>('footer button')!.click();
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    expect(answers).toEqual([null, { typedName: null }]);
  });

  it('wants the name typed before what destroys can run', async () => {
    const { fixture, el, answers } = await open(DANGEROUS);
    const field = el.querySelector<HTMLInputElement>('#guard-name')!;
    const go = el.querySelector<HTMLButtonElement>('button.danger')!;
    expect(go.disabled).toBe(true);
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    expect(answers).toEqual([]);
    field.value = 'kasse hamburg';
    field.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(go.disabled).toBe(true);
    field.value = 'Kasse Hamburg';
    field.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(go.disabled).toBe(false);
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    expect(answers).toEqual([{ typedName: 'Kasse Hamburg' }]);
  });

  it('says no on Escape', async () => {
    const { el, answers } = await open(WRITE);
    el.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(answers).toEqual([null]);
  });
});
