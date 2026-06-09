import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('extension sidepanel layout', () => {
  it('uses a clean app shell with header, main, and composer', () => {
    const html = readFileSync(resolve(root, 'extension/sidepanel.html'), 'utf8');

    expect(html).toContain('class="app"');
    expect(html).toContain('class="header"');
    expect(html).toContain('class="main"');
    expect(html).toContain('class="composer"');
    expect(html).toContain('id="goalInput"');
    expect(html).toContain('id="sendButton"');
    expect(html).toContain('id="configToggle"');
    expect(html).toContain('id="configPanel"');
    expect(html).toContain('id="historyPanel"');
    expect(html).toContain('id="overlayBackdrop"');
    expect(html).toContain('id="errorBanner"');
  });

  it('places the conversations toggle immediately before the Auto Browser brand', () => {
    const html = readFileSync(resolve(root, 'extension/sidepanel.html'), 'utf8');
    const toggleIndex = html.indexOf('id="historyToggle"');
    const brandIndex = html.indexOf('id="headerGoal">Auto Browser</h1>');

    expect(toggleIndex).toBeGreaterThan(-1);
    expect(brandIndex).toBeGreaterThan(toggleIndex);
    expect(html).toContain('id="historyToggle"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('id="historyClose"');
  });

  it('has config panel with credential and model settings', () => {
    const html = readFileSync(resolve(root, 'extension/sidepanel.html'), 'utf8');

    expect(html).toContain('id="credsEditor"');
    expect(html).toContain('id="credsLoad"');
    expect(html).toContain('id="credsSave"');
    expect(html).toContain('id="cookiePath"');
    expect(html).toContain('id="modelTier"');
    expect(html).toContain('id="plannerModel"');
    expect(html).toContain('id="executorModel"');
    expect(html).toContain('id="customPlannerField"');
    expect(html).toContain('id="customExecutorField"');
  });

  it('has unified chat view with handoff banner and command palette', () => {
    const html = readFileSync(resolve(root, 'extension/sidepanel.html'), 'utf8');

    expect(html).toContain('id="chatMessages"');
    expect(html).toContain('id="chatEmpty"');
    expect(html).toContain('id="commandPalette"');
    expect(html).toContain('id="contextArea"');
    expect(html).toContain('id="handoffBanner"');
    expect(html).toContain('id="handoffOpenTab"');
    expect(html).toContain('id="handoffResume"');
    expect(html).toContain('id="handoffCancel"');
    expect(html).toContain('id="modelTierPill"');
    expect(html).toContain('id="toast"');
    expect(html).toContain('id="screenshotLightbox"');
  });

  it('defines app grid layout and agent loop view in css', () => {
    const css = readFileSync(resolve(root, 'extension/sidepanel.css'), 'utf8');

    expect(css).toContain('grid-template-rows: auto auto minmax(0, 1fr) auto;');
    expect(css).toContain('.prompt-stack');
    expect(css).toContain('.btn-icon[aria-pressed="true"]');
    expect(css).toContain('.history-panel');
    expect(css).toContain('.history-panel.open');
    expect(css).toContain('.config-panel');
    expect(css).toContain('.config-panel.open');
    expect(css).toContain('.overlay-backdrop');
    expect(css).toContain('.composer');
    expect(css).toContain('.composer-input');
    expect(css).toContain('.composer-send');
    expect(css).toContain('.agent-loop-cards');
    expect(css).toContain('.iteration-card');
    expect(css).toContain('.error-banner');
    expect(css).toContain('.handoff-banner');
    expect(css).toContain('@keyframes slideDown');
    expect(css).toContain('@media (max-width: 480px)');
  });

  it('imports from sidepanel-state and uses local state management', () => {
    const js = readFileSync(resolve(root, 'extension/sidepanel.js'), 'utf8');

    expect(js).toContain("import {");
    expect(js).toContain("from './sidepanel-state.js';");
    expect(js).toContain('let state = {');
    expect(js).toContain('historyOpen: false');
    expect(js).toContain('function render()');
    expect(js).toContain('function refresh()');
    expect(js).toContain('function handleSubmit()');
    expect(js).toContain('function buildBrowserConfig()');
    expect(js).toContain('function renderHistoryPanel()');
    expect(js).toContain('function closeOverlays()');
    expect(js).toContain("const API = 'http://127.0.0.1:4317/api';");
    expect(js).toContain("const STORE_KEY = 'autoBrowserSidebar';");
  });

  it('handles keyboard shortcuts with modifier-aware event handling', () => {
    const js = readFileSync(resolve(root, 'extension/sidepanel.js'), 'utf8');

    expect(js).toContain("els.goalInput.addEventListener('keydown', (e) => {");
    expect(js).toContain("if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); return; }");
    expect(js).toContain("document.addEventListener('keydown', (e) => {");
    expect(js).toContain('const mod = e.metaKey || e.ctrlKey;');
    expect(js).toContain("e.key === 'Enter' && mod");
    expect(js).toContain("e.key === ',' && mod");
    expect(js).toContain("e.key === 'k' && mod");
    expect(js).toContain("e.key === '/' && !mod");
    expect(js).toContain("e.key === 'r' && mod");
    expect(js).toContain('els.goalInput.focus();');
    expect(js).toContain('els.goalInput.select();');
  });

  it('shows inline error messages instead of alert dialogs', () => {
    const js = readFileSync(resolve(root, 'extension/sidepanel.js'), 'utf8');

    expect(js).toContain('function showError(');
    expect(js).toContain('function hideError(');
    expect(js).toContain("getElementById('errorBanner')");
    expect(js).toContain("getElementById('errorMessage')");
    expect(js).not.toContain('alert(');
  });
});
