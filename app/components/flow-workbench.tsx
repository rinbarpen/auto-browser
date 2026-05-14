'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { applyOpenSessionFailure, applyOpenSessionSuccess } from './flow-workbench-state';
import type {
  BrowserInstanceRecord,
  CookieJarRecord,
  FlowDefinition,
  FlowRunStepRecord,
  RunEventRecord,
} from '../src/workbench/types';

export function FlowWorkbench({ flowId }: { flowId: string }) {
  const [flow, setFlow] = useState<FlowDefinition | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runSteps, setRunSteps] = useState<FlowRunStepRecord[]>([]);
  const [runEvents, setRunEvents] = useState<RunEventRecord[]>([]);
  const [instances, setInstances] = useState<BrowserInstanceRecord[]>([]);
  const [cookieJars, setCookieJars] = useState<Array<CookieJarRecord & { cookieCount: number }>>([]);
  const [selectedInstanceId, setSelectedInstanceId] = useState('');
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState('Loading flow');

  useEffect(() => {
    void loadFlow();
    void loadTargets();
  }, [flowId]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/runs/${runId}`, { cache: 'no-store' });
      if (!response.ok || cancelled) return;
      const payload = (await response.json()) as {
        run: { status: string };
        steps: FlowRunStepRecord[];
        events: RunEventRecord[];
      };
      if (cancelled) return;
      setRunSteps(payload.steps);
      setRunEvents(payload.events);
      setStatusText(`Run ${payload.run.status}`);
      if (payload.run.status !== 'running' && payload.run.status !== 'queued') {
        clearInterval(timer);
      }
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runId]);

  async function loadFlow() {
    const response = await fetch(`/api/flows/${flowId}`, { cache: 'no-store' });
    if (!response.ok) {
      setStatusText('Flow not found');
      return;
    }
    const payload = (await response.json()) as { flow: FlowDefinition };
    setFlow(payload.flow);
    setStatusText('Idle');
  }

  async function loadTargets() {
    const [instancesResponse, jarsResponse] = await Promise.all([
      fetch('/api/instances', { cache: 'no-store' }),
      fetch('/api/cookie-jars', { cache: 'no-store' }),
    ]);
    setInstances(((await instancesResponse.json()) as { instances: BrowserInstanceRecord[] }).instances);
    setCookieJars(((await jarsResponse.json()) as { jars: Array<CookieJarRecord & { cookieCount: number }> }).jars);
  }

  const wsUrl = useMemo(() => {
    if (!sessionId || typeof window === 'undefined') return null;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${protocol}://${window.location.host}/ws/sessions/${sessionId}/preview`;
  }, [sessionId]);

  async function saveFlow(nextFlow: FlowDefinition) {
    if (!flow) return;
    const response = await fetch(`/api/flows/${flow.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nextFlow),
    });
    const payload = (await response.json()) as { flow: FlowDefinition };
    setFlow(payload.flow);
    setStatusText('Flow saved');
  }

  async function openSession() {
    if (!flow) return;
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flowId: flow.id }),
    });
    const payload = (await response.json()) as { error?: string; sessionId?: string };
    if (!response.ok || !payload.sessionId) {
      const nextState = applyOpenSessionFailure(payload.error ?? 'Unable to open preview session');
      setSessionId(nextState.sessionId);
      setSessionError(nextState.sessionError);
      setStatusText(nextState.statusText);
      return;
    }

    const nextState = applyOpenSessionSuccess(payload.sessionId);
    setSessionId(nextState.sessionId);
    setSessionError(nextState.sessionError);
    setStatusText(nextState.statusText);
  }

  async function startRecording() {
    if (!sessionId) return;
    const response = await fetch(`/api/sessions/${sessionId}/recording/start`, { method: 'POST' });
    const payload = (await response.json()) as { recordingId: string };
    setRecordingId(payload.recordingId);
    setStatusText('Recording user actions');
  }

  async function stopRecording() {
    if (!sessionId || !flow) return;
    const response = await fetch(`/api/sessions/${sessionId}/recording/stop`, { method: 'POST' });
    const payload = (await response.json()) as {
      recordingId: string;
      steps: FlowDefinition['steps'];
      flow?: FlowDefinition;
    };
    setRecordingId(null);
    if (payload.flow) {
      setFlow(payload.flow);
      setStatusText(`Captured ${payload.steps.length} steps`);
      return;
    }
    const nextFlow: FlowDefinition = {
      ...flow,
      steps: payload.steps.length > 0 ? payload.steps : flow.steps,
    };
    await saveFlow(nextFlow);
    setStatusText(`Captured ${payload.steps.length} steps`);
  }

  async function executeFlow() {
    if (!flow) return;
    const response = await fetch(`/api/flows/${flow.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: selectedInstanceId || null }),
    });
    const payload = (await response.json()) as { runId: string };
    setRunId(payload.runId);
    setStatusText('Executing flow');
  }

  function updateStep(stepId: string, updater: (step: FlowDefinition['steps'][number]) => FlowDefinition['steps'][number]) {
    setFlow((current) =>
      current
        ? {
            ...current,
            steps: current.steps.map((step) => (step.id === stepId ? updater(step) : step)),
          }
        : current
    );
  }

  function addWaitStep() {
    setFlow((current) =>
      current
        ? {
            ...current,
            steps: [
              ...current.steps,
              {
                id: crypto.randomUUID(),
                type: 'wait',
                label: 'Wait for text',
                enabled: true,
                timeoutMs: 10000,
                target: null,
                input: { text: 'Done' },
              },
            ],
          }
        : current
    );
  }

  if (!flow) {
    return (
      <main className="workbench-shell">
        <section className="panel">
          <div className="panel-head">
            <h2>Flow unavailable</h2>
            <p>{statusText}</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="workbench-shell">
      <header className="workbench-header">
        <div>
          <p className="eyebrow">Flow workbench</p>
          <h1>{flow.name}</h1>
          <p className="lede">{flow.startUrl}</p>
        </div>
        <div className="action-row">
          <button onClick={() => void saveFlow({ ...flow })}>Save flow</button>
          <a className="button-link" href={`/api/scripts/${flow.id}/export/skill`}>
            Export Skill
          </a>
          <button onClick={() => void openSession()}>{sessionId ? 'Refresh preview' : 'Open preview'}</button>
          <button disabled={!sessionId || !!recordingId} onClick={() => void startRecording()}>
            Start recording
          </button>
          <button disabled={!sessionId || !recordingId} onClick={() => void stopRecording()}>
            Stop recording
          </button>
          <button onClick={() => void executeFlow()}>Run flow</button>
        </div>
      </header>

      <div className="workbench-grid">
        <section className="panel steps-panel">
          <div className="panel-head">
            <h2>Structured steps</h2>
            <button className="ghost-button" onClick={addWaitStep}>
              Add wait
            </button>
          </div>
          <div className="target-controls">
            <label>
              Run target
              <select value={selectedInstanceId} onChange={(event) => setSelectedInstanceId(event.target.value)}>
                <option value="">Temporary browser</option>
                {instances.map((instance) => (
                  <option key={instance.id} value={instance.id}>
                    {instance.name} ({instance.status})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Cookie jar
              <select
                value={flow.sessionConfig.cookieJarId ?? ''}
                onChange={(event) =>
                  setFlow((current) =>
                    current
                      ? {
                          ...current,
                          sessionConfig: {
                            ...current.sessionConfig,
                            cookieJarId: event.target.value || null,
                          },
                        }
                      : current
                  )
                }
              >
                <option value="">No cookie jar</option>
                {cookieJars.map((jar) => (
                  <option key={jar.id} value={jar.id}>
                    {jar.name} ({jar.cookieCount})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="steps-list">
            {flow.steps.map((step, index) => (
              <article className="step-card" key={step.id}>
                <div className="step-card-head">
                  <span className="step-index">{index + 1}</span>
                  <input
                    value={step.label}
                    onChange={(event) => updateStep(step.id, (current) => ({ ...current, label: event.target.value }))}
                  />
                </div>
                <div className="step-meta">
                  <label>
                    Type
                    <select
                      value={step.type}
                      onChange={(event) => updateStep(step.id, (current) => ({ ...current, type: event.target.value as typeof current.type }))}
                    >
                      {['open', 'click', 'fill', 'press', 'wait', 'select', 'check', 'uncheck', 'assertText', 'assertVisible'].map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Timeout
                    <input
                      type="number"
                      value={step.timeoutMs}
                      onChange={(event) =>
                        updateStep(step.id, (current) => ({ ...current, timeoutMs: Number(event.target.value) }))
                      }
                    />
                  </label>
                </div>
                <label>
                  Locator
                  <input
                    value={step.target?.locator.value ?? ''}
                    placeholder="Locator value"
                    onChange={(event) =>
                      updateStep(step.id, (current) => ({
                        ...current,
                        target: current.target
                          ? { ...current.target, locator: { ...current.target.locator, value: event.target.value } }
                          : {
                              locator: { kind: 'css', value: event.target.value },
                              descriptor: event.target.value,
                            },
                      }))
                    }
                  />
                </label>
                <label>
                  Input value
                  <input
                    value={String(step.input.value ?? step.input.url ?? step.input.text ?? step.input.key ?? '')}
                    onChange={(event) =>
                      updateStep(step.id, (current) => ({
                        ...current,
                        input:
                          current.type === 'open'
                            ? { url: event.target.value }
                            : current.type === 'press'
                              ? { key: event.target.value }
                              : current.type === 'wait' || current.type === 'assertText'
                                ? { text: event.target.value }
                                : { value: event.target.value },
                      }))
                    }
                  />
                </label>
                <label className="toggle-row">
                  <input
                    checked={step.enabled}
                    type="checkbox"
                    onChange={(event) => updateStep(step.id, (current) => ({ ...current, enabled: event.target.checked }))}
                  />
                  Enabled
                </label>
              </article>
            ))}
          </div>
        </section>

        <section className="panel preview-panel">
          <div className="panel-head">
            <div>
              <h2>Live browser</h2>
              <p>{statusText}</p>
              {sessionError ? <p role="alert">{sessionError}</p> : null}
            </div>
            <div className="status-pills">
              <span className={sessionId ? 'pill active' : 'pill'}>{sessionId ? 'Session live' : 'No session'}</span>
              <span className={recordingId ? 'pill recording' : 'pill'}>{recordingId ? 'Recording' : 'Standby'}</span>
            </div>
          </div>
          <LivePreview wsUrl={wsUrl} />
        </section>

        <section className="panel timeline-panel">
          <div className="panel-head">
            <h2>Execution timeline</h2>
            <p>{runId ? `Run ${runId}` : 'No run started yet'}</p>
          </div>
          <div className="timeline-list">
            {runSteps.length === 0 ? (
              <div className="empty-timeline">
                <p>Run the flow to populate step timings, screenshots, and errors.</p>
              </div>
            ) : (
              runSteps.map((step) => (
                <article className={`timeline-card ${step.status}`} key={step.stepId}>
                  <div className="timeline-card-head">
                    <strong>{step.stepId}</strong>
                    <span>{step.status}</span>
                  </div>
                  <p>{step.message}</p>
                  <p>{step.pageUrl}</p>
                  <p>{step.durationMs ? `${step.durationMs} ms` : 'Running…'}</p>
                  {step.errorDetail ? <pre>{step.errorDetail}</pre> : null}
                </article>
              ))
            )}
          </div>
          {runEvents.length > 0 ? (
            <div className="event-strip">
              {runEvents.slice(-8).map((event) => (
                <div className="event-chip" key={event.id}>
                  <strong>{event.type}</strong>
                  <span>{new Date(event.createdAt).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

export function LivePreview({ wsUrl }: { wsUrl: string | null }) {
  const [frame, setFrame] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ deviceWidth: number; deviceHeight: number } | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!wsUrl) return;
    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;
    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as
        | { type: 'frame'; data: string; metadata: { deviceWidth: number; deviceHeight: number } }
        | { type: 'status' };
      if (payload.type === 'frame') {
        setFrame(`data:image/jpeg;base64,${payload.data}`);
        setMeta(payload.metadata);
      }
    };
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [wsUrl]);

  function send(message: Record<string, unknown>) {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(message));
    }
  }

  function projectPointer(event: React.MouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const width = meta?.deviceWidth ?? bounds.width;
    const height = meta?.deviceHeight ?? bounds.height;
    return {
      x: Math.round(((event.clientX - bounds.left) / bounds.width) * width),
      y: Math.round(((event.clientY - bounds.top) / bounds.height) * height),
    };
  }

  return (
    <div
      className="live-preview"
      ref={containerRef}
      onClick={() => containerRef.current?.focus()}
      onMouseDown={(event) => {
        const point = projectPointer(event);
        send({ type: 'input_mouse', eventType: 'mousePressed', button: 'left', clickCount: 1, ...point });
      }}
      onMouseUp={(event) => {
        const point = projectPointer(event);
        send({ type: 'input_mouse', eventType: 'mouseReleased', button: 'left', clickCount: 1, ...point });
      }}
      onMouseMove={(event) => {
        const point = projectPointer(event);
        send({ type: 'input_mouse', eventType: 'mouseMoved', ...point });
      }}
      onWheel={(event) => {
        const point = projectPointer(event);
        send({ type: 'input_mouse', eventType: 'mouseWheel', deltaX: event.deltaX, deltaY: event.deltaY, ...point });
      }}
      onKeyDown={(event) => {
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          send({ type: 'input_keyboard', eventType: 'char', text: event.key });
        } else {
          send({ type: 'input_keyboard', eventType: 'keyDown', key: event.key, code: event.code });
          send({ type: 'input_keyboard', eventType: 'keyUp', key: event.key, code: event.code });
        }
      }}
      role="application"
      tabIndex={0}
    >
      {frame ? <img alt="Live browser stream" src={frame} /> : <p>Open a preview session to stream the browser here.</p>}
    </div>
  );
}
