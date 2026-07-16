import { describe, expect, it } from 'vitest';
import { keyboardTabIndex } from './tabs.js';

describe('keyboardTabIndex', () => {
  it('moves and wraps through horizontal tabs', () => {
    expect(keyboardTabIndex('ArrowRight', 2, 3)).toBe(0);
    expect(keyboardTabIndex('ArrowLeft', 0, 3)).toBe(2);
  });

  it('supports Home and End without intercepting unrelated keys', () => {
    expect(keyboardTabIndex('Home', 2, 4)).toBe(0);
    expect(keyboardTabIndex('End', 0, 4)).toBe(3);
    expect(keyboardTabIndex('Enter', 1, 4)).toBeUndefined();
  });
});
