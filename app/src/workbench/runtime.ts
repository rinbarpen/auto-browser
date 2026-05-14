import fs from 'node:fs';
import path from 'node:path';
import { BrowserManager } from 'agent-browser/browser';
import { nanoid } from 'nanoid';
import type { WebSocket } from 'ws';
import { deriveStepsFromRawEvents } from './derive-steps';
import type {
  FlowDefinition,
  FlowRunRecord,
  FlowRunStepRecord,
  BrowserInstanceRecord,
  CookieRecord,
  LlmSettingsRecord,
  RecordingDebugSnapshot,
  RawRecordedEvent,
  RunEventRecord,
  StepLocator,
  StepTarget,
  WorkbenchStore,
} from './types';

type PreviewMessage =
  | {
      type: 'input_mouse';
      eventType: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
      x: number;
      y: number;
      button?: 'left' | 'right' | 'middle' | 'none';
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: number;
    }
  | {
      type: 'input_keyboard';
      eventType: 'keyDown' | 'keyUp' | 'char';
      key?: string;
      code?: string;
      text?: string;
      modifiers?: number;
    }
  | {
      type: 'status';
    };

interface RecordingState {
  id: string;
  events: RawRecordedEvent[];
  pendingInputTimer?: NodeJS.Timeout;
  pendingInputTarget?: StepTarget | null;
  lastInputCaptureAt?: number;
  lastInputCaptureError?: string | null;
  lastCapturedInputValue?: string | null;
}

interface SessionState {
  id: string;
  flowId: string | null;
  instanceId: string | null;
  browser: BrowserManager;
  sockets: Set<WebSocket>;
  sessionName: string;
  recording: RecordingState | null;
  isStreaming: boolean;
}

interface InstanceState {
  id: string;
  browser: BrowserManager;
  sockets: Set<WebSocket>;
  isStreaming: boolean;
  cdpPort: number | null;
}

interface RunControlState {
  runId: string;
  flow: FlowDefinition;
  instanceId: string | null;
  interactive: boolean;
  pauseOnFailure: boolean;
  pauseRequested: boolean;
  cancelRequested: boolean;
  pausedAtStepId: string | null;
  activeBrowser: BrowserManager | null;
  shouldCloseBrowser: boolean;
  executing: boolean;
}

/** CDP ports are allocated from this range to avoid conflicts */
const CDP_PORT_START = 9223;
const CDP_PORT_END = 9230;

export class WorkbenchRuntime {
  private sessions = new Map<string, SessionState>();
  private instances = new Map<string, InstanceState>();
  private runControls = new Map<string, RunControlState>();
  private allocatedCdpPorts = new Set<number>();
  private nextCdpPort = CDP_PORT_START;

  constructor(
    private readonly store: WorkbenchStore,
    private readonly assetsDir: string
  ) {
    fs.mkdirSync(this.assetsDir, { recursive: true });
  }

  async createSession(flow: FlowDefinition): Promise<{ sessionId: string }> {
    const sessionId = nanoid();
    const browser = new BrowserManager();
    const state: SessionState = {
      id: sessionId,
      flowId: flow.id,
      instanceId: sessionId,
      browser,
      sockets: new Set(),
      sessionName: flow.sessionConfig.sessionName || `flow-${flow.id}`,
      recording: null,
      isStreaming: false,
    };

    this.sessions.set(sessionId, state);
    await this.launchBrowser(browser, {
      id: sessionId,
      startUrl: flow.startUrl,
      profilePath: flow.sessionConfig.profile ?? null,
      cookieJarId: flow.sessionConfig.cookieJarId ?? null,
      viewport: flow.sessionConfig.viewport,
      headless: flow.sessionConfig.headless,
    });
    await this.ensureScreencast(state);
    return { sessionId };
  }

  listInstances(): BrowserInstanceRecord[] {
    const records = this.store.listBrowserInstances();
    return records.map((record) => ({
      ...record,
      status: this.instances.has(record.id) ? 'running' : record.status === 'starting' ? 'stopped' : record.status,
    }));
  }

  async createInstance(input: {
    name?: string;
    startUrl?: string;
    profilePath?: string | null;
    cookieJarId?: string | null;
    viewport?: { width: number; height: number };
    headless?: boolean;
    mode?: BrowserInstanceRecord['mode'];
    browserFamily?: BrowserInstanceRecord['browserFamily'];
    executablePath?: string;
  }): Promise<BrowserInstanceRecord> {
    const now = new Date().toISOString();
    const instance: BrowserInstanceRecord = {
      id: nanoid(),
      name: input.name?.trim() || 'Browser instance',
      status: 'stopped',
      startUrl: input.startUrl?.trim() || 'https://example.com',
      mode: input.mode ?? 'managed',
      browserFamily: input.browserFamily ?? 'chromium',
      executablePath: input.executablePath?.trim() || '',
      profilePath: input.profilePath?.trim() || null,
      cookieJarId: input.cookieJarId?.trim() || null,
      viewport: input.viewport ?? { width: 1440, height: 900 },
      headless: input.headless ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveBrowserInstance(instance);
    return instance;
  }

  async startInstance(
    instanceId: string,
    cdpPort?: number
  ): Promise<BrowserInstanceRecord> {
    const instance = this.requireInstanceRecord(instanceId);
    if (this.instances.has(instanceId)) {
      return { ...instance, status: 'running' };
    }

    this.store.updateBrowserInstance(instanceId, { status: 'starting' });
    const browser = new BrowserManager();
    const cdpPortValue = cdpPort ?? this.allocateCdpPort();
    try {
      await this.launchBrowser(browser, {
        id: instance.id,
        startUrl: instance.startUrl,
        profilePath: instance.profilePath,
        cookieJarId: instance.cookieJarId,
        viewport: instance.viewport,
        headless: instance.headless,
        mode: instance.mode,
        executablePath: instance.executablePath,
        cdpPort: cdpPortValue,
      });
      this.instances.set(instanceId, {
        id: instanceId,
        browser,
        sockets: new Set(),
        isStreaming: false,
        cdpPort: cdpPortValue,
      });
      this.store.updateBrowserInstance(instanceId, { status: 'running' });
      return this.requireInstanceRecord(instanceId);
    } catch (error) {
      await browser.close().catch(() => {});
      this.freeCdpPort(cdpPortValue);
      this.store.updateBrowserInstance(instanceId, { status: 'failed' });
      throw error;
    }
  }

  async stopInstance(instanceId: string): Promise<void> {
    const state = this.instances.get(instanceId);
    if (state) {
      for (const socket of state.sockets) {
        socket.close(1000, 'Instance stopped');
      }
      await state.browser.close().catch(() => {});
      if (state.cdpPort !== null) {
        this.freeCdpPort(state.cdpPort);
      }
      this.instances.delete(instanceId);
    }
    this.store.updateBrowserInstance(instanceId, { status: 'stopped' });
  }

  async refreshInstance(instanceId: string): Promise<BrowserInstanceRecord> {
    await this.stopInstance(instanceId);
    return this.startInstance(instanceId);
  }

  /**
   * Allocate a CDP port for a browser instance.
   */
  private allocateCdpPort(): number {
    for (let port = this.nextCdpPort; port <= CDP_PORT_END; port++) {
      if (!this.allocatedCdpPorts.has(port)) {
        this.allocatedCdpPorts.add(port);
        this.nextCdpPort = port + 1 > CDP_PORT_END ? CDP_PORT_START : port + 1;
        return port;
      }
    }
    throw new Error('No available CDP ports');
  }

  /**
   * Free a CDP port when a browser instance is stopped.
   */
  private freeCdpPort(port: number): void {
    this.allocatedCdpPorts.delete(port);
  }

  /**
   * Get the CDP endpoint for a running browser instance.
   */
  getInstanceCdpEndpoint(instanceId: string): string | null {
    const state = this.instances.get(instanceId);
    if (!state) return null;
    return state.browser.getCdpEndpoint();
  }

  attachInstancePreviewSocket(instanceId: string, ws: WebSocket): void {
    const state = this.instances.get(instanceId);
    if (!state) {
      ws.close(1011, 'Unknown instance');
      return;
    }

    state.sockets.add(ws);
    ws.send(JSON.stringify({ type: 'status', connected: true, screencasting: state.isStreaming }));
    ws.on('message', (data) => {
      void this.handleInstancePreviewMessage(instanceId, data.toString());
    });
    ws.on('close', () => {
      state.sockets.delete(ws);
    });
    void this.ensureInstanceScreencast(state);
  }

  async captureCookies(instanceId: string, jarId: string): Promise<{ cookieCount: number }> {
    const state = this.requireInstanceState(instanceId);
    const jar = this.store.getCookieJar(jarId);
    if (!jar) throw new Error(`Unknown cookie jar: ${jarId}`);
    const cookies = await state.browser.getPage().context().cookies();
    this.store.replaceCookies(
      jarId,
      cookies.map((cookie) => playwrightCookieToRecord(jarId, cookie))
    );
    return { cookieCount: cookies.length };
  }

  async applyCookies(instanceId: string, jarId: string): Promise<{ cookieCount: number }> {
    const state = this.requireInstanceState(instanceId);
    const cookieCount = await this.applyCookieJar(state.browser, jarId);
    return { cookieCount };
  }

  getLlmSettings(role: LlmSettingsRecord['role']): LlmSettingsRecord | null {
    return this.store.getLlmSettings(role);
  }

  getSession(sessionId: string): SessionState | null {
    return this.sessions.get(sessionId) ?? null;
  }

  async getRecordingDebugSnapshot(sessionId: string): Promise<RecordingDebugSnapshot> {
    const session = this.requireSession(sessionId);
    return {
      sessionId: session.id,
      pageUrl: session.browser.getPage().url() || null,
      recording: session.recording
        ? {
            id: session.recording.id,
            events: [...session.recording.events],
            pendingInputTarget: session.recording.pendingInputTarget ?? null,
            hasPendingInputTimer: Boolean(session.recording.pendingInputTimer),
            lastInputCaptureAt: session.recording.lastInputCaptureAt ?? null,
            lastInputCaptureError: session.recording.lastInputCaptureError ?? null,
            lastCapturedInputValue: session.recording.lastCapturedInputValue ?? null,
          }
        : null,
      activeInput: await inspectActiveElement(session.browser).catch(() => null),
    };
  }

  attachPreviewSocket(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      ws.close(1011, 'Unknown session');
      return;
    }

    session.sockets.add(ws);
    ws.send(
      JSON.stringify({
        type: 'status',
        connected: true,
        screencasting: session.isStreaming,
      })
    );

    ws.on('message', (data) => {
      void this.handlePreviewMessage(sessionId, data.toString());
    });

    ws.on('close', () => {
      session.sockets.delete(ws);
    });
  }

  async startRecording(sessionId: string): Promise<{ recordingId: string }> {
    const session = this.requireSession(sessionId);
    session.recording = { id: nanoid(), events: [] };
    return { recordingId: session.recording.id };
  }

  async stopRecording(sessionId: string): Promise<{ recordingId: string; steps: FlowDefinition['steps'] }> {
    const session = this.requireSession(sessionId);
    if (!session.recording) {
      throw new Error('No active recording');
    }
    await this.finalizePendingInput(session);
    const recording = session.recording;
    session.recording = null;
    return {
      recordingId: recording.id,
      steps: deriveStepsFromRawEvents(recording.events),
    };
  }

  async runFlow(
    flow: FlowDefinition,
    options?: { instanceId?: string | null; interactive?: boolean; pauseOnFailure?: boolean }
  ): Promise<{ runId: string }> {
    if (options?.interactive && !options.instanceId) {
      throw new Error('interactive runs require instanceId');
    }
    const instanceId = options?.instanceId ?? null;
    if (instanceId && !this.instances.has(instanceId)) {
      throw new Error(`Instance is not running: ${instanceId}`);
    }
    const runId = nanoid();
    const sessionId = nanoid();
    const run: FlowRunRecord = {
      id: runId,
      flowId: flow.id,
      sessionId,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      currentStepId: null,
      errorSummary: null,
    };
    this.store.createRun(run);
    this.store.appendRunEvent(this.makeRunEvent(runId, 'run_started', { flowId: flow.id }));
    this.runControls.set(runId, {
      runId,
      flow,
      instanceId,
      interactive: Boolean(options?.interactive),
      pauseOnFailure: Boolean(options?.pauseOnFailure),
      pauseRequested: false,
      cancelRequested: false,
      pausedAtStepId: null,
      activeBrowser: null,
      shouldCloseBrowser: false,
      executing: true,
    });
    void this.executeRun(runId, flow, options);
    return { runId };
  }

  requestRunPause(runId: string): boolean {
    const control = this.runControls.get(runId);
    const detail = this.store.getRunWithDetails(runId);
    if (!control || !detail || detail.run.status !== 'running') {
      return false;
    }
    control.pauseRequested = true;
    this.store.appendRunEvent(this.makeRunEvent(runId, 'run_pause_requested', { currentStepId: detail.run.currentStepId }));
    return true;
  }

  resumeRun(runId: string): boolean {
    const control = this.runControls.get(runId);
    const detail = this.store.getRunWithDetails(runId);
    if (!control || !detail || detail.run.status !== 'paused' || control.executing) {
      return false;
    }
    control.pauseRequested = false;
    control.cancelRequested = false;
    control.pausedAtStepId = null;
    control.executing = true;
    this.store.updateRun(runId, { status: 'running', finishedAt: null, errorSummary: null });
    this.store.appendRunEvent(this.makeRunEvent(runId, 'run_resumed', {}));
    void this.executeRun(runId, control.flow, {
      instanceId: control.instanceId,
      interactive: control.interactive,
      pauseOnFailure: control.pauseOnFailure,
    });
    return true;
  }

  async cancelRun(runId: string): Promise<boolean> {
    const control = this.runControls.get(runId);
    const detail = this.store.getRunWithDetails(runId);
    if (!control || !detail || ['success', 'failed', 'canceled'].includes(detail.run.status)) {
      return false;
    }
    control.cancelRequested = true;
    control.pauseRequested = false;
    this.store.updateRun(runId, {
      status: 'canceled',
      finishedAt: new Date().toISOString(),
      errorSummary: 'Run canceled',
      currentStepId: detail.run.currentStepId,
    });
    this.store.appendRunEvent(this.makeRunEvent(runId, 'run_canceled', { currentStepId: detail.run.currentStepId }));
    this.store.appendRunEvent(this.makeRunEvent(runId, 'run_finished', { status: 'canceled' }));
    if (control.shouldCloseBrowser && control.activeBrowser) {
      await control.activeBrowser.close().catch(() => {});
    }
    if (!control.executing) {
      this.runControls.delete(runId);
    }
    return true;
  }

  private async executeRun(
    runId: string,
    flow: FlowDefinition,
    options?: { instanceId?: string | null; interactive?: boolean; pauseOnFailure?: boolean }
  ): Promise<void> {
    const control = this.runControls.get(runId);
    const instanceState = options?.instanceId ? this.instances.get(options.instanceId) : null;
    const browser = instanceState?.browser ?? new BrowserManager();
    const shouldCloseBrowser = !instanceState;
    const runAssetsDir = path.join(this.assetsDir, runId);
    fs.mkdirSync(runAssetsDir, { recursive: true });
    if (control) {
      control.activeBrowser = browser;
      control.shouldCloseBrowser = shouldCloseBrowser;
      control.executing = true;
    }

    try {
      if (this.isRunCanceled(runId)) return;
      if (!instanceState) {
        await this.launchBrowser(browser, {
          id: runId,
          startUrl: flow.startUrl,
          profilePath: flow.sessionConfig.profile ?? null,
          cookieJarId: flow.sessionConfig.cookieJarId ?? null,
          viewport: flow.sessionConfig.viewport,
          headless: flow.sessionConfig.headless,
        });
      } else if (flow.sessionConfig.cookieJarId) {
        await this.applyCookieJar(browser, flow.sessionConfig.cookieJarId);
      }

      const completedStepIds = new Set(
        this.store
          .getRunWithDetails(runId)
          ?.steps.filter((step) => step.status === 'success' || step.status === 'failed' || step.status === 'skipped')
          .map((step) => step.stepId) ?? []
      );

      for (const step of flow.steps.filter((entry) => entry.enabled && !completedStepIds.has(entry.id))) {
        if (this.isRunCanceled(runId)) return;
        const startedAt = new Date().toISOString();
        this.store.updateRun(runId, { currentStepId: step.id });
        this.store.upsertRunStep({
          runId,
          stepId: step.id,
          status: 'running',
          startedAt,
          finishedAt: null,
          durationMs: null,
          pageUrl: browser.getPage().url() || flow.startUrl,
          screenshotPath: null,
          inputSnapshot: step.input,
          message: step.label,
          errorDetail: null,
        });
        this.store.appendRunEvent(this.makeRunEvent(runId, 'step_started', { stepId: step.id, label: step.label }));

        const stepStart = Date.now();
        try {
          await this.executeStep(browser, flow, step);
          const screenshotPath = path.join(runAssetsDir, `${step.id}.png`);
          await browser.getPage().screenshot({ path: screenshotPath, fullPage: false });
          const finishedAt = new Date().toISOString();
          const record: FlowRunStepRecord = {
            runId,
            stepId: step.id,
            status: 'success',
            startedAt,
            finishedAt,
            durationMs: Date.now() - stepStart,
            pageUrl: browser.getPage().url(),
            screenshotPath,
            inputSnapshot: step.input,
            message: step.label,
            errorDetail: null,
          };
          this.store.upsertRunStep(record);
          this.store.appendRunEvent(
            this.makeRunEvent(runId, 'step_succeeded', {
              stepId: step.id,
              screenshotPath,
              durationMs: record.durationMs,
            })
          );
          if (this.shouldPauseRun(runId)) {
            this.pauseRunAtStep(runId, step.id, null);
            return;
          }
        } catch (error) {
          const screenshotPath = path.join(runAssetsDir, `${step.id}-failed.png`);
          await browser.getPage().screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
          const errorMessage = error instanceof Error ? error.message : String(error);
          const finishedAt = new Date().toISOString();
          this.store.upsertRunStep({
            runId,
            stepId: step.id,
            status: 'failed',
            startedAt,
            finishedAt,
            durationMs: Date.now() - stepStart,
            pageUrl: browser.getPage().url(),
            screenshotPath,
            inputSnapshot: step.input,
            message: step.label,
            errorDetail: errorMessage,
          });
          this.store.appendRunEvent(
            this.makeRunEvent(runId, 'step_failed', {
              stepId: step.id,
              error: errorMessage,
              screenshotPath,
            })
          );
          if (this.isRunCanceled(runId)) {
            return;
          }
          if (control?.pauseOnFailure || options?.pauseOnFailure) {
            this.pauseRunAtStep(runId, step.id, errorMessage);
            return;
          }
          this.store.updateRun(runId, {
            status: 'failed',
            finishedAt,
            errorSummary: errorMessage,
            currentStepId: step.id,
          });
          this.store.appendRunEvent(this.makeRunEvent(runId, 'run_finished', { status: 'failed' }));
          this.runControls.delete(runId);
          return;
        }
      }

      if (this.isRunCanceled(runId)) return;
      this.store.updateRun(runId, {
        status: 'success',
        finishedAt: new Date().toISOString(),
        currentStepId: null,
        errorSummary: null,
      });
      this.store.appendRunEvent(this.makeRunEvent(runId, 'run_finished', { status: 'success' }));
      this.runControls.delete(runId);
    } finally {
      if (control) {
        control.executing = false;
        control.activeBrowser = null;
        control.shouldCloseBrowser = false;
        if (control.cancelRequested) {
          this.runControls.delete(runId);
        }
      }
      if (shouldCloseBrowser) {
        await browser.close().catch(() => {});
      }
    }
  }

  private shouldPauseRun(runId: string): boolean {
    return Boolean(this.runControls.get(runId)?.pauseRequested);
  }

  private isRunCanceled(runId: string): boolean {
    const detail = this.store.getRunWithDetails(runId);
    return Boolean(this.runControls.get(runId)?.cancelRequested) || detail?.run.status === 'canceled';
  }

  private pauseRunAtStep(runId: string, stepId: string, errorSummary: string | null): void {
    const control = this.runControls.get(runId);
    if (control) {
      control.pauseRequested = false;
      control.pausedAtStepId = stepId;
    }
    this.store.updateRun(runId, {
      status: 'paused',
      finishedAt: null,
      currentStepId: stepId,
      errorSummary,
    });
    this.store.appendRunEvent(this.makeRunEvent(runId, 'run_paused', { stepId, errorSummary }));
  }

  private async executeStep(browser: BrowserManager, flow: FlowDefinition, step: FlowDefinition['steps'][number]) {
    const page = browser.getPage();
    switch (step.type) {
      case 'open':
        await page.goto(String(step.input.url ?? flow.startUrl), {
          waitUntil: 'domcontentloaded',
          timeout: step.timeoutMs,
        });
        return;
      case 'click':
        await this.resolveLocator(browser, step.target).click({ timeout: step.timeoutMs });
        return;
      case 'fill':
        await this.resolveLocator(browser, step.target).fill(String(step.input.value ?? ''), {
          timeout: step.timeoutMs,
        });
        return;
      case 'press':
        if (step.target) {
          await this.resolveLocator(browser, step.target).press(String(step.input.key ?? 'Enter'), {
            timeout: step.timeoutMs,
          });
        } else {
          await page.keyboard.press(String(step.input.key ?? 'Enter'));
        }
        return;
      case 'wait':
        if (typeof step.input.text === 'string' && step.input.text.length > 0) {
          await page.getByText(step.input.text, { exact: false }).waitFor({ timeout: step.timeoutMs });
          return;
        }
        await page.waitForTimeout(step.timeoutMs);
        return;
      case 'select':
        await this.resolveLocator(browser, step.target).selectOption(String(step.input.value ?? ''));
        return;
      case 'check':
        await this.resolveLocator(browser, step.target).check({ timeout: step.timeoutMs });
        return;
      case 'uncheck':
        await this.resolveLocator(browser, step.target).uncheck({ timeout: step.timeoutMs });
        return;
      case 'assertText': {
        const text = await this.resolveLocator(browser, step.target).textContent({ timeout: step.timeoutMs });
        if (!text?.includes(String(step.input.text ?? ''))) {
          throw new Error(`Expected text to include "${step.input.text ?? ''}"`);
        }
        return;
      }
      case 'assertVisible': {
        const visible = await this.resolveLocator(browser, step.target).isVisible();
        if (!visible) {
          throw new Error('Expected target to be visible');
        }
        return;
      }
    }
  }

  private resolveLocator(browser: BrowserManager, target: StepTarget | null) {
    if (!target) {
      throw new Error('Step target is required');
    }
    const page = browser.getPage();
    return locatorFromDescriptor(page, target.locator);
  }

  private async handlePreviewMessage(sessionId: string, payload: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const message = JSON.parse(payload) as PreviewMessage;

    if (message.type === 'input_mouse') {
      await session.browser.injectMouseEvent({
        type: message.eventType,
        x: message.x,
        y: message.y,
        button: message.button,
        clickCount: message.clickCount,
        deltaX: message.deltaX,
        deltaY: message.deltaY,
        modifiers: message.modifiers,
      });

      if (
        session.recording &&
        message.eventType === 'mouseReleased' &&
        (message.button === 'left' || !message.button)
      ) {
        const target = await inspectTargetAtPoint(session.browser, message.x, message.y);
        if (target) {
          const shouldPreservePendingInput =
            Boolean(session.recording.pendingInputTimer) && !session.recording.pendingInputTarget;
          if (!shouldPreservePendingInput) {
            this.flushPendingInput(session);
          }
          session.recording.events.push({
            id: nanoid(),
            sessionId,
            recordingId: session.recording.id,
            type: 'click',
            timestamp: Date.now(),
            pageUrl: session.browser.getPage().url(),
            target,
          });
          session.recording.pendingInputTarget = target;
        }
      }
      return;
    }

    if (message.type === 'input_keyboard') {
      const shouldSyncInput =
        session.recording && (message.eventType === 'char' || message.key === 'Backspace');
      if (shouldSyncInput) {
        this.scheduleInputSync(session);
      }

      await session.browser.injectKeyboardEvent({
        type: message.eventType,
        key: message.key,
        code: message.code,
        text: message.text,
        modifiers: message.modifiers,
      });

      if (!session.recording) return;
      if (shouldSyncInput) return;

      if (message.eventType === 'keyDown' && message.key && !isPrintableKey(message.key)) {
        this.flushPendingInput(session);
        session.recording.events.push({
          id: nanoid(),
          sessionId,
          recordingId: session.recording.id,
          type: 'press',
          timestamp: Date.now(),
          pageUrl: session.browser.getPage().url(),
          target: session.recording.pendingInputTarget ?? null,
          key: message.key,
        });
      }
    }
  }

  private scheduleInputSync(session: SessionState): void {
    if (!session.recording) return;
    if (session.recording.pendingInputTimer) {
      clearTimeout(session.recording.pendingInputTimer);
    }
    session.recording.pendingInputTimer = setTimeout(() => {
      void this.captureActiveInput(session);
    }, 250);
  }

  private async captureActiveInput(session: SessionState): Promise<void> {
    if (!session.recording) return;
    session.recording.pendingInputTimer = undefined;
    session.recording.lastInputCaptureAt = Date.now();
    try {
      const details = await inspectActiveElement(session.browser);
      if (!details) {
        session.recording.lastInputCaptureError = null;
        session.recording.lastCapturedInputValue = null;
        return;
      }
      session.recording.lastInputCaptureError = null;
      session.recording.lastCapturedInputValue = details.value;
      session.recording.pendingInputTarget = details.target;
      session.recording.events = session.recording.events.filter((event) => {
        return !(event.type === 'input' && sameLocator(event.target?.locator, details.target.locator));
      });
      session.recording.events.push({
        id: nanoid(),
        sessionId: session.id,
        recordingId: session.recording.id,
        type: 'input',
        timestamp: Date.now(),
        pageUrl: session.browser.getPage().url(),
        target: details.target,
        value: details.value,
      });
    } catch (error) {
      session.recording.lastInputCaptureError = error instanceof Error ? error.message : String(error);
      session.recording.lastCapturedInputValue = null;
      return;
    }
  }

  private flushPendingInput(session: SessionState): void {
    if (session.recording?.pendingInputTimer) {
      clearTimeout(session.recording.pendingInputTimer);
      session.recording.pendingInputTimer = undefined;
    }
  }

  private async finalizePendingInput(session: SessionState): Promise<void> {
    if (!session.recording?.pendingInputTimer) {
      return;
    }
    clearTimeout(session.recording.pendingInputTimer);
    session.recording.pendingInputTimer = undefined;
    await this.captureActiveInput(session);
  }

  private async ensureScreencast(session: SessionState): Promise<void> {
    if (session.isStreaming) return;
    await session.browser.startScreencast((frame) => {
      const payload = JSON.stringify({
        type: 'frame',
        data: frame.data,
        metadata: frame.metadata,
      });
      for (const socket of session.sockets) {
        if (socket.readyState === socket.OPEN) {
          socket.send(payload);
        }
      }
    });
    session.isStreaming = true;
  }

  private async ensureInstanceScreencast(state: InstanceState): Promise<void> {
    if (state.isStreaming) return;
    await state.browser.startScreencast((frame) => {
      const payload = JSON.stringify({
        type: 'frame',
        data: frame.data,
        metadata: frame.metadata,
      });
      for (const socket of state.sockets) {
        if (socket.readyState === socket.OPEN) {
          socket.send(payload);
        }
      }
    });
    state.isStreaming = true;
  }

  private async handleInstancePreviewMessage(instanceId: string, payload: string): Promise<void> {
    const state = this.requireInstanceState(instanceId);
    const message = JSON.parse(payload) as PreviewMessage;
    if (message.type === 'input_mouse') {
      await state.browser.injectMouseEvent({
        type: message.eventType,
        x: message.x,
        y: message.y,
        button: message.button,
        clickCount: message.clickCount,
        deltaX: message.deltaX,
        deltaY: message.deltaY,
        modifiers: message.modifiers,
      });
      return;
    }

    if (message.type === 'input_keyboard') {
      await state.browser.injectKeyboardEvent({
        type: message.eventType,
        key: message.key,
        code: message.code,
        text: message.text,
        modifiers: message.modifiers,
      });
    }
  }

  private async launchBrowser(
    browser: BrowserManager,
    options: {
      id: string;
      startUrl: string;
      profilePath: string | null;
      cookieJarId: string | null;
      viewport: { width: number; height: number };
      headless: boolean;
      mode?: BrowserInstanceRecord['mode'];
      executablePath?: string;
      cdpPort?: number;
    }
  ): Promise<void> {
    const launchOptions = {
      id: options.id,
      action: 'launch',
      headless: resolveHeadlessMode({
        requestedHeadless: options.headless,
        hasDisplayServer: hasDisplayServer(),
      }),
      profile: options.profilePath ?? undefined,
      viewport: options.viewport,
      args: options.cdpPort ? [`--remote-debugging-port=${options.cdpPort}`] : undefined,
    } as const;
    await browser.launch(
      options.mode === 'system' && options.executablePath
        ? { ...launchOptions, executablePath: options.executablePath }
        : launchOptions
    );
    if (options.cookieJarId) {
      await this.applyCookieJar(browser, options.cookieJarId);
    }
    await browser.getPage().goto(options.startUrl, { waitUntil: 'domcontentloaded' });
  }

  private async applyCookieJar(browser: BrowserManager, jarId: string): Promise<number> {
    const jar = this.store.getCookieJar(jarId);
    if (!jar) throw new Error(`Unknown cookie jar: ${jarId}`);
    if (jar.cookies.length === 0) return 0;
    await browser.getPage().context().addCookies(jar.cookies.map(recordToPlaywrightCookie));
    return jar.cookies.length;
  }

  private makeRunEvent(runId: string, type: RunEventRecord['type'], payload: RunEventRecord['payload']): RunEventRecord {
    return {
      id: nanoid(),
      runId,
      type,
      createdAt: new Date().toISOString(),
      payload,
    };
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session;
  }

  private requireInstanceRecord(instanceId: string): BrowserInstanceRecord {
    const instance = this.store.getBrowserInstance(instanceId);
    if (!instance) {
      throw new Error(`Unknown instance: ${instanceId}`);
    }
    return instance;
  }

  private requireInstanceState(instanceId: string): InstanceState {
    const state = this.instances.get(instanceId);
    if (!state) {
      throw new Error(`Instance is not running: ${instanceId}`);
    }
    return state;
  }
}

type PlaywrightCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
};

function playwrightCookieToRecord(jarId: string, cookie: PlaywrightCookie): CookieRecord {
  const now = new Date().toISOString();
  return {
    id: nanoid(),
    jarId,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? null,
    path: cookie.path ?? null,
    expires: typeof cookie.expires === 'number' && cookie.expires >= 0 ? cookie.expires : null,
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite: (cookie.sameSite as CookieRecord['sameSite']) ?? null,
    url: null,
    createdAt: now,
    updatedAt: now,
  };
}

function recordToPlaywrightCookie(cookie: CookieRecord) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? undefined,
    path: cookie.path ?? undefined,
    expires: cookie.expires ?? undefined,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite ?? undefined,
    url: cookie.url ?? undefined,
  };
}

export function resolveHeadlessMode(options: {
  requestedHeadless: boolean;
  hasDisplayServer: boolean;
}): boolean {
  if (options.requestedHeadless) {
    return true;
  }
  return !options.hasDisplayServer;
}

function hasDisplayServer(): boolean {
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function locatorFromDescriptor(
  page: ReturnType<BrowserManager['getPage']>,
  locator: StepLocator
) {
  switch (locator.kind) {
    case 'label':
      return page.getByLabel(locator.value, { exact: locator.exact ?? true });
    case 'text':
      return page.getByText(locator.value, { exact: locator.exact ?? false });
    case 'role':
      return page.getByRole(locator.value as never, locator.name ? { name: locator.name, exact: locator.exact ?? true } : undefined);
    case 'placeholder':
      return page.getByPlaceholder(locator.value, { exact: locator.exact ?? true });
    case 'testid':
      return page.getByTestId(locator.value);
    case 'css':
    default:
      return page.locator(locator.value);
  }
}

async function inspectTargetAtPoint(browser: BrowserManager, x: number, y: number): Promise<StepTarget | null> {
  return browser.getPage().evaluate(
    ({ x, y }) => {
      const element = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!element) return null;

      const descriptor = element.getAttribute('aria-label') || element.textContent?.trim() || element.getAttribute('placeholder') || element.id || element.tagName.toLowerCase();
      const id = element.id?.trim();
      if (id) {
        return { descriptor, locator: { kind: 'css', value: `#${CSS.escape(id)}` } };
      }

      const testId = element.getAttribute('data-testid')?.trim();
      if (testId) {
        return { descriptor, locator: { kind: 'testid', value: testId } };
      }

      const ariaLabel = element.getAttribute('aria-label')?.trim();
      if (ariaLabel) {
        return { descriptor, locator: { kind: 'label', value: ariaLabel } };
      }

      if ('labels' in element && (element as HTMLInputElement).labels?.[0]?.textContent?.trim()) {
        return {
          descriptor,
          locator: { kind: 'label', value: (element as HTMLInputElement).labels![0].textContent!.trim() },
        };
      }

      const placeholder = element.getAttribute('placeholder')?.trim();
      if (placeholder) {
        return { descriptor, locator: { kind: 'placeholder', value: placeholder } };
      }

      const role = element.getAttribute('role')?.trim();
      const name = element.textContent?.trim();
      if (role && name) {
        return { descriptor, locator: { kind: 'role', value: role, name, exact: true } };
      }

      if (name) {
        return { descriptor, locator: { kind: 'text', value: name, exact: true } };
      }

      const tag = element.tagName.toLowerCase();
      return { descriptor, locator: { kind: 'css', value: tag } };
    },
    { x, y }
  );
}

async function inspectActiveElement(
  browser: BrowserManager
): Promise<{ target: StepTarget; value: string } | null> {
  return browser.getPage().evaluate(() => {
    const element = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    if (!element) return null;
    const value = 'value' in element ? String(element.value ?? '') : '';
    const descriptor =
      element.getAttribute('aria-label') ||
      element.getAttribute('placeholder') ||
      element.id ||
      element.name ||
      element.tagName.toLowerCase();
    const id = element.id?.trim();
    if (id) {
      return { target: { descriptor, locator: { kind: 'css', value: `#${CSS.escape(id)}` } }, value };
    }
    const label = ('labels' in element && element.labels?.[0]?.textContent?.trim()) || element.getAttribute('aria-label');
    if (label) {
      return { target: { descriptor, locator: { kind: 'label', value: label } }, value };
    }
    const placeholder = element.getAttribute('placeholder')?.trim();
    if (placeholder) {
      return { target: { descriptor, locator: { kind: 'placeholder', value: placeholder } }, value };
    }
    return { target: { descriptor, locator: { kind: 'css', value: element.tagName.toLowerCase() } }, value };
  });
}

function sameLocator(left: StepLocator | undefined, right: StepLocator | undefined): boolean {
  if (!left || !right) return false;
  return left.kind === right.kind && left.value === right.value && left.name === right.name;
}

function isPrintableKey(key: string): boolean {
  return key.length === 1;
}
