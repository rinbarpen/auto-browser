export function sanitizeTextPreview(text, maxLength = 24) {
  const normalized = String(text ?? '').trim();
  if (!normalized) return '';
  if (normalized.length <= 2) return '*'.repeat(normalized.length);
  return `${normalized.slice(0, 2)}${'*'.repeat(Math.min(maxLength, Math.max(3, normalized.length - 3)))}`;
}

export function buildActionLabel(action) {
  switch (action?.action) {
    case 'navigate':
      return action.label || `Navigate to ${action.url}`;
    case 'click_ref':
      return action.label || `Click ${action.ref}`;
    case 'click_point':
      return action.label || `Click (${Math.round(action.x)}, ${Math.round(action.y)})`;
    case 'fill_ref':
      return action.label || `Fill ${action.ref}`;
    case 'press_key':
      return action.label || `Press ${action.key}`;
    case 'scroll':
      return action.label || `Scroll ${action.direction}`;
    case 'wait_for':
      return action.label || (action.text ? `Wait for ${action.text}` : `Wait ${action.ms ?? 1000}ms`);
    case 'finish':
      return action.label || 'Finish task';
    case 'handoff':
      return action.label || 'Request handoff';
    default:
      return 'Run action';
  }
}

export function summarizeObservation(observation) {
  const refCount = Array.isArray(observation?.refs) ? observation.refs.length : 0;
  const canvasCount = Array.isArray(observation?.canvasRects) ? observation.canvasRects.length : 0;
  const visual = observation?.visual ? ' • visual' : '';
  return `${observation?.title || 'Untitled'} • ${refCount} refs • ${canvasCount} canvas${visual} • ${observation?.url || ''}`.trim();
}

export function createRefDescriptor(ref, element, rect) {
  return {
    ref,
    role: element.getAttribute('role') || inferRole(element),
    name: accessibleName(element),
    text: visibleText(element),
    rect: {
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
    },
  };
}

function inferRole(element) {
  const tag = element.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'input' || tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  return tag;
}

function accessibleName(element) {
  return (
    element.getAttribute('aria-label') ||
    element.getAttribute('title') ||
    element.getAttribute('placeholder') ||
    visibleText(element)
  );
}

function visibleText(element) {
  return (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}
