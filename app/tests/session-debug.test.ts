import { describe, expect, it, vi } from 'vitest';
import { buildSessionDebugResponse } from '../src/workbench/session-debug';

describe('buildSessionDebugResponse', () => {
  it('returns a dev-only debug payload for active sessions', async () => {
    const runtime = {
      getSession: vi.fn().mockReturnValue({ id: 'session-1' }),
      getRecordingDebugSnapshot: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        pageUrl: 'http://localhost:3000/',
        recording: {
          id: 'recording-1',
          events: [],
          pendingInputTarget: null,
          hasPendingInputTimer: false,
        },
        activeInput: null,
      }),
    };

    const response = await buildSessionDebugResponse({
      isDev: true,
      runtime: runtime as any,
      sessionId: 'session-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      sessionId: 'session-1',
      recording: {
        id: 'recording-1',
      },
    });
  });

  it('hides the debug endpoint outside development', async () => {
    const runtime = {
      getSession: vi.fn(),
      getRecordingDebugSnapshot: vi.fn(),
    };

    const response = await buildSessionDebugResponse({
      isDev: false,
      runtime: runtime as any,
      sessionId: 'session-1',
    });

    expect(response).toEqual({
      statusCode: 404,
      payload: { error: 'Not found' },
    });
    expect(runtime.getSession).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown sessions', async () => {
    const runtime = {
      getSession: vi.fn().mockReturnValue(null),
      getRecordingDebugSnapshot: vi.fn(),
    };

    const response = await buildSessionDebugResponse({
      isDev: true,
      runtime: runtime as any,
      sessionId: 'missing-session',
    });

    expect(response).toEqual({
      statusCode: 404,
      payload: { error: 'Session not found' },
    });
    expect(runtime.getRecordingDebugSnapshot).not.toHaveBeenCalled();
  });
});
