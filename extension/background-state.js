export function createEmptySession() {
  return {
    sessionId: null,
    conversationId: null,
    taskId: null,
    tabId: null,
    origin: null,
    status: 'idle',
    lastError: null,
    permission: 'unknown',
    stepLabel: '',
  };
}

export function getOrigin(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/.test(url.protocol)) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function hostPatternForOrigin(origin) {
  if (!origin) return null;
  return `${origin}/*`;
}

export function reduceSession(session, patch) {
  return {
    ...session,
    ...patch,
  };
}

export function shouldRequestPermission(session, nextOrigin) {
  return Boolean(nextOrigin) && (session.origin !== nextOrigin || session.permission !== 'granted');
}
