import type { FlowDefinition } from './types';

export async function buildRecordingStopResponse(options: {
  runtime: {
    getSession(sessionId: string): { flowId: string | null } | null;
    stopRecording(sessionId: string): Promise<{
      recordingId: string;
      steps: FlowDefinition['steps'];
    }>;
  };
  store: {
    getFlow(id: string): FlowDefinition | null;
    saveFlow(flow: FlowDefinition): void;
  };
  sessionId: string;
  now?: () => string;
}): Promise<{
  statusCode: number;
  payload:
    | {
        recordingId: string;
        steps: FlowDefinition['steps'];
        flow?: FlowDefinition;
      }
    | { error: string };
}> {
  const result = await options.runtime.stopRecording(options.sessionId);
  const session = options.runtime.getSession(options.sessionId);
  const flowId = session?.flowId ?? null;
  if (!flowId) {
    return {
      statusCode: 200,
      payload: result,
    };
  }

  const currentFlow = options.store.getFlow(flowId);
  if (!currentFlow) {
    return {
      statusCode: 200,
      payload: result,
    };
  }

  const persistedFlow: FlowDefinition = {
    ...currentFlow,
    steps: result.steps.length > 0 ? result.steps : currentFlow.steps,
    updatedAt: (options.now ?? (() => new Date().toISOString()))(),
  };
  options.store.saveFlow(persistedFlow);

  return {
    statusCode: 200,
    payload: {
      ...result,
      flow: persistedFlow,
    },
  };
}
