import { describe, expect, it } from 'vitest';
import { deriveStepsFromRawEvents } from '../src/workbench/derive-steps';
import type { RawRecordedEvent } from '../src/workbench/types';

describe('deriveStepsFromRawEvents', () => {
  it('prepends an open step and collapses click plus typing into a single fill step', () => {
    const events: RawRecordedEvent[] = [
      {
        id: 'evt-1',
        sessionId: 'session-1',
        recordingId: 'recording-1',
        type: 'click',
        timestamp: 1,
        pageUrl: 'https://example.com/login',
        target: {
          locator: { kind: 'label', value: 'Email' },
          descriptor: 'Email input',
        },
      },
      {
        id: 'evt-2',
        sessionId: 'session-1',
        recordingId: 'recording-1',
        type: 'input',
        timestamp: 2,
        pageUrl: 'https://example.com/login',
        target: {
          locator: { kind: 'label', value: 'Email' },
          descriptor: 'Email input',
        },
        value: 'person@example.com',
      },
    ];

    const steps = deriveStepsFromRawEvents(events);

    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      type: 'open',
      input: { url: 'https://example.com/login' },
    });
    expect(steps[1]).toMatchObject({
      type: 'fill',
      target: {
        locator: { kind: 'label', value: 'Email' },
      },
      input: { value: 'person@example.com' },
    });
  });

  it('keeps a navigation, a click, and a wait as distinct steps', () => {
    const events: RawRecordedEvent[] = [
      {
        id: 'evt-nav',
        sessionId: 'session-1',
        recordingId: 'recording-1',
        type: 'navigate',
        timestamp: 1,
        pageUrl: 'https://example.com/dashboard',
        value: 'https://example.com/dashboard',
      },
      {
        id: 'evt-click',
        sessionId: 'session-1',
        recordingId: 'recording-1',
        type: 'click',
        timestamp: 2,
        pageUrl: 'https://example.com/dashboard',
        target: {
          locator: { kind: 'role', value: 'button', name: 'Create report' },
          descriptor: 'Create report button',
        },
      },
      {
        id: 'evt-wait',
        sessionId: 'session-1',
        recordingId: 'recording-1',
        type: 'wait_for',
        timestamp: 3,
        pageUrl: 'https://example.com/dashboard',
        value: 'Report ready',
      },
    ];

    const steps = deriveStepsFromRawEvents(events);

    expect(steps.map((step) => step.type)).toEqual(['open', 'click', 'wait']);
    expect(steps[2]).toMatchObject({
      input: {
        text: 'Report ready',
      },
    });
  });
});
