import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('extension sidepanel layout', () => {
  it('uses a single topbar menu, transcript main area, and bottom composer', () => {
    const html = readFileSync(resolve(root, 'extension/sidepanel.html'), 'utf8');

    expect(html).toContain('class="topbar"');
    expect(html).toContain('class="main-column"');
    expect(html).toContain('id="menuToggleButton"');
    expect(html).toContain('id="llmSettingsButton"');
    expect(html).toContain('id="overlayPanel"');
    expect(html).toContain('id="messageThread"');
    expect(html).toContain('id="timelineStrip"');
    expect(html).toContain('id="goalInput"');
    expect(html).toContain('id="sendButton"');
    expect(html).not.toContain('id="historyToggleButton"');
    expect(html).not.toContain('id="settingsToggleButton"');
    expect(html).not.toContain('class="session-bar"');
    expect(html).not.toContain('id="sessionDetails"');
    expect(html).not.toContain('id="timelineDetails"');
  });

  it('keeps secondary capabilities in the menu and LLM settings in a separate panel', () => {
    const html = readFileSync(resolve(root, 'extension/sidepanel.html'), 'utf8');

    expect(html).toContain('id="menuNav"');
    expect(html).toContain('id="historyView"');
    expect(html).toContain('id="runView"');
    expect(html).toContain('id="detailsView"');
    expect(html).toContain('id="llmSettingsPanel"');
    expect(html).toContain('id="conversationList"');
    expect(html).toContain('id="conversationMeta"');
    expect(html).toContain('id="taskTitle"');
    expect(html).toContain('id="taskSummary"');
    expect(html).toContain('id="permissionButton"');
    expect(html).toContain('id="resumeButton"');
    expect(html).toContain('id="handoffButton"');
    expect(html).toContain('id="refreshButton"');
    expect(html).toContain('id="llmPresetSelect"');
    expect(html).toContain('id="llmPresetNameInput"');
    expect(html).toContain('id="plannerModelInput"');
    expect(html).toContain('id="executorModelInput"');
    expect(html).toContain('id="newLlmPresetButton"');
    expect(html).toContain('id="saveLlmPresetButton"');
    expect(html).toContain('id="deleteLlmPresetButton"');
    expect(html).not.toContain('id="settingsView"');
    expect(html).not.toContain('id="eventList"');
  });

  it('exposes non-visible shortcut hints for core sidepanel navigation', () => {
    const html = readFileSync(resolve(root, 'extension/sidepanel.html'), 'utf8');

    expect(html).toContain('aria-keyshortcuts="Alt+M"');
    expect(html).toContain('aria-keyshortcuts="Alt+L"');
    expect(html).toContain('aria-keyshortcuts="Alt+T"');
    expect(html).toContain('title="Open menu (Alt+M)"');
    expect(html).toContain('title="LLM settings (Alt+L)"');
    expect(html).toContain('title="Task timeline (Alt+T)"');
    expect(html).toContain('aria-keyshortcuts="Alt+I Control+Enter Meta+Enter"');
    expect(html).toContain('title="Message input (Alt+I, Ctrl+Enter or Cmd+Enter to send)"');
    expect(html).toContain('data-menu-view="history" aria-keyshortcuts="Alt+1"');
    expect(html).toContain('data-menu-view="run" aria-keyshortcuts="Alt+2"');
    expect(html).toContain('data-menu-view="details" aria-keyshortcuts="Alt+3 Alt+4"');
  });

  it('removes the old rail-based sidepanel structure', () => {
    const html = readFileSync(resolve(root, 'extension/sidepanel.html'), 'utf8');

    expect(html).not.toContain('id="leftRail"');
    expect(html).not.toContain('id="rightRail"');
    expect(html).not.toContain('id="leftRailCloseButton"');
    expect(html).not.toContain('id="rightRailCloseButton"');
    expect(html).not.toContain('id="openConversationsButton"');
    expect(html).not.toContain('id="openSettingsButton"');
    expect(html).not.toContain('id="railOverlay"');
    expect(html).toContain('id="overlayBackdrop"');
  });

  it('defines transcript-first layout and single menu overlay rules in css', () => {
    const css = readFileSync(resolve(root, 'extension/sidepanel.css'), 'utf8');

    expect(css).not.toContain('grid-template-columns: 280px minmax(0, 1fr) 280px;');
    expect(css).not.toContain('.session-bar');
    expect(css).not.toContain('.supporting-panels');
    expect(css).toContain('grid-template-rows: minmax(0, 1fr) auto auto;');
    expect(css).toContain('.overlay-panel');
    expect(css).toContain('.panel-shell.overlay-open .overlay-panel');
    expect(css).toContain('.panel-shell.llm-settings-open .llm-settings-panel');
    expect(css).toContain('.overlay-backdrop');
    expect(css).toContain('.timeline-strip');
    expect(css).toContain('overflow-x: auto;');
    expect(css).toContain('.menu-nav');
    expect(css).toContain('.menu-nav-button.active');
    expect(css).toContain('@media (max-width: 1024px)');
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toContain('.message-thread');
  });

  it('uses a single menu state machine in js', () => {
    const js = readFileSync(resolve(root, 'extension/sidepanel.js'), 'utf8');

    expect(js).not.toContain('mobileLeftRailOpen');
    expect(js).not.toContain('mobileRightRailOpen');
    expect(js).not.toContain('renderRailState');
    expect(js).not.toContain('setMobileRailState');
    expect(js).not.toContain('let activeOverlay = null;');
    expect(js).not.toContain('historyToggleButton');
    expect(js).not.toContain('settingsToggleButton');
    expect(js).toContain('let menuOpen = false;');
    expect(js).toContain('let llmSettingsOpen = false;');
    expect(js).toContain("let activeMenuView = 'history';");
    expect(js).toContain('function renderOverlayState()');
    expect(js).toContain('function renderLlmPanelState()');
    expect(js).toContain('function toggleMenu()');
    expect(js).toContain('function toggleLlmSettingsPanel()');
    expect(js).toContain('function setActiveMenuView(nextView)');
    expect(js).toContain('closeOverlay();');
    expect(js).not.toContain("activeMenuView = 'settings';");
    expect(js).toContain('function renderLlmSettings()');
    expect(js).toContain('function saveActiveLlmPreset()');
    expect(js).toContain('function renderTimelineStrip()');
  });

  it('handles low-conflict global keyboard shortcuts without replacing send behavior', () => {
    const js = readFileSync(resolve(root, 'extension/sidepanel.js'), 'utf8');

    expect(js).toContain("els.goalInput.addEventListener('keydown', (event) => {");
    expect(js).toContain("if ((event.metaKey || event.ctrlKey) && event.key === 'Enter')");
    expect(js).toContain("document.addEventListener('keydown', handleGlobalShortcut);");
    expect(js).toContain('function isEditableTarget(target)');
    expect(js).toContain("target.closest('textarea, input, select, [contenteditable]')");
    expect(js).toContain('function handleGlobalShortcut(event)');
    expect(js).toContain("event.key === 'Escape' && (menuOpen || llmSettingsOpen)");
    expect(js).toContain('closeOverlay({ restoreFocus: true });');
    expect(js).toContain('function closeOverlay(options = {})');
    expect(js).toContain('(restoreLlmFocus ? els.llmSettingsButton : els.menuToggleButton).focus();');
    expect(js).toContain('isEditableTarget(event.target)');
    expect(js).toContain('const menuViewsByShortcut = {');
    expect(js).toContain("1: 'history'");
    expect(js).toContain("2: 'run'");
    expect(js).toContain("3: 'details'");
    expect(js).toContain("4: 'details'");
    expect(js).toContain("if (key === 'm')");
    expect(js).toContain("if (key === 'l')");
    expect(js).toContain("if (key === 't')");
    expect(js).toContain("if (key === 'i')");
    expect(js).toContain('els.goalInput.focus();');
    expect(js).toContain('els.timelineStrip.focus();');
    expect(js).toContain('setActiveMenuView(nextView);');
  });
});
