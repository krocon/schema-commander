import {
  JsonLayout,
  bytesOf,
  dateForms,
  drawable,
  hexDump,
  languageOf,
  layoutJson,
  layoutXml,
  numberForms,
  sizeText,
  viewsOf,
} from './value-logic';

const facts = (over: Partial<Parameters<typeof viewsOf>[0]>) => ({
  kind: 'text' as const,
  column: 'text' as const,
  start: '',
  total: 10,
  image: null,
  ...over,
});
const png = (width: number, height: number) => ({ mime: 'image/png' as const, width, height });
/** A text without its blanks outside strings: what laying out must not change. */
const tokens = (json: string) => json.replace(/("(?:\\.|[^"\\])*")|\s+/g, (_, s) => s ?? '');

describe('which view a value gets', () => {
  it('chooses by the column and by how the text starts', () => {
    expect(viewsOf(facts({ start: 'hello' }))).toEqual(['text']);
    expect(viewsOf(facts({ column: 'json', start: '42' }))).toEqual(['json', 'text']);
    expect(viewsOf(facts({ start: ' {"a": 1}' }))).toEqual(['json', 'text']);
    expect(viewsOf(facts({ start: '[1, 2]' }))).toEqual(['json', 'text']);
    // a bracket alone is no JSON: `{not json}` and `[draft] title`… the second one is an array start
    expect(viewsOf(facts({ start: '{not json}' }))).toEqual(['text']);
    expect(viewsOf(facts({ start: '<?xml version="1.0"?><a/>' }))).toEqual(['xml', 'text']);
    expect(viewsOf(facts({ start: '<order id="1">' }))).toEqual(['xml', 'text']);
    expect(viewsOf(facts({ start: '< 5 and > 3' }))).toEqual(['text']);
    expect(viewsOf(facts({ column: 'int', start: '255' }))).toEqual(['text', 'number']);
    expect(viewsOf(facts({ column: 'timestampTz', start: '2026-11-11 12:00:00+01:00' }))).toEqual([
      'text',
      'date',
    ]);
    expect(viewsOf(facts({ kind: 'null' }))).toEqual(['text']);
    expect(viewsOf(facts({ kind: 'unreadable', start: 'GEOMETRY' }))).toEqual(['text']);
    expect(languageOf('json')).toBe('JSON');
    expect(languageOf('hex')).toBe('');
  });

  it('draws a picture only when its header is one the window can afford', () => {
    const bytes = (image: ReturnType<typeof png> | null, total = 5000) =>
      viewsOf(facts({ kind: 'bytes', column: 'bytes', image, total }));
    expect(bytes(png(640, 480))).toEqual(['image', 'hex']);
    expect(bytes(null)).toEqual(['hex']);
    // a header that claims a huge picture, or a file too big to be one: bytes, nothing is decoded
    expect(bytes(png(4_000_000_000, 4_000_000_000))).toEqual(['hex']);
    expect(bytes(png(20_000, 100))).toEqual(['hex']);
    expect(bytes(png(12_000, 12_000))).toEqual(['hex']);
    expect(bytes(png(640, 480), 64 * 1024 * 1024)).toEqual(['hex']);
    // no size in what was read (a JPEG with much metadata): only when the data is small
    expect(drawable({ mime: 'image/jpeg', width: 0, height: 0 }, 100_000)).toBe(true);
    expect(drawable({ mime: 'image/jpeg', width: 0, height: 0 }, 10_000_000)).toBe(false);
    expect(drawable({ mime: 'image/svg+xml' as never, width: 10, height: 10 }, 100)).toBe(false);
  });
});

describe('laying out JSON', () => {
  it('puts a member on each line and changes no value', () => {
    const json =
      '{"id":12345678901234567890123,"name":"a  b: {x}, [y]","tags":["x","y"],"n":null,"e":{},"l":[],"q":"\\"\\\\"}';
    const out = layoutJson(json);
    expect(out).toBe(
      [
        '{',
        '  "id": 12345678901234567890123,',
        '  "name": "a  b: {x}, [y]",',
        '  "tags": [',
        '    "x",',
        '    "y"',
        '  ],',
        '  "n": null,',
        '  "e": {},',
        '  "l": [],',
        '  "q": "\\"\\\\"',
        '}',
      ].join('\n'),
    );
    expect(tokens(out)).toBe(tokens(json));
    // laid out again: the same
    expect(layoutJson(out)).toBe(out);
  });

  it('keeps what JSON.parse would change: long numbers, keys that occur twice, their order', () => {
    const json = '{"b":1.10,"a":1e400,"b":0.1000000000000000055511151231257827}';
    expect(tokens(layoutJson(json))).toBe(tokens(json));
  });

  it('never loses a character of broken JSON', () => {
    for (const broken of [
      '{"a": [1, 2',
      '{"a": "open',
      '}}]] x',
      '{"a" "b" 1 2}',
      '{a: 1, b: undefined}',
      '[1,,2,]',
      '{"a":}',
      '',
      '   ',
      'plain text',
    ]) {
      expect(tokens(layoutJson(broken)), broken).toBe(tokens(broken));
    }
    expect(layoutJson('{"a" "b"}')).toBe('{\n  "a" "b"\n}');
  });

  it('works in steps and says how far it is', () => {
    const json = JSON.stringify({
      rows: Array.from({ length: 500 }, (_, i) => ({ i, s: `v${i}` })),
    });
    const layout = new JsonLayout(json);
    let steps = 0;
    while (!layout.done) {
      layout.step(1000);
      steps++;
      expect(layout.progress).toBeGreaterThan(0);
    }
    expect(steps).toBeGreaterThan(5);
    expect(layout.result()).toBe(layoutJson(json));
    expect(JSON.parse(layout.result())).toEqual(JSON.parse(json));
  });

  it('lays out megabytes in a time a person does not notice', () => {
    const json = JSON.stringify(
      Array.from({ length: 40_000 }, (_, i) => ({
        id: i,
        name: `Kunde ${i}`,
        tags: ['a', 'b'],
        ok: true,
      })),
    );
    expect(json.length).toBeGreaterThan(2_000_000);
    const started = Date.now();
    const out = layoutJson(json);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out.split('\n').length).toBeGreaterThan(200_000);
  });
});

describe('laying out XML', () => {
  it('indents elements and keeps short text with its element', () => {
    expect(
      layoutXml(
        '<?xml version="1.0"?><order id="1"><item>Köln &amp; Bonn</item><empty/><!-- note --><n><![CDATA[a < b]]></n></order>',
      ),
    ).toBe(
      [
        '<?xml version="1.0"?>',
        '<order id="1">',
        '  <item>Köln &amp; Bonn</item>',
        '  <empty/>',
        '  <!-- note -->',
        '  <n>',
        '    <![CDATA[a < b]]>',
        '  </n>',
        '</order>',
      ].join('\n'),
    );
  });

  it('leaves what is no XML alone and survives what is broken', () => {
    expect(layoutXml('a < b and c > d')).toBe('a < b and c > d');
    expect(layoutXml('plain')).toBe('plain');
    expect(layoutXml('</a></b><c>')).toBe('</a>\n</b>\n<c>');
  });
});

describe('other views', () => {
  it('shows bytes as hex with their ASCII', () => {
    const bytes = bytesOf(btoa('Hello, World! \u0000\u00ff12345'));
    expect(hexDump(bytes)).toBe(
      [
        '00000000  48 65 6c 6c 6f 2c 20 57  6f 72 6c 64 21 20 00 ff  Hello, World! ..',
        '00000010  31 32 33 34 35                                    12345',
      ].join('\n'),
    );
    expect(hexDump(new Uint8Array([1]), 0x1000)).toContain('00001000  01');
    expect(hexDump(new Uint8Array())).toBe('');
  });

  it('shows a whole number in other bases, exactly', () => {
    expect(numberForms('255')).toEqual({ decimal: '255', hex: '0xFF', binary: '0b11111111' });
    expect(numberForms('-1234567')).toEqual({
      decimal: '-1 234 567',
      hex: '-0x12 D687',
      binary: '-0b10010 11010110 10000111',
    });
    expect(numberForms('18446744073709551615')?.hex).toBe('0xFFFF FFFF FFFF FFFF');
    expect(numberForms('1.5')).toBeNull();
    expect(numberForms('abc')).toBeNull();
  });

  it('shows an instant in UTC and a time without a zone as it is', () => {
    const instant = dateForms('2026-11-11 12:30:00+01:00', 'timestampTz');
    expect(instant?.utc).toBe('2026-11-11 11:30:00Z');
    expect(instant?.epoch).toBe('1794396600');
    expect(instant?.local).toMatch(/^2026-11-1[12] \d\d:\d\d:00$/);
    // no zone: not moved – only the day of the week (a Wednesday)
    expect(dateForms('2026-11-11 23:59:59', 'timestamp')).toEqual({
      utc: null,
      local: null,
      epoch: null,
      weekday: 3,
    });
    expect(dateForms('2026-11-11', 'date')?.weekday).toBe(3);
    expect(dateForms('gestern', 'date')).toBeNull();
    expect(dateForms('2026-13-45', 'date')).toBeNull();
  });

  it('writes sizes for people', () => {
    expect(sizeText(512)).toBe('512 B');
    expect(sizeText(1536)).toBe('1.5 KB');
    expect(sizeText(50 * 1024 * 1024)).toBe('50.0 MB');
  });
});
