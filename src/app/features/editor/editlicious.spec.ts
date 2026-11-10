import { editorScheme } from './editlicious';

describe('editorScheme', () => {
  it('maps schemes with a counterpart and falls back by brightness', () => {
    expect(editorScheme('amber', true)).toBe('amber');
    expect(editorScheme('one-dark', true)).toBe('one');
    expect(editorScheme('matrix', true)).toBe('one');
    expect(editorScheme('light', false)).toBe('paper');
    expect(editorScheme('unknown', false)).toBe('paper');
  });
});
