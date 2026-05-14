import { describe, expect, it } from 'vitest';
import {
  createEmptySession,
  getOrigin,
  hostPatternForOrigin,
  reduceSession,
  shouldRequestPermission,
} from '../../extension/background-state.js';

describe('extension background session helpers', () => {
  it('normalizes origins and host patterns', () => {
    expect(getOrigin('https://example.com/path?q=1')).toBe('https://example.com');
    expect(getOrigin('chrome://extensions')).toBeNull();
    expect(hostPatternForOrigin('https://example.com')).toBe('https://example.com/*');
  });

  it('decides when a new permission request is needed', () => {
    const session = reduceSession(createEmptySession(), {
      origin: 'https://example.com',
      permission: 'granted',
    });
    expect(shouldRequestPermission(session, 'https://example.com')).toBe(false);
    expect(shouldRequestPermission(session, 'https://news.ycombinator.com')).toBe(true);
  });
});
