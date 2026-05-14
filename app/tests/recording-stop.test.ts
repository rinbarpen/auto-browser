import { describe, expect, it, vi } from 'vitest';
import { buildRecordingStopResponse } from '../src/workbench/recording-stop';

describe('buildRecordingStopResponse', () => {
  it('persists derived steps back into the source flow', async () => {
    const savedFlow = {
      id: 'flow-1',
      name: 'Replay smoke flow',
      startUrl: 'http://localhost:3000/',
      sessionConfig: {
        sessionName: 'flow-flow-1',
        viewport: { width: 1440, height: 900 },
        headless: false,
        profile: null,
      },
      steps: [
        {
          id: 'old-step',
          type: 'open',
          label: 'Old step',
          target: null,
          input: { url: 'http://localhost:3000/' },
          timeoutMs: 30000,
          enabled: true,
        },
      ],
      createdAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-10T00:00:00.000Z',
    };
    const newSteps = [
      {
        id: 'new-step',
        type: 'fill',
        label: 'Fill Flow name',
        target: {
          descriptor: 'Customer portal login',
          locator: { kind: 'label', value: 'Flow name' },
        },
        input: { value: 'FilledNow' },
        timeoutMs: 30000,
        enabled: true,
      },
    ];

    const runtime = {
      getSession: vi.fn().mockReturnValue({ flowId: 'flow-1' }),
      stopRecording: vi.fn().mockResolvedValue({
        recordingId: 'recording-1',
        steps: newSteps,
      }),
    };
    const store = {
      getFlow: vi.fn().mockReturnValue(savedFlow),
      saveFlow: vi.fn(),
    };

    const response = await buildRecordingStopResponse({
      runtime: runtime as any,
      store: store as any,
      sessionId: 'session-1',
      now: () => '2026-04-10T01:23:45.000Z',
    });

    expect(response.statusCode).toBe(200);
    expect(runtime.stopRecording).toHaveBeenCalledWith('session-1');
    expect(store.saveFlow).toHaveBeenCalledWith({
      ...savedFlow,
      steps: newSteps,
      updatedAt: '2026-04-10T01:23:45.000Z',
    });
    expect(response.payload).toMatchObject({
      recordingId: 'recording-1',
      steps: newSteps,
      flow: {
        id: 'flow-1',
        steps: newSteps,
      },
    });
  });

  it('returns stop payload without persistence when no flow is bound to the session', async () => {
    const runtime = {
      getSession: vi.fn().mockReturnValue({ flowId: null }),
      stopRecording: vi.fn().mockResolvedValue({
        recordingId: 'recording-1',
        steps: [],
      }),
    };
    const store = {
      getFlow: vi.fn(),
      saveFlow: vi.fn(),
    };

    const response = await buildRecordingStopResponse({
      runtime: runtime as any,
      store: store as any,
      sessionId: 'session-1',
      now: () => '2026-04-10T01:23:45.000Z',
    });

    expect(response).toEqual({
      statusCode: 200,
      payload: {
        recordingId: 'recording-1',
        steps: [],
      },
    });
    expect(store.getFlow).not.toHaveBeenCalled();
    expect(store.saveFlow).not.toHaveBeenCalled();
  });
});
