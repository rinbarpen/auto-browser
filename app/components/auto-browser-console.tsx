'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BrowserInstanceRecord,
  PublicLlmSettingsRecord,
} from '../src/workbench/types';

// --- Types matching control-service TaskEvent ---
type TaskStatus = 'idle' | 'draft' | 'ready' | 'running' | 'handoff' | 'completed' | 'failed' | 'cancelled';

interface PlanStep {
  id: string;
  title: string;
  intent: string;
}

interface PlanDraft {
  summary: string;
  steps: PlanStep[];
}

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface IterationEntry {
  iteration: number;
  url: string;
  title: string;
  actionLabel?: string;
  actionDetails?: string;
  rawCompletion?: string;
  tokenUsage?: TokenUsage;
  error?: string;
}

interface TaskEvent {
  id: string;
  taskId: string;
  type: string;
  createdAt: string;
  summary?: { label?: string; url?: string; title?: string; error?: string };
  data: Record<string, unknown>;
}

interface CredentialSite {
  username: string;
  hasPassword: boolean;
}

// --- Props ---
interface AutoBrowserConsoleProps {
  instances: BrowserInstanceRecord[];
  instancePreviewUrl: string | null;
}

const CONTROL_SERVICE_URL = 'http://127.0.0.1:4317';

// --- Helper: format token usage ---
function formatTokens(usage?: TokenUsage): string {
  if (!usage) return '';
  return `P:${usage.promptTokens} C:${usage.completionTokens} T:${usage.totalTokens}`;
}

// --- Helper: get action label from event ---
function getActionLabel(summary?: { label?: string }): string | undefined {
  return summary?.label;
}

// --- Helper: get error from event ---
function getActionError(summary?: { error?: string }): string | undefined {
  return summary?.error;
}

export function AutoBrowserConsole({ instances, instancePreviewUrl }: AutoBrowserConsoleProps) {
  // --- State ---
  const [status, setStatus] = useState<TaskStatus>('idle');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [planDraft, setPlanDraft] = useState<PlanDraft | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState<number | null>(null);
  const [iterations, setIterations] = useState<IterationEntry[]>([]);
  const [resultSummary, setResultSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [handoffSource, setHandoffSource] = useState<string | null>(null);
  const [sessionTokens, setSessionTokens] = useState<TokenUsage>({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  const [connected, setConnected] = useState(false);
  const [selectedInstanceId, setSelectedInstanceId] = useState('');
  const [savedCredentials, setSavedCredentials] = useState<Record<string, CredentialSite>>({});
  const [showCredentialPrompt, setShowCredentialPrompt] = useState(false);
  const [credentialSite, setCredentialSite] = useState('');
  const [credentialUsername, setCredentialUsername] = useState('');
  const [credentialPassword, setCredentialPassword] = useState('');
  const [aborted, setAborted] = useState(false);

  const sseAbortRef = useRef<AbortController | null>(null);
  const activeTaskIdRef = useRef<string | null>(null);

  // --- Load saved credentials on mount ---
  useEffect(() => {
    fetch('/api/auto-browser/credentials')
      .then((r) => r.json())
      .then((data) => setSavedCredentials(data.sites ?? {}))
      .catch(() => {});
  }, []);

  // --- SSE connection ---
  const connectSSE = useCallback(() => {
    if (sseAbortRef.current) {
      sseAbortRef.current.abort();
    }
    const abortController = new AbortController();
    sseAbortRef.current = abortController;
    let retries = 0;

    const connect = async () => {
      try {
        const response = await fetch(`${CONTROL_SERVICE_URL}/api/events`, {
          signal: abortController.signal,
        });
        if (!response.ok || !response.body) return;

        setConnected(true);
        retries = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';

          for (const part of parts) {
            const dataLine = part.trim().match(/^data: (.+)$/m);
            if (!dataLine) continue;
            try {
              const event = JSON.parse(dataLine[1]) as TaskEvent;
              handleSSEEvent(event);
            } catch {
              // skip invalid JSON
            }
          }
        }
      } catch {
        // connection closed
      } finally {
        setConnected(false);
        if (!abortController.signal.aborted && retries < 3) {
          retries++;
          setTimeout(connect, 2000);
        }
      }
    };

    connect();

    return () => {
      abortController.abort();
    };
  }, []);

  // --- SSE event handler ---
  function handleSSEEvent(event: TaskEvent) {
    const isActive = event.taskId === activeTaskIdRef.current;
    if (!isActive) return;

    switch (event.type) {
      case 'task.drafted': {
        const draft = event.data.planDraft as PlanDraft | undefined;
        if (draft) {
          setPlanDraft(draft);
          setStatus('draft');
        }
        break;
      }
      case 'task.ready':
        setStatus('ready');
        break;
      case 'task.running':
        setStatus('running');
        setCurrentStepIndex(0);
        break;
      case 'task.execution.iteration.started': {
        const iterData = event.data as { iteration?: number; url?: string; title?: string };
        setIterations((prev) => [
          ...prev,
          {
            iteration: iterData.iteration ?? prev.length,
            url: iterData.url ?? '',
            title: iterData.title ?? '',
          },
        ]);
        if (event.summary?.label) {
          const summary = event.summary;
          setIterations((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last) last.actionLabel = summary.label;
            return updated;
          });
        }
        break;
      }
      case 'task.execution.llm.completion': {
        const llmData = event.data as { content?: string; usage?: TokenUsage };
        setIterations((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last) {
            if (llmData.content) last.rawCompletion = llmData.content;
            if (llmData.usage) last.tokenUsage = llmData.usage;
          }
          return updated;
        });
        if (llmData.usage) {
          setSessionTokens((prev) => ({
            promptTokens: prev.promptTokens + (llmData.usage?.promptTokens ?? 0),
            completionTokens: prev.completionTokens + (llmData.usage?.completionTokens ?? 0),
            totalTokens: prev.totalTokens + (llmData.usage?.totalTokens ?? 0),
          }));
        }
        break;
      }
      case 'task.execution.iteration.completed': {
        setIterations((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && event.summary) {
            last.actionLabel = getActionLabel(event.summary);
            last.actionDetails = event.summary.url ?? event.summary.title;
            last.error = getActionError(event.summary);
          }
          return updated;
        });
        break;
      }
      case 'task.completed': {
        setStatus('completed');
        if (event.data?.resultSummary) {
          setResultSummary(String(event.data.resultSummary));
        }
        break;
      }
      case 'task.failed': {
        setStatus('failed');
        const msg = event.data?.message ?? event.data?.error ?? 'Task failed';
        setError(String(msg));
        break;
      }
      case 'task.handoff': {
        setStatus('handoff');
        setHandoffSource(event.data?.source ? String(event.data.source) : 'System');
        break;
      }
      case 'task.cancelled':
        setStatus('cancelled');
        break;
    }
  }

  // --- Start SSE on mount ---
  useEffect(() => {
    const cleanup = connectSSE();
    setAborted(false);
    return () => {
      cleanup?.();
      setAborted(true);
    };
  }, [connectSSE]);

  // --- Set aborted when task starts ---
  useEffect(() => {
    if (status === 'running') {
      setAborted(false);
    }
  }, [status]);

  // --- Actions ---
  async function ensureConversation(): Promise<string> {
    if (conversationId) return conversationId;
    const response = await fetch(`${CONTROL_SERVICE_URL}/api/conversations`, {
      method: 'POST',
    });
    const data = await response.json();
    const id = data.id ?? data.conversation?.id;
    setConversationId(id);
    return id;
  }

  async function startTask() {
    if (!goal.trim()) return;

    setError(null);
    setResultSummary(null);
    setPlanDraft(null);
    setIterations([]);
    setHandoffSource(null);
    setSessionTokens({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    setCurrentStepIndex(null);
    setStatus('idle');

    try {
      const convId = await ensureConversation();

      // Submit goal
      const msgBody: Record<string, unknown> = {
        goal: goal.trim(),
        source: 'service',
        browserConfig: {
          launchMode: 'headed',
          cdpUrl: '',
        },
      };
      const msgRes = await fetch(
        `${CONTROL_SERVICE_URL}/api/conversations/${convId}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(msgBody),
        }
      );
      const msgData = await msgRes.json();
      const newTaskId = msgData.id ?? msgData.task?.id;
      if (!newTaskId) {
        setError('Failed to create task');
        return;
      }

      setTaskId(newTaskId);
      activeTaskIdRef.current = newTaskId;

      // Run the task
      const runRes = await fetch(
        `${CONTROL_SERVICE_URL}/api/tasks/${newTaskId}/run`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'service' }),
        }
      );
      if (!runRes.ok) {
        const errData = await runRes.json().catch(() => ({}));
        setError(String(errData.error ?? 'Failed to run task'));
        return;
      }

      setStatus('draft');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function cancelTask() {
    if (!taskId) return;
    try {
      await fetch(`${CONTROL_SERVICE_URL}/api/tasks/${taskId}/cancel`, {
        method: 'POST',
      });
    } catch {
      // ignore
    }
  }

  async function handoffTask() {
    if (!taskId) return;
    try {
      await fetch(`${CONTROL_SERVICE_URL}/api/tasks/${taskId}/handoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'user_request' }),
      });
      setHandoffSource('User requested takeover');
    } catch {
      // ignore
    }
  }

  async function resumeTask() {
    if (!taskId) return;
    setHandoffSource(null);
    try {
      await fetch(`${CONTROL_SERVICE_URL}/api/tasks/${taskId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    } catch {
      // ignore
    }
  }

  async function saveCredential() {
    if (!credentialSite || !credentialUsername) return;
    try {
      await fetch('/api/auto-browser/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site: credentialSite,
          username: credentialUsername,
          password: credentialPassword,
        }),
      });
      setSavedCredentials((prev) => ({
        ...prev,
        [credentialSite]: { username: credentialUsername, hasPassword: Boolean(credentialPassword) },
      }));
    } catch {
      // ignore
    }
    setShowCredentialPrompt(false);
  }

  async function deleteCredential(site: string) {
    try {
      await fetch(`/api/auto-browser/credentials/${encodeURIComponent(site)}`, {
        method: 'DELETE',
      });
      setSavedCredentials((prev) => {
        const next = { ...prev };
        delete next[site];
        return next;
      });
    } catch {
      // ignore
    }
  }

  // --- Derived state ---
  const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  const isRunning = status === 'running' || status === 'draft' || status === 'ready';
  const previewUrl = instancePreviewUrl;
  const runningInstance = instances.find((i) => i.id === selectedInstanceId);

  return (
    <div className="auto-browser-console">
      <style>{`
        .auto-browser-console { display: flex; flex-direction: column; height: 100%; gap: 12px; font-size: 14px; }
        .auto-browser-console .goal-form { display: flex; gap: 8px; }
        .auto-browser-console .goal-form textarea { flex: 1; min-height: 48px; resize: vertical; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-family: inherit; font-size: 13px; }
        .auto-browser-console .controls { display: flex; gap: 8px; align-items: center; }
        .auto-browser-console .controls button { padding: 6px 16px; border: 1px solid #888; border-radius: 4px; cursor: pointer; font-size: 13px; background: #fff; }
        .auto-browser-console .controls button:disabled { opacity: 0.5; cursor: default; }
        .auto-browser-console .controls button.primary { background: #0066cc; color: #fff; border-color: #0066cc; }
        .auto-browser-console .controls button.danger { background: #cc0000; color: #fff; border-color: #cc0000; }
        .auto-browser-console .status-badge { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 12px; font-weight: 600; }
        .auto-browser-console .status-badge.idle { background: #eee; color: #666; }
        .auto-browser-console .status-badge.running { background: #0066cc; color: #fff; }
        .auto-browser-console .status-badge.handoff { background: #cc6600; color: #fff; }
        .auto-browser-console .status-badge.completed { background: #009933; color: #fff; }
        .auto-browser-console .status-badge.failed,
        .auto-browser-console .status-badge.cancelled { background: #cc0000; color: #fff; }
        .auto-browser-console .preview-area { flex: 1; min-height: 300px; border: 1px solid #ddd; border-radius: 4px; overflow: hidden; position: relative; background: #f5f5f5; display: flex; align-items: center; justify-content: center; }
        .auto-browser-console .preview-area img { max-width: 100%; max-height: 100%; object-fit: contain; }
        .auto-browser-console .handoff-banner { background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; padding: 12px; }
        .auto-browser-console .result-banner { background: #d4edda; border: 1px solid #28a745; border-radius: 4px; padding: 12px; }
        .auto-browser-console .error-banner { background: #f8d7da; border: 1px solid #dc3545; border-radius: 4px; padding: 12px; }
        .auto-browser-console .plan-steps { display: flex; flex-direction: column; gap: 4px; }
        .auto-browser-console .plan-step { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 3px; font-size: 13px; }
        .auto-browser-console .plan-step.active { background: #e8f0fe; }
        .auto-browser-console .plan-step.done { opacity: 0.7; }
        .auto-browser-console .iterations-table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .auto-browser-console .iterations-table th,
        .auto-browser-console .iterations-table td { padding: 4px 8px; border: 1px solid #ddd; text-align: left; }
        .auto-browser-console .iterations-table th { background: #f5f5f5; font-weight: 600; }
        .auto-browser-console .llm-completion { background: #fafafa; border: 1px solid #eee; border-radius: 4px; padding: 8px; font-family: monospace; font-size: 11px; white-space: pre-wrap; max-height: 150px; overflow-y: auto; }
        .auto-browser-console .tokens { font-size: 11px; color: #666; }
        .auto-browser-console .credential-section { border: 1px solid #ddd; border-radius: 4px; padding: 8px; }
        .auto-browser-console .credential-item { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; font-size: 13px; }
        .auto-browser-console .credential-prompt-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
        .auto-browser-console .credential-prompt-modal { background: #fff; border-radius: 8px; padding: 24px; min-width: 360px; box-shadow: 0 4px 24px rgba(0,0,0,0.2); }
        .auto-browser-console .credential-prompt-modal input { width: 100%; margin: 4px 0 12px; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; }
        .auto-browser-console .credential-prompt-modal .actions { display: flex; gap: 8px; justify-content: flex-end; }
        .auto-browser-console .instance-select { padding: 6px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; }
      `}</style>

      {/* Goal Input + Controls */}
      <div className="goal-form">
        <textarea
          placeholder="Enter a browser task goal (e.g., 'Go to example.com and tell me the page title')"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          disabled={isRunning}
        />
        <button className="primary" onClick={startTask} disabled={isRunning || !goal.trim()}>
          Start
        </button>
      </div>

      {/* Instance selector */}
      <div className="controls">
        <span>Browser:</span>
        <select
          className="instance-select"
          value={selectedInstanceId}
          onChange={(e) => setSelectedInstanceId(e.target.value)}
        >
          <option value="">-- Auto-create --</option>
          {instances.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} ({i.status})
            </option>
          ))}
        </select>
      </div>

      {/* Control bar */}
      <div className="controls">
        <span className={`status-badge ${status}`}>
          {status === 'idle' ? 'Idle' : status === 'draft' ? 'Draft' : status === 'ready' ? 'Ready' : status === 'running' ? 'Running' : status === 'handoff' ? 'Handoff' : status === 'completed' ? 'Done' : status === 'failed' ? 'Failed' : status === 'cancelled' ? 'Cancelled' : status}
        </span>
        {isRunning && !aborted ? (
          <>
            <button className="danger" onClick={cancelTask}>Cancel</button>
            <button onClick={handoffTask}>Take Over</button>
          </>
        ) : null}
        {status === 'handoff' ? (
          <button className="primary" onClick={resumeTask}>Resume</button>
        ) : null}
        {isTerminal ? (
          <button onClick={() => { setStatus('idle'); setTaskId(null); setPlanDraft(null); setIterations([]); setResultSummary(null); setError(null); setHandoffSource(null); activeTaskIdRef.current = null; }}>
            Clear
          </button>
        ) : null}
        <span className="tokens">{formatTokens(sessionTokens)}</span>
        <span className="tokens">{connected ? 'Connected' : 'Disconnected'}</span>
      </div>

      {/* Plan draft & execution */}
      {planDraft ? (
        <div>
          <strong>Plan:</strong> {planDraft.summary}
          <div className="plan-steps">
            {planDraft.steps.map((step, i) => {
              const isActive = currentStepIndex === i;
              const isDone = (currentStepIndex ?? -1) > i;
              return (
                <div key={step.id} className={`plan-step ${isActive ? 'active' : ''} ${isDone ? 'done' : ''}`}>
                  <span>{isDone ? '✓' : isActive ? '▶' : '○'}</span>
                  <span>{step.title}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Handoff banner */}
      {status === 'handoff' && handoffSource ? (
        <div className="handoff-banner">
          <strong>Handed off:</strong> {handoffSource}
          <p style={{ margin: '4px 0 0', fontSize: '13px' }}>
            The browser is now in manual mode. You can interact with it directly.
            Click <strong>Resume</strong> to continue LLM-driven execution.
          </p>
        </div>
      ) : null}

      {/* Result / Error banner */}
      {status === 'completed' && resultSummary ? (
        <div className="result-banner">{resultSummary}</div>
      ) : null}
      {error ? <div className="error-banner">{error}</div> : null}

      {/* Iteration table */}
      {iterations.length > 0 ? (
        <div>
          <strong>Actions ({iterations.length})</strong>
          <table className="iterations-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Action</th>
                <th>URL / Details</th>
                <th>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {iterations.slice(-10).map((iter, i) => (
                <tr key={i}>
                  <td>{iter.iteration}</td>
                  <td>{iter.actionLabel ?? '-'}</td>
                  <td style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {iter.error ? <span style={{ color: '#cc0000' }}>{iter.error}</span> : iter.actionDetails ?? iter.url ?? ''}
                  </td>
                  <td>{iter.tokenUsage ? formatTokens(iter.tokenUsage) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* LLM completion */}
      {iterations.length > 0 && iterations[iterations.length - 1]?.rawCompletion ? (
        <div>
          <strong>Last LLM output:</strong>
          <div className="llm-completion">
            {(() => {
              const last = iterations[iterations.length - 1];
              if (!last?.rawCompletion) return '';
              try {
                const parsed = JSON.parse(last.rawCompletion);
                return JSON.stringify(parsed, null, 2);
              } catch {
                return last.rawCompletion;
              }
            })()}
          </div>
        </div>
      ) : null}

      {/* Browser Preview — using LivePreview from flow-workbench */}
      <div className="preview-area">
        {previewUrl ? (
          <LivePreview wsUrl={previewUrl} />
        ) : (
          <span style={{ color: '#999' }}>No browser preview (select or start an instance)</span>
        )}
      </div>

      {/* Saved Credentials */}
      {Object.keys(savedCredentials).length > 0 ? (
        <div className="credential-section">
          <strong>Saved Credentials</strong>
          {Object.entries(savedCredentials).map(([site, data]) => (
            <div key={site} className="credential-item">
              <span>
                <strong>{site}</strong> — {data.username}
                {data.hasPassword ? ' (password saved)' : ''}
              </span>
              <button
                className="danger"
                style={{ padding: '2px 8px', fontSize: '12px' }}
                onClick={() => deleteCredential(site)}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {/* Credential save prompt */}
      {showCredentialPrompt ? (
        <div className="credential-prompt-overlay" onClick={() => setShowCredentialPrompt(false)}>
          <div className="credential-prompt-modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 12px' }}>Save credentials for {credentialSite}?</h3>
            <label>Username / Email</label>
            <input value={credentialUsername} onChange={(e) => setCredentialUsername(e.target.value)} />
            <label>Password</label>
            <input type="password" value={credentialPassword} onChange={(e) => setCredentialPassword(e.target.value)} />
            <div className="actions">
              <button onClick={() => setShowCredentialPrompt(false)}>Skip</button>
              <button className="primary" onClick={saveCredential}>Save</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Re-export LivePreview (used above from flow-workbench)
import { LivePreview } from './flow-workbench';
