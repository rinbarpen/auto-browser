export type PreviewSessionState = {
  sessionError: string | null;
  sessionId: string | null;
  statusText: string;
};

export function applyOpenSessionSuccess(sessionId: string): PreviewSessionState {
  return {
    sessionError: null,
    sessionId,
    statusText: 'Preview session ready',
  };
}

export function applyOpenSessionFailure(sessionError: string): PreviewSessionState {
  return {
    sessionError,
    sessionId: null,
    statusText: 'Preview unavailable',
  };
}
