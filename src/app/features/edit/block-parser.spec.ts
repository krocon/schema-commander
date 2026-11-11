import { describe, expect, it } from 'vitest';
import { MAX_BLOCK_ROWS, parseBlock } from './block-parser';

describe('block-parser', () => {
  it('reads what a spreadsheet copies: tabs, and a last line break that is no row', () => {
    expect(parseBlock('a\tb\n1\t2\r\n').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseBlock('one').rows).toEqual([['one']]);
    expect(parseBlock('').rows).toEqual([]);
    // an empty cell is a cell, an empty line between rows is a row
    expect(parseBlock('a\t\tc\n\nx').rows).toEqual([['a', '', 'c'], [''], ['x']]);
    expect(parseBlock('a\t\n').rows).toEqual([['a', '']]);
  });

  it('reads quoted cells: tabs, line breaks and quotes inside', () => {
    expect(parseBlock('"two\nlines"\t"say ""hi"""\t"a\tb"\nnext').rows).toEqual([
      ['two\nlines', 'say "hi"', 'a\tb'],
      ['next'],
    ]);
    // a quote in the middle of a cell is a character
    expect(parseBlock('5" pipe\tok').rows).toEqual([['5" pipe', 'ok']]);
    expect(parseBlock('""\tx').rows).toEqual([['', 'x']]);
  });

  it('never guesses a separator: without a tab every line is one cell (review 032)', () => {
    // one column of a spreadsheet: decimal commas and names with commas stay one cell
    expect(parseBlock('1,5\n2,7').rows).toEqual([['1,5'], ['2,7']]);
    expect(parseBlock('Smith, John\nDoe; Jane').rows).toEqual([['Smith, John'], ['Doe; Jane']]);
  });

  it('takes a quote for a quote unless it wraps the whole cell (review 032)', () => {
    // a cell that only starts with a quote does not swallow the cells behind it
    expect(parseBlock('"Hello\tb\nnext\tc').rows).toEqual([
      ['"Hello', 'b'],
      ['next', 'c'],
    ]);
    expect(parseBlock('"abc" def\tx').rows).toEqual([['"abc" def', 'x']]);
    // quoted to the end of the cell: the quotes go
    expect(parseBlock('"a\tb"\t"c"').rows).toEqual([['a\tb', 'c']]);
    expect(parseBlock('"say ""hi"""').rows).toEqual([['say "hi"']]);
    expect(parseBlock('"open to the end').rows).toEqual([['"open to the end']]);
  });

  it('takes no more rows than its limit and says so', () => {
    const many = Array.from({ length: MAX_BLOCK_ROWS + 3 }, (_, i) => String(i)).join('\n');
    const block = parseBlock(many);
    expect(block.rows).toHaveLength(MAX_BLOCK_ROWS);
    expect(block.cut).toBe(true);
    expect(parseBlock('a\nb').cut).toBe(false);
  });
});
