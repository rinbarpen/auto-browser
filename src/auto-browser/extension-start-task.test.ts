import { describe, expect, it } from 'vitest';
import { resolveAutomationTabUrl } from '../../extension/start-task.js';

describe('extension start task helpers', () => {
  it('keeps http and https pages as the dedicated automation tab target', () => {
    expect(resolveAutomationTabUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
    expect(resolveAutomationTabUrl('http://example.com')).toBe('http://example.com/');
  });

  it('falls back to about:blank for unsupported pages', () => {
    expect(resolveAutomationTabUrl('chrome://extensions')).toBe('about:blank');
    expect(resolveAutomationTabUrl('about:blank')).toBe('about:blank');
    expect(resolveAutomationTabUrl('not a url')).toBe('about:blank');
    expect(resolveAutomationTabUrl('')).toBe('about:blank');
  });
});
