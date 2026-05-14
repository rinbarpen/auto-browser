import type { RecordingDebugSnapshot } from './types';

export async function buildSessionDebugResponse(options: {
  isDev: boolean;
  runtime: {
    getSession(sessionId: string): unknown;
    getRecordingDebugSnapshot(sessionId: string): Promise<RecordingDebugSnapshot>;
  };
  sessionId: string;
}): Promise<{
  statusCode: number;
  payload: RecordingDebugSnapshot | { error: string };
}> {
  if (!options.isDev) {
    return {
      statusCode: 404,
      payload: { error: 'Not found' },
    };
  }

  if (!options.runtime.getSession(options.sessionId)) {
    return {
      statusCode: 404,
      payload: { error: 'Session not found' },
    };
  }

  return {
    statusCode: 200,
    payload: await options.runtime.getRecordingDebugSnapshot(options.sessionId),
  };
}
