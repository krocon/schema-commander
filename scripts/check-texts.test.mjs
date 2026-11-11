import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSource, checkTemplate } from './check-texts.mjs';

const kinds = (template) => checkTemplate(template).map((p) => `${p.kind}: ${p.text}`);

test('a text node with a word is a problem, symbols and bindings are not', () => {
  assert.deepEqual(kinds('<button>Save</button>'), ['text: Save']);
  assert.deepEqual(kinds('<button>{{ t.save }}</button><span>×</span><b>TX</b>'), []);
  assert.deepEqual(kinds('<p>\n  Loading …\n</p>'), ['text: Loading …']);
});

test('control flow and comments are no text', () => {
  const template = `
    @if (state() === 'ready' && (a || b)) {
      <!-- A tab is built when it is first shown -->
      @let shown = tabs.shownIds().includes(tab.id);
      @for (tab of tabs(); track tab.id; let i = $index) { <i></i> } @empty { <b>{{ t.none }}</b> }
    } @else if (x) { <i></i> } @else { <i></i> }
    @switch (kind()) { @case ('done') { <i></i> } @default { <i></i> } }
    @defer (on immediate) { <app-x /> }`;
  assert.deepEqual(kinds(template), []);
});

test('static text attributes are a problem, bound ones are checked for literals', () => {
  assert.deepEqual(kinds('<input placeholder="Search" aria-label="Search the list" />'), [
    'attribute: Search',
    'attribute: Search the list',
  ]);
  assert.deepEqual(kinds(`<b [title]="'New tab' + actions.hint('NEW_TAB')"></b>`), [
    'literal: New tab',
  ]);
  assert.deepEqual(kinds(`<b [title]="t.newTab + actions.hint('NEW_TAB')"></b>`), []);
  assert.deepEqual(kinds(`<b>{{ manual() ? 'Tx: manual' : t.auto }}</b>`), ['literal: Tx: manual']);
});

test('names for the machine are no texts', () => {
  const template = `
    <div role="tab" class="tab active" [class]="'tab conn-' + color" [id]="'tab-' + id"
      [attr.aria-controls]="'pane-' + id" (click)="run('SPLIT_RIGHT'); go(a > b ? 'row' : 'column')"
      (keydown)="$event.key === 'ArrowLeft' && back()" [style.width.px]="w()" type="button"></div>`;
  assert.deepEqual(kinds(template), []);
});

test('a value with > does not end the tag', () => {
  assert.deepEqual(kinds(`<b (click)="list.filter((x) => x > 1)" title="Hello there"></b>`), [
    'attribute: Hello there',
  ]);
});

test('texts-ok lets a line pass', () => {
  assert.deepEqual(kinds('<!-- texts-ok: a product name -->\n<b>Schema Commander</b>'), []);
});

test('German outside the German catalogs is a problem', () => {
  const source = "export const A = 'Schließen';\nconst b = 'Größe'; // texts-ok: test data\n";
  assert.deepEqual(
    checkSource('a.ts', source).map((p) => `${p.line} ${p.kind}`),
    ['1 german'],
  );
  assert.deepEqual(checkSource('a.de.ts', source), []);
});

test('finds the templates of a component with their line', () => {
  const source =
    "@Component({\n  selector: 'x',\n  template: `\n    <p>Hello you</p>\n  `,\n})\nclass X {}\n";
  assert.deepEqual(checkSource('x.ts', source), [{ line: 4, kind: 'text', text: 'Hello you' }]);
});
