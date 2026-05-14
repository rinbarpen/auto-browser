import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('desktop shell preview layout', () => {
  it('renders the preview inside the main window instead of describing a separate window', () => {
    const indexHtml = readFileSync(resolve(root, 'desktop/index.html'), 'utf8');

    expect(indexHtml).toContain('id="previewPanel"');
    expect(indexHtml).toContain('id="previewFrame"');
    expect(indexHtml).toContain('id="previewResizeHandle"');
    expect(indexHtml).toContain('role="separator"');
    expect(indexHtml).toContain('aria-orientation="vertical"');
    expect(indexHtml).toContain('Refresh preview');
    expect(indexHtml).not.toContain('Open preview window');
    expect(indexHtml).not.toContain('separate live preview window');
    expect(indexHtml).not.toContain('opens in a separate preview window');
  });

  it('defaults to a wider preview panel and hides the splitter in stacked layouts', () => {
    const styles = readFileSync(resolve(root, 'desktop/styles.css'), 'utf8');

    expect(styles).toContain('--preview-width: minmax(560px, 62vw)');
    expect(styles).toContain('preview-resize-handle');
    expect(styles).toContain('grid-template-areas: \'sidebar main handle preview\'');
    expect(styles).toContain('grid-template-areas:\n      \'sidebar main\'\n      \'preview preview\'');
    expect(styles).toContain('.preview-resize-handle {\n    display: none;');
  });

  it('supports dragging and persists preview panel width', () => {
    const appJs = readFileSync(resolve(root, 'desktop/app.js'), 'utf8');

    expect(appJs).toContain('previewResizeHandle');
    expect(appJs).toContain("PREVIEW_WIDTH_STORAGE_KEY = 'auto-browser.previewWidth'");
    expect(appJs).toContain('initializePreviewResize');
    expect(appJs).toContain('clampPreviewWidth');
    expect(appJs).toContain("localStorage.setItem(PREVIEW_WIDTH_STORAGE_KEY");
    expect(appJs).toContain("addEventListener('pointerdown'");
    expect(appJs).toContain("addEventListener('pointermove'");
    expect(appJs).toContain("addEventListener('pointerup'");
  });

  it('stops creating a separate BrowserWindow for preview pages', () => {
    const electronMain = readFileSync(resolve(root, 'desktop/electron-main.mjs'), 'utf8');

    expect(electronMain).not.toContain('setWindowOpenHandler');
    expect(electronMain).not.toContain('previewWindow = new BrowserWindow');
    expect(electronMain).not.toContain("loadFile(join(here, 'preview.html'))");
  });

  it('serves static desktop assets when the iframe URL includes query parameters', () => {
    const server = readFileSync(resolve(root, 'scripts/serve-app-shell.mjs'), 'utf8');

    expect(server).toContain('new URL(req.url ?? \'/\', \'http://localhost\')');
    expect(server).toContain('requestUrl.pathname === \'/\' ? \'/index.html\' : requestUrl.pathname');
  });

  it('reports a clear error when the preview port is already in use', () => {
    const server = readFileSync(resolve(root, 'scripts/serve-app-shell.mjs'), 'utf8');

    expect(server).toContain("server.on('error'");
    expect(server).toContain("error.code === 'EADDRINUSE'");
    expect(server).toContain('Port ${port} is already in use');
    expect(server).toContain('node scripts/serve-app-shell.mjs desktop <port>');
  });

  it('loads browser runtime defaults from the control service instead of hard-coding macOS Chrome', () => {
    const indexHtml = readFileSync(resolve(root, 'desktop/index.html'), 'utf8');
    const appJs = readFileSync(resolve(root, 'desktop/app.js'), 'utf8');

    expect(indexHtml).not.toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(indexHtml).toContain('id="runtimeDefaultsMessage"');
    expect(appJs).toContain('loadBrowserRuntimeDefaults');
    expect(appJs).toContain("fetch(`${API_BASE}/browser-runtime/defaults`)");
    expect(appJs).toContain('runtimeDefaultsMessage');
  });

  it('renders completed task summaries in the task rail and message thread', () => {
    const appJs = readFileSync(resolve(root, 'desktop/app.js'), 'utf8');

    expect(appJs).toContain('task.resultSummary');
    expect(appJs).toContain('renderAssistantResultMessage');
    expect(appJs).toContain('Execution result');
  });

  it('renders task drafts and request failures back into the message thread', () => {
    const appJs = readFileSync(resolve(root, 'desktop/app.js'), 'utf8');

    expect(appJs).toContain('renderAssistantDraftMessage');
    expect(appJs).toContain('Draft ready:');
    expect(appJs).toContain('lastAssistantNotice');
    expect(appJs).toContain("createMessageCard('assistant', state.lastAssistantNotice)");
  });

  it('avoids blocking alert dialogs for task submission failures', () => {
    const appJs = readFileSync(resolve(root, 'desktop/app.js'), 'utf8');

    expect(appJs).not.toContain('window.alert(error.message)');
  });
});
