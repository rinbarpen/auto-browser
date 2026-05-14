import { describe, expect, it } from 'vitest';
import { resolveHeadlessMode } from '../src/workbench/runtime';

describe('resolveHeadlessMode', () => {
  it('forces headless when the environment has no display server', () => {
    expect(resolveHeadlessMode({ requestedHeadless: false, hasDisplayServer: false })).toBe(true);
  });

  it('preserves headed mode when a display server is available', () => {
    expect(resolveHeadlessMode({ requestedHeadless: false, hasDisplayServer: true })).toBe(false);
  });

  it('keeps explicit headless mode untouched', () => {
    expect(resolveHeadlessMode({ requestedHeadless: true, hasDisplayServer: false })).toBe(true);
  });
});
