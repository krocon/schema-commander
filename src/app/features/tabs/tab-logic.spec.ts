import {
  autoTitle,
  backupDelay,
  cleanTitle,
  cycled,
  fileName,
  moved,
  neighbour,
  newTabId,
  untitled,
} from './tab-logic';

describe('tab logic', () => {
  it('takes the table of the first statement as the title', () => {
    expect(autoTitle('SELECT * FROM orders;')).toBe('orders');
    expect(autoTitle('-- Kunden\n\nselect c.name from public."Kunden Liste" c join x on 1=1')).toBe(
      'public.Kunden',
    );
    expect(autoTitle('/* Kopf */ UPDATE `shop`.`product` SET stock = 0')).toBe('shop.product');
    expect(autoTitle('INSERT INTO log VALUES (1)')).toBe('log');
    expect(autoTitle('CREATE TABLE IF NOT EXISTS étudiants (id int)')).toBe('étudiants');
    expect(autoTitle('select * from [dbo].[Bestellung]')).toBe('dbo.Bestellung');
  });

  it('falls back to the beginning of the first line, or to nothing', () => {
    expect(autoTitle('SELECT 1 + 1')).toBe('SELECT 1 + 1');
    expect(autoTitle('SELECT   now()\n, 2')).toBe('SELECT now()');
    expect(autoTitle('select ' + 'x, '.repeat(40))).toHaveLength(40);
    expect(autoTitle('  \n-- nur ein Kommentar\n/* und noch einer')).toBeNull();
    expect(autoTitle('')).toBeNull();
    // a later statement does not name the tab
    expect(autoTitle('SELECT 1; SELECT * FROM orders')).toBe('SELECT 1');
  });

  it('does not read a huge script to its end', () => {
    const huge = 'SELECT * FROM start;\n' + 'x'.repeat(5_000_000);
    const started = performance.now();
    expect(autoTitle(huge)).toBe('start');
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('makes ids and names that are free', () => {
    expect(newTabId(new Set())).toBe('tab-1');
    expect(newTabId(new Set(['tab-1', 'tab-3']))).toBe('tab-2');
    expect(untitled(new Set())).toBe('Abfrage');
    expect(untitled(new Set(['Abfrage', 'Abfrage 2']))).toBe('Abfrage 3');
  });

  it('cleans a typed title', () => {
    expect(cleanTitle('  Kunden\n Übersicht ')).toBe('Kunden Übersicht');
    expect(cleanTitle(' \t ')).toBeNull();
    expect([...cleanTitle('x'.repeat(300))!].length).toBe(100);
  });

  it('knows the name of a file on every system', () => {
    expect(fileName('/home/a/Meine Abfrage.sql')).toBe('Meine Abfrage.sql');
    expect(fileName('C:\\Users\\a\\x.sql')).toBe('x.sql');
    expect(fileName('x.sql')).toBe('x.sql');
  });

  it('moves, picks a neighbour and cycles', () => {
    expect(moved(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moved(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moved(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
    expect(neighbour(0, 3)).toBe(1);
    expect(neighbour(2, 3)).toBe(1);
    expect(neighbour(0, 1)).toBe(-1);
    expect(cycled(2, 3, 1)).toBe(0);
    expect(cycled(0, 3, -1)).toBe(2);
  });

  it('waits longer before backing up huge texts', () => {
    expect(backupDelay(1000)).toBeLessThan(backupDelay(10_000_000));
    expect(backupDelay(10_000_000)).toBeLessThan(backupDelay(200_000_000));
  });
});
