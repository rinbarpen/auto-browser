const OVERLAY_ID = 'auto-browser-extension-overlay';
const HIGHLIGHT_ATTR = 'data-auto-browser-ref';

let overlayRoot = null;
let refMap = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case 'observe_page':
      return observePage();
    case 'viewport_size':
      return { width: window.innerWidth, height: window.innerHeight };
    case 'run_action':
      return { outcome: await runAction(message.action) };
    case 'show_visual':
      showStatus(message.visual);
      return {};
    case 'clear_visual':
      clearOverlay();
      return {};
    default:
      throw new Error(`Unsupported content-script message: ${String(message?.type)}`);
  }
}

function observePage() {
  ensureOverlay();
  refMap = collectRefs();
  return {
    observation: {
      url: location.href,
      title: document.title,
      visibleText: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000),
      refs: Array.from(refMap.values()).map((entry) => entry.descriptor),
      canvasRects: collectCanvasRects(),
    },
  };
}

async function runAction(action) {
  ensureOverlay();
  const label = buildActionLabel(action);

  if (action.action === 'navigate') {
    showStatus({ label });
    location.href = action.url;
    return { status: 'navigating', label };
  }

  if (action.action === 'scroll') {
    showStatus({ label });
    window.scrollBy({ top: (action.direction === 'down' ? 1 : -1) * (action.amount ?? 600), behavior: 'smooth' });
    await wait(250);
    return { status: 'success', label };
  }

  if (action.action === 'wait_for') {
    showStatus({ label });
    if (action.text) {
      await waitForText(action.text, action.ms ?? 5000);
    } else {
      await wait(action.ms ?? 1000);
    }
    return { status: 'success', label };
  }

  if (action.action === 'press_key') {
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    showStatus({ label });
    dispatchKeyboard(target, action.key);
    await wait(120);
    return { status: 'success', label };
  }

  if (action.action === 'finish' || action.action === 'handoff') {
    showStatus({ label, message: action.message || action.reason || '' });
    return { status: action.action === 'finish' ? 'success' : 'blocked', label };
  }

  if (action.action === 'click_point') {
    showStatus({ label });
    await clickPoint(action.x, action.y);
    pulse({ x: action.x + window.scrollX, y: action.y + window.scrollY, width: 1, height: 1 });
    return { status: 'success', label };
  }

  const target = getLiveRef(action.ref);
  if (!target) {
    throw new Error(`Target ref not found: ${action.ref}`);
  }

  await animatePointer(target.descriptor, label);
  if (action.action === 'click_ref') {
    target.element.click();
    pulse(target.descriptor.rect);
    return { status: 'success', label };
  }

  if (action.action === 'fill_ref') {
    const input = target.element;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input.isContentEditable)) {
      throw new Error(`Ref ${action.ref} is not fillable`);
    }
    focusElement(input);
    setElementValue(input, action.text);
    showStatus({ label, message: action.textPreview || sanitizeTextPreview(action.text) });
    return { status: 'success', label, textPreview: action.textPreview || sanitizeTextPreview(action.text) };
  }

  throw new Error(`Unsupported action: ${action.action}`);
}

function collectCanvasRects() {
  return Array.from(document.querySelectorAll('canvas'))
    .map((canvas) => {
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const rect = canvas.getBoundingClientRect();
      const style = window.getComputedStyle(canvas);
      const visible =
        rect.width >= 4 &&
        rect.height >= 4 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.left < window.innerWidth &&
        rect.top < window.innerHeight &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        style.pointerEvents !== 'none';
      if (!visible) return null;
      return {
        x: Math.max(0, rect.left),
        y: Math.max(0, rect.top),
        width: Math.min(rect.width, window.innerWidth - Math.max(0, rect.left)),
        height: Math.min(rect.height, window.innerHeight - Math.max(0, rect.top)),
      };
    })
    .filter(Boolean);
}

async function clickPoint(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
    throw new Error(`Invalid click_point coordinates: ${x}, ${y}`);
  }
  const target = document.elementFromPoint(x, y);
  if (!(target instanceof Element)) {
    throw new Error(`No element at click_point coordinates: ${x}, ${y}`);
  }
  const options = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
  };
  target.dispatchEvent(new PointerEvent('pointerdown', { ...options, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  target.dispatchEvent(new MouseEvent('mousedown', options));
  target.dispatchEvent(new PointerEvent('pointerup', { ...options, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  target.dispatchEvent(new MouseEvent('mouseup', { ...options, buttons: 0 }));
  target.dispatchEvent(new MouseEvent('click', { ...options, buttons: 0 }));
  await wait(120);
}

function collectRefs() {
  const refs = new Map();
  const candidates = document.querySelectorAll(
    'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"]'
  );
  let index = 1;
  for (const element of candidates) {
    if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    const ref = `@e${index}`;
    index += 1;
    const descriptor = createRefDescriptor(ref, element, rect);
    element.setAttribute(HIGHLIGHT_ATTR, ref);
    refs.set(ref, { element, descriptor });
  }
  return refs;
}

function getLiveRef(ref) {
  const existing = refMap.get(ref);
  if (!existing) return null;
  const element = document.querySelector(`[${HIGHLIGHT_ATTR}="${ref}"]`);
  if (!(element instanceof HTMLElement)) return null;
  const rect = element.getBoundingClientRect();
  const descriptor = createRefDescriptor(ref, element, rect);
  return { element, descriptor };
}

function isVisible(element) {
  const style = window.getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
}

function ensureOverlay() {
  if (overlayRoot?.isConnected) return overlayRoot;
  const host = document.createElement('div');
  host.id = OVERLAY_ID;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font-family: ui-sans-serif, system-ui, sans-serif; }
      .cursor { position: absolute; width: 18px; height: 18px; border-radius: 50% 50% 50% 0; transform: translate(-3px,-3px) rotate(-45deg); background: #111827; box-shadow: 0 0 0 2px rgba(255,255,255,0.9); transition: transform 180ms ease, left 180ms ease, top 180ms ease; }
      .highlight { position: absolute; border: 2px solid #f97316; background: rgba(249,115,22,0.12); border-radius: 12px; transition: all 180ms ease; }
      .status { position: fixed; left: 16px; bottom: 16px; max-width: min(420px, calc(100vw - 32px)); padding: 10px 14px; border-radius: 14px; color: white; background: rgba(17,24,39,0.88); backdrop-filter: blur(10px); }
      .status strong { display: block; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: #fdba74; margin-bottom: 4px; }
      .status span { display: block; font-size: 13px; line-height: 1.4; }
      .pulse { position: absolute; border-radius: 999px; border: 2px solid rgba(249,115,22,0.8); animation: pulse 420ms ease-out forwards; }
      @keyframes pulse { from { transform: scale(0.4); opacity: 1; } to { transform: scale(1.8); opacity: 0; } }
    </style>
    <div class="layer">
      <div class="cursor"></div>
      <div class="highlight"></div>
      <div class="status"><strong>Auto Browser</strong><span>Ready</span></div>
    </div>`;
  overlayRoot = {
    host,
    shadow,
    cursor: shadow.querySelector('.cursor'),
    highlight: shadow.querySelector('.highlight'),
    status: shadow.querySelector('.status span'),
    layer: shadow.querySelector('.layer'),
  };
  return overlayRoot;
}

function clearOverlay() {
  overlayRoot?.host.remove();
  overlayRoot = null;
}

function showStatus(visual) {
  const overlay = ensureOverlay();
  overlay.status.textContent = [visual?.label, visual?.message].filter(Boolean).join(' • ') || 'Working';
}

async function animatePointer(descriptor, label) {
  const overlay = ensureOverlay();
  const point = {
    x: descriptor.rect.x + descriptor.rect.width / 2 - window.scrollX,
    y: descriptor.rect.y + descriptor.rect.height / 2 - window.scrollY,
  };
  overlay.cursor.style.left = `${point.x}px`;
  overlay.cursor.style.top = `${point.y}px`;
  overlay.highlight.style.left = `${descriptor.rect.x - window.scrollX}px`;
  overlay.highlight.style.top = `${descriptor.rect.y - window.scrollY}px`;
  overlay.highlight.style.width = `${descriptor.rect.width}px`;
  overlay.highlight.style.height = `${descriptor.rect.height}px`;
  showStatus({ label });
  window.scrollTo({
    top: Math.max(0, descriptor.rect.y - window.innerHeight / 2 + descriptor.rect.height / 2),
    behavior: 'smooth',
  });
  await wait(280);
}

function pulse(rect) {
  const overlay = ensureOverlay();
  const node = document.createElement('div');
  node.className = 'pulse';
  const size = Math.max(rect.width, rect.height, 24);
  node.style.left = `${rect.x - window.scrollX + rect.width / 2 - size / 2}px`;
  node.style.top = `${rect.y - window.scrollY + rect.height / 2 - size / 2}px`;
  node.style.width = `${size}px`;
  node.style.height = `${size}px`;
  overlay.layer.appendChild(node);
  setTimeout(() => node.remove(), 450);
}

function focusElement(element) {
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  element.focus();
}

function setElementValue(element, value) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (element.isContentEditable) {
    element.textContent = value;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
  }
}

function dispatchKeyboard(target, key) {
  const options = { key, bubbles: true };
  target.dispatchEvent(new KeyboardEvent('keydown', options));
  target.dispatchEvent(new KeyboardEvent('keyup', options));
}

async function waitForText(text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((document.body?.innerText || '').includes(text)) {
      return;
    }
    await wait(120);
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeTextPreview(text, maxLength = 24) {
  const normalized = String(text ?? '').trim();
  if (!normalized) return '';
  if (normalized.length <= 2) return '*'.repeat(normalized.length);
  return `${normalized.slice(0, 2)}${'*'.repeat(Math.min(maxLength, Math.max(3, normalized.length - 3)))}`;
}

function buildActionLabel(action) {
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

function createRefDescriptor(ref, element, rect) {
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
