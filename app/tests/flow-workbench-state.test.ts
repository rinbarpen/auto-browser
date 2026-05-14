import { describe, expect, it } from 'vitest';
import { applyOpenSessionFailure, applyOpenSessionSuccess } from '../components/flow-workbench-state';

describe('flow workbench preview session state', () => {
  it('marks the preview session ready after a successful session creation', () => {
    expect(applyOpenSessionSuccess('session-123')).toEqual({
      sessionError: null,
      sessionId: 'session-123',
      statusText: 'Preview session ready',
    });
  });

  it('keeps the preview offline and surfaces the backend error when session creation fails', () => {
    expect(applyOpenSessionFailure('page.goto failed')).toEqual({
      sessionError: 'page.goto failed',
      sessionId: null,
      statusText: 'Preview unavailable',
    });
  });
});
