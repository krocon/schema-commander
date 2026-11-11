import { nextArea } from './app';

describe('nextArea', () => {
  const areas = ['sidebar', 'editor', 'result'] as const;

  it('goes around in both directions', () => {
    expect(nextArea(areas, 'sidebar', 1)).toBe('editor');
    expect(nextArea(areas, 'result', 1)).toBe('sidebar');
    expect(nextArea(areas, 'sidebar', -1)).toBe('result');
  });

  it('starts at an end without a current area and skips a hidden sidebar', () => {
    expect(nextArea(areas, null, 1)).toBe('sidebar');
    expect(nextArea(areas, null, -1)).toBe('result');
    expect(nextArea(['editor', 'result'], 'sidebar', 1)).toBe('editor');
    expect(nextArea(['editor', 'result'], 'result', 1)).toBe('editor');
  });
});
