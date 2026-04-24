import { describe, expect, it } from 'vitest';
import { modeClearsInputValueOnRender } from '../input/modeRenderPolicy';

describe('modeClearsInputValueOnRender', () => {
  it('clears stale input for display-only modes', () => {
    expect(modeClearsInputValueOnRender('normal')).toBe(true);
    expect(modeClearsInputValueOnRender('view')).toBe(true);
    expect(modeClearsInputValueOnRender('terminal')).toBe(true);
    expect(modeClearsInputValueOnRender('pane-search')).toBe(true);
  });

  it('preserves editable input for typing modes', () => {
    expect(modeClearsInputValueOnRender('ai')).toBe(false);
    expect(modeClearsInputValueOnRender('insert')).toBe(false);
    expect(modeClearsInputValueOnRender('pane-selector')).toBe(false);
  });
});
