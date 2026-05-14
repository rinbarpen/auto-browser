import React, { useEffect, useState, useReducer, useCallback } from 'react';
import { render, Box, Text, useInput } from 'ink';
import type { TokenUsage } from './llm-router.js';

interface TuiConfig {
  taskId: string;
  goal: string;
  baseUrl: string;
}

interface IterationEntry {
  iteration: number;
  action?: { action: string; label: string; ref?: string; url?: string; textPreview?: string };
  url?: string;
  title?: string;
  rawCompletion?: string;
  error?: string;
  tokenUsage?: TokenUsage;
}

interface TuiState {
  task: {
    id: string;
    goal: string;
    status: string;
    planDraft?: { summary: string; steps: Array<{ id: string; title: string; intent: string }> };
    currentStepIndex: number | null;
    resultSummary: string | null;
  };
  iterations: IterationEntry[];
  totalTokens: { prompt: number; completion: number };
  connected: boolean;
  reconnecting: boolean;
  error: string | null;
  startTime: number;
}

type TuiAction =
  | { type: 'event'; event: { type: string; data: Record<string, unknown>; summary?: { action: string; label: string; ref?: string; url?: string; textPreview?: string } } }
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'reconnecting' }
  | { type: 'error'; message: string };

function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'connected':
      return { ...state, connected: true, reconnecting: false, error: null };
    case 'disconnected':
      return { ...state, connected: false };
    case 'reconnecting':
      return { ...state, reconnecting: true };
    case 'error':
      return { ...state, error: action.message };
    case 'event': {
      const event = action.event;
      const summary = event.summary;
      switch (event.type) {
        case 'task.drafted':
        case 'task.ready':
          return {
            ...state,
            task: {
              ...state.task,
              status: event.type === 'task.drafted' ? 'draft' : 'ready',
            },
          };
        case 'task.running':
          return { ...state, task: { ...state.task, status: 'running', currentStepIndex: 0 } };
        case 'task.execution.iteration.started': {
          const iter = event.data.iteration as number;
          const entry: IterationEntry = { iteration: iter, url: event.data.url as string, title: event.data.title as string };
          return { ...state, iterations: [...state.iterations, entry] };
        }
        case 'task.execution.llm.completion': {
          const llmIter = event.data.iteration as number;
          const content = (event.data.content as string) ?? '';
          const usage = event.data.usage as TokenUsage | undefined;
          const updated = state.iterations.map((e) =>
            e.iteration === llmIter ? { ...e, rawCompletion: content, tokenUsage: usage } : e
          );
          const promptAdd = usage?.promptTokens ?? 0;
          const completionAdd = usage?.completionTokens ?? 0;
          return {
            ...state,
            iterations: updated,
            totalTokens: {
              prompt: state.totalTokens.prompt + promptAdd,
              completion: state.totalTokens.completion + completionAdd,
            },
          };
        }
        case 'task.execution.iteration.completed': {
          const doneIter = event.data.iteration as number;
          const doneAction = summary || { action: event.data.action as string, label: (event.data.label as string) ?? '' };
          const doneUrl = event.data.url as string;
          const doneTitle = event.data.title as string;
          const doneEntries = state.iterations.map((e) =>
            e.iteration === doneIter ? { ...e, action: doneAction, url: e.url ?? doneUrl, title: e.title ?? doneTitle } : e
          );
          return { ...state, iterations: doneEntries };
        }
        case 'task.completed':
          return {
            ...state,
            task: {
              ...state.task,
              status: 'completed',
              resultSummary: (event.data.resultSummary as string) ?? null,
            },
          };
        case 'task.failed':
          return {
            ...state,
            task: {
              ...state.task,
              status: 'failed',
              resultSummary: (event.data.message as string) ?? 'Task failed',
            },
          };
        case 'task.handoff':
          return {
            ...state,
            task: {
              ...state.task,
              status: 'handoff',
              resultSummary: (event.data.reason as string) ?? 'Task handed off',
            },
          };
        case 'task.cancelled':
          return { ...state, task: { ...state.task, status: 'cancelled' } };
        default:
          return state;
      }
    }
    default:
      return state;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'running': return 'yellow';
    case 'completed': return 'green';
    case 'failed': return 'red';
    case 'handoff': return 'magenta';
    case 'cancelled': return 'gray';
    default: return 'white';
  }
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function trimCompletion(raw: string, maxLen: number): string {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    delete obj.label;
    const compact = JSON.stringify(obj);
    return compact.length <= maxLen ? compact : compact.slice(0, maxLen - 3) + '...';
  } catch {
    return raw.length <= maxLen ? raw : raw.slice(0, maxLen - 3) + '...';
  }
}

const STEP_MARKERS: Record<string, string> = {
  completed: '✓',
  current: '▶',
  pending: '○',
};

function Header({ state, elapsed }: { state: TuiState; elapsed: number }) {
  const { task, connected, reconnecting } = state;
  const goalPreview = truncate(task.goal, 56);
  const connIndicator = reconnecting ? '(Reconnecting...)' : connected ? '' : '(Disconnected)';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box gap={1}>
          <Text bold>Task</Text>
          <Text color="cyan">{task.id}</Text>
        </Box>
        <Box gap={1}>
          <Text backgroundColor={statusColor(task.status)} bold color="black">
            {' '}{task.status.toUpperCase()}{' '}
          </Text>
          <Text dimColor>Elapsed: {formatElapsed(elapsed)}</Text>
          {connIndicator ? <Text color="yellow">{connIndicator}</Text> : null}
        </Box>
      </Box>
      <Box>
        <Text dimColor>Goal: </Text>
        <Text>{goalPreview}</Text>
      </Box>
    </Box>
  );
}

function PlanSteps({ state }: { state: TuiState }) {
  const { task } = state;
  if (!task.planDraft?.steps?.length) return null;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text bold underline>Plan Steps:</Text>
      {task.planDraft.steps.map((step, i) => {
        const stepStatus =
          task.status === 'completed' ? 'completed'
          : i < (task.currentStepIndex ?? 0) ? 'completed'
          : i === (task.currentStepIndex ?? 0) && task.status === 'running' ? 'current'
          : 'pending';
        const marker = STEP_MARKERS[stepStatus] ?? '○';
        const color = stepStatus === 'completed' ? 'green' : stepStatus === 'current' ? 'yellow' : 'gray';
        return (
          <Box key={step.id} gap={1}>
            <Text color={color}>{marker}</Text>
            <Text color={color} dimColor={stepStatus === 'completed'}>{truncate(step.title, 58)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function StatusBar({ state }: { state: TuiState }) {
  const lastIter = state.iterations[state.iterations.length - 1];
  if (!lastIter) return null;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1} borderStyle="single" borderColor="gray">
      <Box gap={2}>
        <Box gap={1}>
          <Text dimColor>Iteration:</Text>
          <Text color="yellow">{lastIter.iteration + 1}/{20}</Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>URL:</Text>
          <Text color="cyan">{truncate(lastIter.url ?? '', 42)}</Text>
        </Box>
      </Box>
      <Box>
        <Text dimColor>Title: </Text>
        <Text>{truncate(lastIter.title ?? '', 52)}</Text>
      </Box>
    </Box>
  );
}

function ActionHistory({ state }: { state: TuiState }) {
  const entries = state.iterations.filter((e) => e.action).slice(-8);
  if (entries.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text bold underline>Actions:</Text>
      <Box flexDirection="row" gap={1} marginTop={0}>
        <Box width={4}><Text dimColor>{'#'.padEnd(4)}</Text></Box>
        <Box width={14}><Text dimColor>{'Action'.padEnd(14)}</Text></Box>
        <Text dimColor>Details</Text>
      </Box>
      {entries.map((e) => {
        const isCurrent = e.iteration === state.iterations[state.iterations.length - 1]?.iteration;
        const rowColor = e.error ? 'red' : isCurrent ? 'yellow' : 'white';
        const details = e.action?.url ?? e.action?.ref ?? e.action?.textPreview ?? e.error ?? '';
        return (
          <Box key={e.iteration} flexDirection="row" gap={1}>
            <Box width={4}><Text color={rowColor}>{String(e.iteration + 1).padEnd(4)}</Text></Box>
            <Box width={14}><Text color={rowColor}>{truncate(e.action?.label ?? e.action?.action ?? '?', 14).padEnd(14)}</Text></Box>
            <Text color={rowColor} dimColor={!e.error}>{isCurrent ? '▶ ' : '  '}{truncate(details, 48)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function LlmDetails({ state }: { state: TuiState }) {
  const lastWithCompletion = [...state.iterations].reverse().find((e) => e.rawCompletion);
  if (!lastWithCompletion?.rawCompletion) return null;

  const trimmed = trimCompletion(lastWithCompletion.rawCompletion, 72);
  const tokens = lastWithCompletion.tokenUsage;
  const totalT = state.totalTokens;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1} borderStyle="single" borderColor="gray">
      <Box>
        <Text dimColor>LLM Completion (iter {lastWithCompletion.iteration + 1}):</Text>
      </Box>
      <Box>
        <Text color="cyan">{trimmed}</Text>
      </Box>
      <Box gap={2}>
        <Text dimColor>Tokens:</Text>
        <Text>P:{tokens ? tokens.promptTokens.toLocaleString() : '-'}</Text>
        <Text>C:{tokens ? tokens.completionTokens.toLocaleString() : '-'}</Text>
        <Text>T:{tokens ? tokens.totalTokens.toLocaleString() : '-'}</Text>
        <Text color="gray"> | </Text>
        <Text dimColor>Session:</Text>
        <Text>P:{totalT.prompt.toLocaleString()}</Text>
        <Text>C:{totalT.completion.toLocaleString()}</Text>
      </Box>
    </Box>
  );
}

function Footer() {
  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1} marginTop={1}>
      <Box gap={2}>
        <Text backgroundColor="gray" color="black"> q </Text>
        <Text dimColor>Quit</Text>
      </Box>
      <Box gap={2}>
        <Text backgroundColor="gray" color="black"> r </Text>
        <Text dimColor>Re-run</Text>
      </Box>
      <Box gap={2}>
        <Text backgroundColor="gray" color="black"> c </Text>
        <Text dimColor>Cancel</Text>
      </Box>
    </Box>
  );
}

function ResultBanner({ state }: { state: TuiState }) {
  const { task } = state;
  if (!task.resultSummary && task.status !== 'completed' && task.status !== 'failed' && task.status !== 'handoff') {
    return null;
  }

  const color = task.status === 'completed' ? 'green' : task.status === 'failed' ? 'red' : 'magenta';
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1} borderStyle="round" borderColor={color}>
      <Box gap={1}>
        <Text bold color={color}>
          {task.status === 'completed' ? 'COMPLETED' : task.status === 'failed' ? 'FAILED' : 'HANDOFF'}
        </Text>
      </Box>
      {task.resultSummary ? (
        <Box>
          <Text>{truncate(task.resultSummary, 64)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

interface AppOptions {
  taskId: string;
  goal: string;
  baseUrl: string;
  onCancel: () => Promise<void>;
  onRerun: () => Promise<string | null>;
  onQuit: () => void;
}

function App({ taskId, goal, baseUrl, onCancel, onRerun, onQuit }: AppOptions) {
  const [state, dispatch] = useReducer(tuiReducer, {
    task: {
      id: taskId,
      goal,
      status: 'draft',
      currentStepIndex: null,
      resultSummary: null,
    },
    iterations: [],
    totalTokens: { prompt: 0, completion: 0 },
    connected: false,
    reconnecting: false,
    error: null,
    startTime: Date.now(),
  });

  const [elapsed, setElapsed] = useState(0);
  const [terminalState, setTerminalState] = useState(false);

  const isTerminal = useCallback((status: string) => {
    return status === 'completed' || status === 'failed' || status === 'handoff' || status === 'cancelled';
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Date.now() - state.startTime);
    }, 100);
    return () => clearInterval(interval);
  }, [state.startTime]);

  useEffect(() => {
    if (isTerminal(state.task.status)) {
      setTerminalState(true);
    }
  }, [state.task.status, isTerminal]);

  useEffect(() => {
    let retries = 0;
    let aborted = false;

    async function connect() {
      while (!aborted && retries < 3) {
        try {
          const response = await fetch(`${baseUrl}/events`);
          if (!response.ok || !response.body) {
            throw new Error(`SSE connection failed: ${response.status}`);
          }

          dispatch({ type: 'connected' });
          retries = 0;

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (!aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop() ?? '';
            for (const part of parts) {
              const dataLine = part.split('\n').find((line) => line.startsWith('data: '));
              if (!dataLine) continue;
              try {
                const event = JSON.parse(dataLine.slice(6)) as {
                  type: string;
                  data: Record<string, unknown>;
                  summary?: { action: string; label: string; ref?: string; url?: string; textPreview?: string };
                };
                dispatch({ type: 'event', event });
              } catch { /* skip malformed events */ }
            }
          }

          if (!aborted) {
            dispatch({ type: 'disconnected' });
          }
          break;
        } catch {
          if (!aborted) {
            retries += 1;
            if (retries < 3) {
              dispatch({ type: 'reconnecting' });
              await new Promise((r) => setTimeout(r, 2000));
            } else {
              dispatch({ type: 'error', message: 'Failed to connect to control service after 3 attempts' });
            }
          }
        }
      }
    }

    void connect();
    return () => { aborted = true; };
  }, [baseUrl]);

  useInput(async (input, key) => {
    if (input === 'q') {
      onQuit();
      return;
    }
    if (input === 'c') {
      await onCancel();
      return;
    }
    if (input === 'r') {
      const newTaskId = await onRerun();
      if (newTaskId) {
        // Re-initialize state for the new task
        // We do this by unmounting/remounting via the exit promise
        onQuit();
      }
    }
    if (key.escape) {
      onQuit();
    }
  });

  return (
    <Box flexDirection="column" padding={0}>
      <Header state={state} elapsed={elapsed} />
      <PlanSteps state={state} />
      <StatusBar state={state} />
      <ActionHistory state={state} />
      <LlmDetails state={state} />
      <ResultBanner state={state} />
      <Footer />
      {state.error ? (
        <Box>
          <Text color="red">{state.error}</Text>
        </Box>
      ) : null}
      {terminalState ? (
        <Box marginTop={1}>
          <Text dimColor>Task finished. Press </Text>
          <Text bold>q</Text>
          <Text dimColor> to quit, </Text>
          <Text bold>r</Text>
          <Text dimColor> to re-run.</Text>
        </Box>
      ) : null}
    </Box>
  );
}

interface TuiHandle {
  waitUntilExit(): Promise<void>;
}

export function startTui(config: TuiConfig & {
  onCancel: () => Promise<void>;
  onRerun: () => Promise<string | null>;
}): TuiHandle {
  const { taskId, goal, baseUrl, onCancel, onRerun } = config;
  let resolveExit: () => void;

  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const { waitUntilExit } = render(
    <App
      taskId={taskId}
      goal={goal}
      baseUrl={baseUrl}
      onCancel={onCancel}
      onRerun={async () => {
        const result = await onRerun();
        return result;
      }}
      onQuit={() => resolveExit()}
    />,
    { exitOnCtrlC: true }
  );

  return {
    waitUntilExit: async () => {
      await exitPromise;
      waitUntilExit();
    },
  };
}
