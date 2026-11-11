import { describe, expect, it } from 'vitest';
import { MAX_BLOCK_ROWS, parseBlock, separatorOf } from './block-parser';

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

  it('reads CSV with commas or semicolons when there is no tab', () => {
    expect(separatorOf('a,b;c,d')).toBe(',');
    expect(separatorOf('a;b;c,d')).toBe(';');
    expect(separatorOf('a,b\tc')).toBe('\t');
    expect(parseBlock('id,name\n1,"Smith, J."').rows).toEqual([
      ['id', 'name'],
      ['1', 'Smith, J.'],
    ]);
    expect(parseBlock('1;2,5;x').rows).toEqual([['1', '2,5', 'x']]);
  });

  it('takes no more rows than its limit and says so', () => {
    const many = Array.from({ length: MAX_BLOCK_ROWS + 3 }, (_, i) => String(i)).join('\n');
    const block = parseBlock(many);
    expect(block.rows).toHaveLength(MAX_BLOCK_ROWS);
    expect(block.cut).toBe(true);
    expect(parseBlock('a\nb').cut).toBe(false);
  });
});
