import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkbenchRuntime } from '../src/workbench/runtime';
import type { RawRecordedEvent, StepTarget, WorkbenchStore } from '../src/workbench/types';

function createStoreStub(): WorkbenchStore {
  return {
    saveFlow() {},
    listFlows() {
      return [];
    },
    getFlow() {
      return null;
    },
    createRun() {},
    updateRun() {},
    upsertRunStep() {},
    appendRunEvent() {},
    getRunWithDetails() {
      return null;
    },
    listBrowserInstances() {
      return [];
    },
    getBrowserInstance() {
      return null;
    },
    saveBrowserInstance() {},
    updateBrowserInstance() {},
    deleteBrowserInstance() {},
    listCookieJars() {
      return [];
    },
    getCookieJar() {
      return null;
    },
    saveCookieJar() {},
    replaceCookies() {},
    deleteCookieJar() { return true; },
    listLlmSettings() {
      return [];
    },
    getLlmSettings() {
      return null;
    },
    upsertLlmSettings() {},
    listLlmProviderPresets() {
      return [];
    },
    createLlmProviderPreset() {
      throw new Error('not implemented');
    },
    updateLlmProviderPreset() {
      return null;
    },
    deleteLlmProviderPreset() {
      return false;
    },
    listLlmPresets() {
      return { presets: [], activePresetId: null };
    },
    createLlmPreset() {
      throw new Error('not implemented');
    },
    updateLlmPreset() {
      return null;
    },
    activateLlmPreset() {
      return null;
    },
    deleteLlmPreset() {
      return false;
    },
  };
}

describe('WorkbenchRuntime recording stop', () => {
  it('flushes pending typed input before deriving steps', async () => {
    const runtime = new WorkbenchRuntime(createStoreStub(), path.join(os.tmpdir(), 'workbench-runtime-tests'));
    const target: StepTarget = {
      locator: { kind: 'label', value: 'Flow name' },
      descriptor: 'Flow name',
    };

    const pendingTimer = setTimeout(() => {}, 10_000);
    const session = {
      id: 'session-1',
      browser: {},
      sockets: new Set(),
      sessionName: 'session-1',
      recording: {
        id: 'recording-1',
        events: [] as RawRecordedEvent[],
        pendingInputTimer: pendingTimer,
        pendingInputTarget: target,
      },
      isStreaming: false,
    };

    (runtime as any).sessions.set(session.id, session);
    (runtime as any).captureActiveInput = async (state: typeof session) => {
      (state.recording as any).pendingInputTimer = undefined;
      state.recording.events.push({
        id: 'raw-input',
        sessionId: state.id,
        recordingId: state.recording.id,
        type: 'input',
        timestamp: Date.now(),
        pageUrl: 'http://localhost:3000/',
        target,
        value: 'Smoke',
      });
    };

    const result = await runtime.stopRecording(session.id);

    expect(result.steps.some((step) => step.type === 'fill' && step.input.value === 'Smoke')).toBe(true);
    expect(session.recording).toBeNull();
    expect(clearTimeout(pendingTimer)).toBeUndefined();
  });

  it('exposes recording debug snapshot with raw events and active input details', async () => {
    const runtime = new WorkbenchRuntime(createStoreStub(), path.join(os.tmpdir(), 'workbench-runtime-tests'));
    const target: StepTarget = {
      locator: { kind: 'label', value: 'Flow name' },
      descriptor: 'Customer portal login',
    };

    const session = {
      id: 'session-debug',
      browser: {
        getPage() {
          return {
            url() {
              return 'http://localhost:3000/';
            },
            evaluate() {
              return Promise.resolve({
                target,
                value: 'FilledNow',
              });
            },
          };
        },
      },
      sockets: new Set(),
      sessionName: 'session-debug',
      recording: {
        id: 'recording-debug',
        events: [
          {
            id: 'raw-click',
            sessionId: 'session-debug',
            recordingId: 'recording-debug',
            type: 'click',
            timestamp: 1,
            pageUrl: 'http://localhost:3000/',
            target,
          },
        ] as RawRecordedEvent[],
        pendingInputTimer: undefined,
        pendingInputTarget: target,
        lastInputCaptureAt: 123,
        lastInputCaptureError: null,
        lastCapturedInputValue: 'FilledNow',
      },
      isStreaming: true,
    };

    (runtime as any).sessions.set(session.id, session);

    const snapshot = await runtime.getRecordingDebugSnapshot(session.id);

    expect(snapshot).toMatchObject({
      sessionId: 'session-debug',
      pageUrl: 'http://localhost:3000/',
      recording: {
        id: 'recording-debug',
        pendingInputTarget: target,
        hasPendingInputTimer: false,
        lastInputCaptureAt: 123,
        lastInputCaptureError: null,
        lastCapturedInputValue: 'FilledNow',
      },
      activeInput: {
        target,
        value: 'FilledNow',
      },
    });
    expect(snapshot.recording?.events).toHaveLength(1);
    expect(snapshot.recording?.events[0]?.type).toBe('click');
  });

  it('tracks capture errors in the recording debug snapshot', async () => {
    const runtime = new WorkbenchRuntime(createStoreStub(), path.join(os.tmpdir(), 'workbench-runtime-tests'));
    const target: StepTarget = {
      locator: { kind: 'label', value: 'Flow name' },
      descriptor: 'Customer portal login',
    };

    const session = {
      id: 'session-capture-error',
      browser: {
        getPage() {
          return {
            url() {
              return 'http://localhost:3000/';
            },
            evaluate() {
              return Promise.reject(new Error('debug evaluate failed'));
            },
          };
        },
      },
      sockets: new Set(),
      sessionName: 'session-capture-error',
      recording: {
        id: 'recording-capture-error',
        events: [] as RawRecordedEvent[],
        pendingInputTimer: undefined,
        pendingInputTarget: target,
      },
      isStreaming: true,
    };

    (runtime as any).sessions.set(session.id, session);

    await (runtime as any).captureActiveInput(session);
    const snapshot = await runtime.getRecordingDebugSnapshot(session.id);

    expect(snapshot.recording).toMatchObject({
      lastInputCaptureError: 'debug evaluate failed',
      lastCapturedInputValue: null,
    });
  });

  it('schedules input capture for char events even if keyboard injection fails', async () => {
    const runtime = new WorkbenchRuntime(createStoreStub(), path.join(os.tmpdir(), 'workbench-runtime-tests'));
    const target: StepTarget = {
      locator: { kind: 'label', value: 'Flow name' },
      descriptor: 'Customer portal login',
    };

    const session = {
      id: 'session-char-failure',
      browser: {
        injectKeyboardEvent() {
          return Promise.reject(new Error('keyboard inject failed'));
        },
        getPage() {
          return {
            url() {
              return 'http://localhost:3000/';
            },
            evaluate() {
              return Promise.resolve({
                target,
                value: 'FilledAfterFailure',
              });
            },
          };
        },
      },
      sockets: new Set(),
      sessionName: 'session-char-failure',
      recording: {
        id: 'recording-char-failure',
        events: [] as RawRecordedEvent[],
        pendingInputTimer: undefined,
        pendingInputTarget: target,
      },
      isStreaming: true,
    };

    (runtime as any).sessions.set(session.id, session);

    await (runtime as any)
      .handlePreviewMessage(
        session.id,
        JSON.stringify({ type: 'input_keyboard', eventType: 'char', text: 'A', key: 'A' })
      )
      .catch(() => {});

    await new Promise((resolve) => setTimeout(resolve, 350));
    const snapshot = await runtime.getRecordingDebugSnapshot(session.id);

    expect(snapshot.recording).toMatchObject({
      lastCapturedInputValue: 'FilledAfterFailure',
      lastInputCaptureError: null,
    });
    expect(snapshot.recording?.events.some((event) => event.type === 'input')).toBe(true);
  });

  it('keeps pending input capture when typing immediately after clicking the same field', async () => {
    const runtime = new WorkbenchRuntime(createStoreStub(), path.join(os.tmpdir(), 'workbench-runtime-tests'));
    const target: StepTarget = {
      locator: { kind: 'label', value: 'Flow name' },
      descriptor: 'Customer portal login',
    };

    let evaluateCount = 0;
    const session = {
      id: 'session-click-then-type',
      browser: {
        injectMouseEvent() {
          return Promise.resolve();
        },
        injectKeyboardEvent() {
          return Promise.resolve();
        },
        getPage() {
          return {
            url() {
              return 'http://localhost:3000/';
            },
            evaluate() {
              evaluateCount += 1;
              if (evaluateCount === 1) {
                return new Promise((resolve) => {
                  setTimeout(() => resolve(target), 100);
                });
              }
              return Promise.resolve({
                target,
                value: 'FilledRace',
              });
            },
          };
        },
      },
      sockets: new Set(),
      sessionName: 'session-click-then-type',
      recording: {
        id: 'recording-click-then-type',
        events: [] as RawRecordedEvent[],
        pendingInputTimer: undefined,
        pendingInputTarget: null,
      },
      isStreaming: true,
    };

    (runtime as any).sessions.set(session.id, session);

    const clickPromise = (runtime as any).handlePreviewMessage(
      session.id,
      JSON.stringify({
        type: 'input_mouse',
        eventType: 'mouseReleased',
        x: 1131,
        y: 181,
        button: 'left',
        clickCount: 1,
      })
    );

    await (runtime as any).handlePreviewMessage(
      session.id,
      JSON.stringify({ type: 'input_keyboard', eventType: 'char', text: 'A', key: 'A' })
    );

    await clickPromise;
    await new Promise((resolve) => setTimeout(resolve, 350));
    const snapshot = await runtime.getRecordingDebugSnapshot(session.id);

    expect(snapshot.recording?.events.some((event) => event.type === 'input' && event.value === 'FilledRace')).toBe(true);
  });
});
