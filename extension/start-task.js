export function resolveAutomationTabUrl(rawUrl) {
  if (!rawUrl) {
    return 'about:blank';
  }

  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/.test(url.protocol)) {
      return 'about:blank';
    }
    return url.toString();
  } catch {
    return 'about:blank';
  }
}
