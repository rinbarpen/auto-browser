import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BrowserRegistry,
  type BrowserLaunchMode,
  type BrowserRuntimeConfig,
} from './browser-registry.js';
import { BrowserInstaller } from './browser-installer.js';
import { createCaptchaSolverFromEnv, detectCaptchaSignal, extractRecaptchaSiteKey } from './captcha-solver.js';
import { detectLoginForm, loadCredentials, matchCredentials } from './credential-store.js';
import { wrapError } from './error-context.js';
import type { LlmChatClient } from './llm-router.js';

export type TaskStatus =
  | 'draft'
  | 'ready'
  | 'running'
  | 'handoff'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PlanStep {
  id: string;
  title: string;
  intent: string;
}

export interface PlanDraft {
  summary: string;
  steps: PlanStep[];
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  messages: ConversationMessage[];
}

export interface Task {
  id: string;
  conversationId: string;
  goal: string;
  context: string | null;
  status: TaskStatus;
  planDraft: PlanDraft;
  browserConfig: BrowserRuntimeConfig;
  plannerModel: string | null;
  executorModel: string | null;
  modelTier: string | null;
  currentStepIndex: number | null;
  resultSummary: string | null;
  createdAt: string;
  updatedAt: string;
  handoffSource: string | null;
  executionSource: 'service' | 'extension' | null;
}

export interface ActionSummary {
  action: ExecutorAction['action'];
  label: string;
  ref?: string;
  url?: string;
  key?: string;
  direction?: 'up' | 'down';
  amount?: number;
  textPreview?: string;
  reason?: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  type:
    | 'conversation.created'
    | 'task.drafted'
    | 'task.ready'
    | 'task.running'
    | 'task.handoff'
    | 'task.replanned'
    | 'task.completed'
    | 'task.failed'
    | 'task.cancelled'
    | 'task.execution.action_started'
    | 'task.execution.action_completed'
    | 'task.execution.blocked'
    | 'task.execution.completed'
    | 'task.execution.iteration.started'
    | 'task.execution.llm.completion'
    | 'task.execution.iteration.completed';
  createdAt: string;
  source: 'service' | 'extension';
  summary?: ActionSummary;
  data: Record<string, unknown>;
}

export interface RefDescriptor {
  ref: string;
  role: string;
  name?: string;
  text?: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface PageObservation {
  [key: string]: unknown;
  url: string;
  title: string;
  visibleText: string;
  refs: RefDescriptor[] | Record<string, { role: string; name?: string }>;
  snapshot?: string;
  canvasRects?: Array<RefDescriptor['rect']>;
  visual?: {
    base64: string;
    mimeType: string;
    viewport: { width: number; height: number };
    reason: string;
  };
}

export interface VisualCue {
  type: 'move' | 'click' | 'highlight' | 'status';
  point?: { x: number; y: number };
  rect?: RefDescriptor['rect'];
  label?: string;
}

export interface Planner {
  draft(goal: string, browserConfig: BrowserRuntimeConfig, model: string, modelTier?: string): Promise<PlanDraft>;
  replanRemaining(taskId: string, task: Task, model: string, modelTier?: string): Promise<PlanDraft>;
}

export interface ExecutionDriverResult {
  finalStatus: 'completed' | 'handoff';
  finalMessage: string;
  steps: Array<{
    stepId: string;
    status: 'completed' | 'failed';
  }>;
}

export interface ExecutionDriver {
  execute(taskId: string, task: Task, signal?: AbortSignal): Promise<ExecutionDriverResult>;
}

export interface ManagedBrowserPage {
  goto(url: string, options: { waitUntil: 'domcontentloaded' }): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  snapshot(): Promise<{ tree: string; refs: Record<string, { role: string; name?: string }> }>;
  clickRef(ref: string): Promise<void>;
  clickPoint(x: number, y: number): Promise<void>;
  fillRef(ref: string, text: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  scroll(direction: 'up' | 'down', amount: number): Promise<void>;
  waitFor(options: { text?: string; ms?: number }): Promise<void>;
  textContent(): Promise<string>;
  canvasRects(): Promise<Array<RefDescriptor['rect']>>;
  screenshot(): Promise<{ base64: string; mimeType: string; viewport: { width: number; height: number } }>;
  evaluate<R, A>(fn: (args: A) => R, args: A): Promise<Awaited<R>>;
  getRawPage(): import('playwright-core').Page;
}

export interface CookieData {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface ManagedBrowser {
  launch(options: {
    id: string;
    action: 'launch';
    headless: boolean;
    browser: 'chromium';
    executablePath?: string;
    profile: string;
    proxy?: {
      server: string;
      bypass?: string;
    };
    cdpUrl?: string;
  }): Promise<void>;
  getPage(): ManagedBrowserPage;
  close(): Promise<void>;
  saveStorageState?(path: string): Promise<void>;
  addCookies?(cookies: CookieData[]): Promise<void>;
}

export type BrowserFactory = () => Promise<ManagedBrowser>;

export interface BrowserExecutionDriverOptions {
  browserFactory?: BrowserFactory;
  browserInstaller?: BrowserInstaller;
  hasDisplayServer?: () => boolean;
}

export interface AgentLoopExecutionDriverOptions extends BrowserExecutionDriverOptions {
  llmClient: LlmChatClient;
  maxIterations?: number;
  maxConsecutiveErrors?: number;
  eventEmitter?: EventEmitter;
}

export interface SubmitMessageOptions {
  browserConfig: BrowserRuntimeConfig;
  plannerModel: string;
  modelTier?: string;
  context: string;
}

export interface ApproveTaskOptions {
  executorModel: string;
  modelTier?: string;
  source?: 'service' | 'extension';
  signal?: AbortSignal;
}

export interface ResumeTaskOptions {
  plannerModel: string;
  modelTier?: string;
}

export interface ExtensionApprovalOptions {
  executorModel: string;
  modelTier?: string;
}

export interface ExtensionExecutionReport {
  phase: 'action_started' | 'action_completed' | 'blocked' | 'completed';
  action?: ExecutorAction;
  outcome?: 'success' | 'failed' | 'blocked';
  observationSummary?: string;
  message?: string;
}

export interface ExecutorDecider {
  decide(input: {
    task: Task;
    observation: PageObservation;
    history: Array<Record<string, unknown>>;
  }): Promise<ExecutorAction>;
}

export interface ControlServiceOptions {
  planner: Planner;
  executionDriver: ExecutionDriver;
  browserRegistry?: BrowserRegistry;
  executorDecider?: ExecutorDecider;
}

export class DemoPlanner implements Planner {
  async draft(goal: string, _browserConfig?: BrowserRuntimeConfig, _model?: string, _modelTier?: string): Promise<PlanDraft> {
    return {
      summary: `Drafted browser task for: ${goal}`,
      steps: [
        {
          id: 'plan-open',
          title: 'Open the target experience',
          intent: 'Launch the requested browser context and navigate to the task entrypoint',
        },
        {
          id: 'plan-complete',
          title: 'Complete the requested objective',
          intent: 'Carry out the described task and summarize the result back to the user',
        },
      ],
    };
  }

  async replanRemaining(taskId: string, _task?: Task, _model?: string, _modelTier?: string): Promise<PlanDraft> {
    return {
      summary: `Replanned remaining work for ${taskId}`,
      steps: [
        {
          id: 'plan-resume',
          title: 'Resume after human handoff',
          intent: 'Inspect the current page state and continue from the new baseline',
        },
      ],
    };
  }
}

export class DemoExecutionDriver implements ExecutionDriver {
  async execute(taskId: string, task: Task, _signal?: AbortSignal): Promise<ExecutionDriverResult> {
    return {
      finalStatus: 'completed',
      finalMessage: `Task ${taskId} completed with ${task.planDraft.steps.length} planned steps.`,
      steps: task.planDraft.steps.map((step) => ({ stepId: step.id, status: 'completed' })),
    };
  }
}

function controlServiceError(location: string, problem: string) {
  return wrapError(new Error(problem), {
    module: 'auto-browser.control-service',
    file: 'src/auto-browser/control-service.ts',
    location,
  });
}

export function parseSearchGoal(goal: string): string | null {
  const match = goal.trim().match(/^search(?:\s+for)?\s+(.+)$/i);
  const query = match?.[1]?.trim();
  return query ? query : null;
}

async function createDefaultBrowser(): Promise<ManagedBrowser> {
  const browserModule = (await import('../../agent-browser/dist/browser.js')) as {
    BrowserManager: new () => AgentBrowserManager;
  };
  return new AgentBrowserManagedBrowser(new browserModule.BrowserManager());
}

interface AgentBrowserManager {
  launch(options: {
    id: string;
    action: 'launch';
    headless: boolean;
    browser: 'chromium';
    executablePath?: string;
    profile: string;
    proxy?: {
      server: string;
      bypass?: string;
    };
  }): Promise<void>;
  getPage(): {
    goto(url: string, options: { waitUntil: 'domcontentloaded' }): Promise<unknown>;
    title(): Promise<string>;
    url(): string;
    context(): {
      addCookies(cookies: unknown[]): Promise<void>;
    };
    keyboard: {
      press(key: string): Promise<void>;
    };
    getByText(text: string): {
      first(): {
        waitFor(options: { state: 'visible'; timeout: number }): Promise<void>;
      };
    };
    waitForTimeout(ms: number): Promise<void>;
    locator(selector: string): {
      innerText(): Promise<string>;
    };
    evaluate<R, A>(fn: (args: A) => R, args: A): Promise<Awaited<R>>;
    screenshot(options: { type: 'jpeg'; quality: number }): Promise<Buffer | string>;
    mouse: {
      click(x: number, y: number): Promise<void>;
    };
    viewportSize?(): { width: number; height: number } | null;
  };
  getSnapshot(options?: { interactive?: boolean; compact?: boolean }): Promise<{
    tree: string;
    refs: Record<string, { role: string; name?: string }>;
  }>;
  getLocatorFromRef(ref: string): {
    click(): Promise<void>;
    fill(text: string): Promise<void>;
  } | null;
  close(): Promise<void>;
  saveStorageState(path: string): Promise<void>;
}

class AgentBrowserManagedPage implements ManagedBrowserPage {
  constructor(private readonly browser: AgentBrowserManager) {}

  goto(url: string, options: { waitUntil: 'domcontentloaded' }): Promise<unknown> {
    return this.browser.getPage().goto(url, options);
  }

  title(): Promise<string> {
    return this.browser.getPage().title();
  }

  url(): string {
    return this.browser.getPage().url();
  }

  async snapshot(): Promise<{ tree: string; refs: Record<string, { role: string; name?: string }> }> {
    const snapshot = await this.browser.getSnapshot({ interactive: true, compact: true });
    return {
      tree: snapshot.tree,
      refs: Object.fromEntries(
        Object.entries(snapshot.refs).map(([ref, data]) => [ref, { role: data.role, name: data.name }])
      ),
    };
  }

  async clickRef(ref: string): Promise<void> {
    const locator = this.browser.getLocatorFromRef(ref);
    if (!locator) {
      throw new Error(`Unknown snapshot ref: ${ref}`);
    }
    await locator.click();
  }

  async clickPoint(x: number, y: number): Promise<void> {
    await this.browser.getPage().mouse.click(x, y);
  }

  async fillRef(ref: string, text: string): Promise<void> {
    const locator = this.browser.getLocatorFromRef(ref);
    if (!locator) {
      throw new Error(`Unknown snapshot ref: ${ref}`);
    }
    await locator.fill(text);
  }

  pressKey(key: string): Promise<void> {
    return this.browser.getPage().keyboard.press(key);
  }

  scroll(direction: 'up' | 'down', amount: number): Promise<void> {
    return this.browser
      .getPage()
      .evaluate(
        ({ direction: scrollDirection, amount: scrollAmount }) => {
          const delta = scrollDirection === 'down' ? scrollAmount : -scrollAmount;
          window.scrollBy({ top: delta, behavior: 'auto' });
        },
        { direction, amount }
      );
  }

  async waitFor(options: { text?: string; ms?: number }): Promise<void> {
    if (options.text) {
      await this.browser
        .getPage()
        .getByText(options.text)
        .first()
        .waitFor({ state: 'visible', timeout: options.ms ?? 5000 });
      return;
    }
    await this.browser.getPage().waitForTimeout(options.ms ?? 1000);
  }

  async textContent(): Promise<string> {
    return this.browser.getPage().locator('body').innerText();
  }

  async canvasRects(): Promise<Array<RefDescriptor['rect']>> {
    return this.browser.getPage().evaluate(() => {
      return Array.from(document.querySelectorAll('canvas'))
        .map((canvas) => {
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
          if (!visible) {
            return null;
          }
          return {
            x: Math.max(0, rect.left),
            y: Math.max(0, rect.top),
            width: Math.min(rect.width, window.innerWidth - Math.max(0, rect.left)),
            height: Math.min(rect.height, window.innerHeight - Math.max(0, rect.top)),
          };
        })
        .filter((rect): rect is { x: number; y: number; width: number; height: number } => Boolean(rect));
    }, undefined);
  }

  evaluate<R, A>(fn: (args: A) => R, args: A): Promise<Awaited<R>> {
    return this.browser.getPage().evaluate(fn, args);
  }

  getRawPage(): import('playwright-core').Page {
    return this.browser.getPage() as import('playwright-core').Page;
  }

  async screenshot(): Promise<{ base64: string; mimeType: string; viewport: { width: number; height: number } }> {
    const page = this.browser.getPage();
    const image = await page.screenshot({ type: 'jpeg', quality: 85 });
    const viewport = page.viewportSize?.() ?? { width: 1280, height: 720 };
    return {
      base64: typeof image === 'string' ? Buffer.from(image).toString('base64') : image.toString('base64'),
      mimeType: 'image/jpeg',
      viewport,
    };
  }
}

class AgentBrowserManagedBrowser implements ManagedBrowser {
  private readonly pageAdapter: AgentBrowserManagedPage;

  constructor(private readonly browser: AgentBrowserManager) {
    this.pageAdapter = new AgentBrowserManagedPage(browser);
  }

  launch(options: {
    id: string;
    action: 'launch';
    headless: boolean;
    browser: 'chromium';
    executablePath?: string;
    profile: string;
    proxy?: {
      server: string;
      bypass?: string;
    };
    cdpUrl?: string;
  }): Promise<void> {
    return this.browser.launch(options as Parameters<AgentBrowserManager['launch']>[0]);
  }

  getPage(): ManagedBrowserPage {
    return this.pageAdapter;
  }

  close(): Promise<void> {
    return this.browser.close();
  }

  async saveStorageState(path: string): Promise<void> {
    await this.browser.saveStorageState(path);
  }

  async addCookies(cookies: CookieData[]): Promise<void> {
    const page = this.browser.getPage();
    const ctx = page.context();
    await ctx.addCookies(cookies);
  }
}

function defaultHasDisplayServer(): boolean {
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function resolveHeadlessLaunchMode(
  launchMode: BrowserLaunchMode,
  hasDisplayServer: boolean
): boolean {
  if (launchMode === 'headless') {
    return true;
  }

  if (launchMode === 'headed') {
    if (!hasDisplayServer) {
      throw new Error(
        'Headed browser execution requires DISPLAY or WAYLAND_DISPLAY to be set on Linux.'
      );
    }
    return false;
  }

  return !hasDisplayServer;
}

export function resolveBrowserProxyFromEnv(
  env: NodeJS.ProcessEnv = process.env
): { server: string; bypass?: string } | undefined {
  const server =
    env.AGENT_BROWSER_PROXY ??
    env.ALL_PROXY ??
    env.all_proxy ??
    env.HTTPS_PROXY ??
    env.https_proxy ??
    env.HTTP_PROXY ??
    env.http_proxy;
  const normalizedServer = server?.trim();
  if (!normalizedServer) {
    return undefined;
  }

  const bypass = (
    env.AGENT_BROWSER_PROXY_BYPASS ??
    env.NO_PROXY ??
    env.no_proxy
  )?.trim();

  return bypass ? { server: normalizedServer, bypass } : { server: normalizedServer };
}

async function launchTaskBrowser(options: {
  browser: ManagedBrowser;
  browserInstaller: BrowserInstaller;
  taskId: string;
  browserConfig: BrowserRuntimeConfig;
  headless: boolean;
}): Promise<void> {
  const cdpUrl = options.browserConfig.cdpUrl.trim();
  if (cdpUrl) {
    // Connect to an existing browser via CDP instead of launching a new one.
    // The browser is managed externally (e.g., by the workbench).
    await options.browser.launch({
      id: options.taskId,
      action: 'launch',
      headless: false,
      browser: 'chromium',
      profile: '',
      cdpUrl,
    });
    return;
  }

  const profilePath = options.browserConfig.profilePath.trim()
    ? options.browserConfig.profilePath
    : mkdtempSync(join(tmpdir(), 'auto-browser-profile-'));
  const launchOptions = {
    id: options.taskId,
    action: 'launch' as const,
    headless: options.headless,
    browser: 'chromium' as const,
    profile: profilePath,
    proxy: resolveBrowserProxyFromEnv(),
  };

  if (options.browserConfig.mode === 'managed') {
    await options.browserInstaller.launchManagedBrowser(() =>
      options.browser.launch(launchOptions)
    );
    return;
  }

  await options.browser.launch({
    ...launchOptions,
    executablePath: options.browserConfig.executablePath,
  });
}

async function loadCookies(
  cookiesPath: string,
  browser: ManagedBrowser,
  page: ManagedBrowserPage
): Promise<void> {
  if (!cookiesPath.trim() || !existsSync(cookiesPath)) {
    return;
  }
  try {
    const raw = readFileSync(cookiesPath, 'utf-8');
    const state = JSON.parse(raw) as { cookies?: CookieData[] };
    const cookies = Array.isArray(state.cookies) ? state.cookies : [];
    if (cookies.length === 0) {
      return;
    }
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    await browser.addCookies?.(cookies);
  } catch (error) {
    console.error(
      `Failed to load cookies from ${cookiesPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function saveCookies(
  cookiesPath: string,
  browser: ManagedBrowser
): Promise<void> {
  if (!cookiesPath.trim() || !browser.saveStorageState) {
    return;
  }
  try {
    mkdirSync(dirname(cookiesPath), { recursive: true });
    await browser.saveStorageState(cookiesPath);
  } catch (error) {
    console.error(
      `Failed to save cookies to ${cookiesPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export class BrowserExecutionDriver implements ExecutionDriver {
  private readonly browserFactory: BrowserFactory;
  private readonly browserInstaller: BrowserInstaller;
  private readonly hasDisplayServer: () => boolean;

  constructor(options: BrowserExecutionDriverOptions = {}) {
    this.browserFactory = options.browserFactory ?? createDefaultBrowser;
    this.browserInstaller = options.browserInstaller ?? new BrowserInstaller();
    this.hasDisplayServer = options.hasDisplayServer ?? defaultHasDisplayServer;
  }

  async execute(taskId: string, task: Task, _signal?: AbortSignal): Promise<ExecutionDriverResult> {
    const query = parseSearchGoal(task.goal);
    if (!query) {
      throw new Error('Only search tasks are supported by the local browser execution driver.');
    }
    const headless = resolveHeadlessLaunchMode(
      task.browserConfig.launchMode,
      this.hasDisplayServer()
    );

    const browser = await this.browserFactory();
    await launchTaskBrowser({
      browser,
      browserInstaller: this.browserInstaller,
      taskId,
      browserConfig: task.browserConfig,
      headless,
    });

    const page = browser.getPage();

    // Load persisted cookies if a cookiesPath is configured
    const cookiesPath = (task.browserConfig.cookiesPath ?? '').trim();
    if (cookiesPath) {
      await loadCookies(cookiesPath, browser, page);
    }

    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
    const title = await page.title();
    const finalUrl = page.url();

    return {
      finalStatus: 'completed',
      finalMessage: `Execution result: ${title} (${finalUrl})`,
      steps: task.planDraft.steps.map((step) => ({ stepId: step.id, status: 'completed' })),
    };
  }
}

export type ExecutorAction =
  | { action: 'navigate'; url: string; label?: string }
  | { action: 'click_ref'; ref: string; label?: string }
  | { action: 'click_point'; x: number; y: number; label?: string }
  | { action: 'fill_ref'; ref: string; text: string; label?: string; textPreview?: string }
  | { action: 'press_key'; key: string; label?: string }
  | { action: 'scroll'; direction: 'up' | 'down'; amount?: number; label?: string }
  | { action: 'wait_for'; text?: string; ms?: number; label?: string }
  | { action: 'finish'; message?: string; label?: string }
  | { action: 'handoff'; reason: string; label?: string };

export class AgentLoopExecutionDriver implements ExecutionDriver {
  private readonly browserFactory: BrowserFactory;
  private readonly browserInstaller: BrowserInstaller;
  private readonly hasDisplayServer: () => boolean;
  private readonly llmClient: LlmChatClient;
  private readonly maxIterations: number;
  private readonly maxConsecutiveErrors: number;
  private readonly captchaSolver: ReturnType<typeof createCaptchaSolverFromEnv>;
  private eventEmitter: EventEmitter | null = null;
  private cdpConnection: boolean = false;

  constructor(options: AgentLoopExecutionDriverOptions) {
    this.browserFactory = options.browserFactory ?? createDefaultBrowser;
    this.browserInstaller = options.browserInstaller ?? new BrowserInstaller();
    this.hasDisplayServer = options.hasDisplayServer ?? defaultHasDisplayServer;
    this.llmClient = options.llmClient;
    this.maxIterations = options.maxIterations ?? 20;
    this.maxConsecutiveErrors = options.maxConsecutiveErrors ?? 3;
    this.captchaSolver = createCaptchaSolverFromEnv();
    this.eventEmitter = options.eventEmitter ?? null;
  }

  setEventEmitter(emitter: EventEmitter | null): void {
    this.eventEmitter = emitter;
  }

  async execute(taskId: string, task: Task, signal?: AbortSignal): Promise<ExecutionDriverResult> {
    const executorModel = task.executorModel?.trim() ?? '';
    if (!executorModel) {
      throw new Error('Executor model is required for this request.');
    }

    const timeoutMs = Number(process.env.AUTO_BROWSER_EXECUTION_TIMEOUT_MS) || 120_000;
    if (signal?.aborted) {
      throw new Error(`Task execution cancelled before starting`);
    }
    const headless = resolveHeadlessLaunchMode(
      task.browserConfig.launchMode,
      this.hasDisplayServer()
    );

    const browser = await this.browserFactory();
    const page = browser.getPage();
    const history: Array<Record<string, unknown>> = [];
    let consecutiveErrors = 0;
    let repeatedObservationCount = 0;
    let previousObservationSignature = '';
    let pendingVisualReason: string | null = null;

    await launchTaskBrowser({
      browser,
      browserInstaller: this.browserInstaller,
      taskId,
      browserConfig: task.browserConfig,
      headless,
    });

    // Track whether this is a CDP connection so we don't close the external browser
    this.cdpConnection = task.browserConfig.cdpUrl.trim().length > 0;

    // Load persisted cookies if a cookiesPath is configured
    const cookiesPath = (task.browserConfig.cookiesPath ?? '').trim();
    if (cookiesPath) {
      await loadCookies(cookiesPath, browser, page);
    }

    try {
      const abortController = new AbortController();

      // Forward external abort signal (e.g. client disconnect)
      if (signal) {
        if (signal.aborted) {
          throw new Error('Task execution cancelled before starting');
        }
        signal.addEventListener('abort', () => abortController.abort(), { once: true });
      }

      // Enforce execution timeout
      const timeoutHandle = setTimeout(() => {
        abortController.abort();
      }, timeoutMs);

      try {
        for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
          if (abortController.signal.aborted) {
            throw new Error(`Task execution timed out after ${timeoutMs / 1000}s`);
          }

          const observation = await this.observe(page);

          this.eventEmitter?.emit('iteration.started', {
            taskId,
            iteration,
            url: observation.url,
            title: observation.title,
          });

        // Cloudflare / anti-bot challenge detection with interactive wait-and-retry
        {
          const cfResult = detectCloudflareChallenge(observation);
          if (cfResult.isChallenge) {
            const cfDeadline = Date.now() + 60_000;
            let cfResolved = false;
            while (Date.now() < cfDeadline) {
              if (abortController.signal.aborted) {
                throw new Error('Task execution timed out while waiting for Cloudflare challenge');
              }
              // Try interactive solving: click verify buttons, turnstile checkbox
              try {
                const playwrightPage = page.getRawPage();
                // Human-like mouse movement
                const vp = playwrightPage.viewportSize();
                const w = vp?.width ?? 1280;
                const h = vp?.height ?? 720;
                await playwrightPage.mouse.move(
                  Math.floor(Math.random() * (w - 20)) + 10,
                  Math.floor(Math.random() * (h - 20)) + 10,
                  { steps: Math.floor(Math.random() * 13) + 5 }
                );
                await playwrightPage.waitForTimeout(200 + Math.floor(Math.random() * 250));
                await playwrightPage.mouse.wheel(0, Math.floor(Math.random() * 360) + 120);
                // Try clicking verify/continue buttons on the main page
                for (const sel of ['text=/verify/i', 'text=/continue/i', 'button:has-text("Verify")', 'button:has-text("Continue")']) {
                  try {
                    const loc = playwrightPage.locator(sel).first();
                    if (await loc.isVisible({ timeout: 300 })) {
                      await loc.click({ delay: 30 + Math.floor(Math.random() * 90) });
                      await playwrightPage.waitForTimeout(600 + Math.floor(Math.random() * 600));
                    }
                  } catch { /* ignore */ }
                }
                // Try clicking Turnstile checkbox inside Cloudflare frames
                for (const frame of playwrightPage.frames()) {
                  const fu = frame.url();
                  if (!fu.includes('challenges.cloudflare.com')) continue;
                  try {
                    const checkbox = frame.locator('input[type="checkbox"]').first();
                    if (await checkbox.isVisible({ timeout: 300 })) {
                      await checkbox.click({ delay: 30 + Math.floor(Math.random() * 90) });
                      await playwrightPage.waitForTimeout(1200 + Math.floor(Math.random() * 1300));
                    }
                  } catch { /* ignore */ }
                }
              } catch { /* best-effort */ }
              await new Promise((r) => setTimeout(r, 1_500));
              const retryObs = await this.observe(page);
              const retryCf = detectCloudflareChallenge(retryObs);
              if (!retryCf.isChallenge) {
                for (const key of Object.keys(retryObs)) {
                  (observation as Record<string, unknown>)[key] = (retryObs as Record<string, unknown>)[key];
                }
                cfResolved = true;
                break;
              }
            }
            if (!cfResolved) {
              return {
                finalStatus: 'handoff',
                finalMessage: `Cloudflare or anti-bot challenge persisted after 60s. Human intervention is required.`,
                steps: [],
              };
            }
          }
        }

        const observationSignature = JSON.stringify({
          url: observation.url,
          title: observation.title,
          snapshot: observation.snapshot,
          visibleText: observation.visibleText,
        });
        repeatedObservationCount =
          observationSignature === previousObservationSignature ? repeatedObservationCount + 1 : 0;
        previousObservationSignature = observationSignature;
        const visualReason =
          pendingVisualReason ??
          getVisualObservationReason(task.goal, observation, repeatedObservationCount);
        pendingVisualReason = null;
        if (visualReason) {
          if (!(await attachVisualObservation(page, observation, visualReason))) {
            return {
              finalStatus: 'handoff',
              finalMessage: 'canvas UI requires visual-capable executor',
              steps: [],
            };
          }
        }

        if (shouldAutoFinish(task.goal, observation, history, repeatedObservationCount)) {
          return {
            finalStatus: 'completed',
            finalMessage: inferAutoFinishMessage(task.goal, observation),
            steps: task.planDraft.steps.map((step) => ({ stepId: step.id, status: 'completed' })),
          };
        }

        // Credential auto-fill: on early iterations, detect login forms and auto-fill
        if (iteration < 2 && history.length < 2) {
          try {
            const creds = loadCredentials(task.browserConfig.credentialsPath || undefined);
            const obsUrl = typeof observation.url === 'string' ? observation.url.trim() : '';
            const siteCreds = obsUrl ? matchCredentials(obsUrl, creds) : null;
            if (siteCreds && observation.refs) {
              const loginForm = detectLoginForm(observation.refs);
              if (loginForm.detected && loginForm.usernameRef && loginForm.passwordRef) {
                await this.applyAction(page, {
                  action: 'fill_ref',
                  ref: loginForm.usernameRef,
                  text: siteCreds.username,
                  label: 'Auto-fill username',
                  textPreview: `${siteCreds.username.slice(0, 2)}***`,
                });
                await this.applyAction(page, {
                  action: 'fill_ref',
                  ref: loginForm.passwordRef,
                  text: siteCreds.password,
                  label: 'Auto-fill password',
                });
                if (loginForm.submitRef) {
                  await this.applyAction(page, {
                    action: 'click_ref',
                    ref: loginForm.submitRef,
                    label: 'Auto-submit login',
                  });
                }
                history.push({ iteration: -1, action: 'credential_autofill', site: obsUrl });
                // Skip LLM decision for this auto-fill iteration; re-observe on next loop iteration
                continue;
              }
            }
          } catch {
            // Best-effort: if credential auto-fill fails, fall through to normal LLM flow
          }
        }

        const completion = await this.llmClient.complete({
          model: observation.visual ? process.env.AUTO_BROWSER_VISION_MODEL?.trim() || executorModel : executorModel,
          modelTier: task.modelTier || undefined,
          temperature: 0.1,
          messages: buildExecutorMessages(task, observation, history),
        });

        this.eventEmitter?.emit('llm.completion', {
          taskId,
          iteration,
          content: completion.content,
          model: completion.model,
          usage: completion.usage,
        });

        try {
          const action = parseExecutorAction(completion.content);
          let humanInterventionReason = detectHumanInterventionReason(task.goal, observation);

          // Attempt CAPTCHA solving before handing off
          if (humanInterventionReason && this.captchaSolver && detectCaptchaSignal(observation)) {
            const captchaSolved = await this.attemptCaptchaSolve(page, observation);
            if (captchaSolved) {
              humanInterventionReason = null;
              // Re-observe on next iteration after captcha solve
              continue;
            }
          }

          if (action.action === 'finish') {
            const finishInterventionReason = detectFinishMessageInterventionReason(
              task.goal,
              action.message,
              observation
            );
            if (humanInterventionReason || finishInterventionReason) {
              return {
                finalStatus: 'handoff',
                finalMessage: humanInterventionReason ?? finishInterventionReason ?? 'Human intervention is required.',
                steps: [],
              };
            }
            return {
              finalStatus: 'completed',
              finalMessage: action.message ?? formatFinishMessage(observation),
              steps: task.planDraft.steps.map((step) => ({ stepId: step.id, status: 'completed' })),
            };
          }

          if (action.action === 'handoff') {
            return {
              finalStatus: 'handoff',
              finalMessage: action.reason,
              steps: [],
            };
          }

          if (action.action === 'click_point' && !isValidClickPoint(action, observation)) {
            return {
              finalStatus: 'handoff',
              finalMessage: 'canvas UI requires visual-capable executor: invalid click_point coordinates',
              steps: [],
            };
          }

          await this.applyAction(page, action);
          history.push({ iteration, action });
          consecutiveErrors = 0;

          this.eventEmitter?.emit('iteration.completed', {
            taskId,
            iteration,
            action: summarizeExecutorAction(action),
            url: page.url(),
            title: await page.title().catch(() => ''),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          history.push({ iteration, rawCompletion: completion.content, error: message });
          pendingVisualReason = getVisualRetryReason(message, observation);
          consecutiveErrors += 1;
          if (consecutiveErrors >= this.maxConsecutiveErrors) {
            return {
              finalStatus: 'handoff',
              finalMessage: `Execution needs human help after repeated failures: ${message}`,
              steps: [],
            };
          }
        }
        }
      } finally {
        clearTimeout(timeoutHandle);
      }
    } finally {
      // Persist cookies before closing if cookiesPath is configured
      if (cookiesPath) {
        await saveCookies(cookiesPath, browser);
      }
      // Don't close the browser if connected via CDP (the workbench owns it)
      if (!this.cdpConnection) {
        await browser.close().catch(() => undefined);
      }
    }

    return {
      finalStatus: 'handoff',
      finalMessage: `Execution needs human help after exceeding ${this.maxIterations} iterations without finishing.`,
      steps: [],
    };
  }

  private async observe(page: ManagedBrowserPage): Promise<PageObservation> {
    const snapshot = await page.snapshot();
    return {
      url: page.url(),
      title: await page.title(),
      snapshot: snapshot.tree,
      refs: snapshot.refs,
      visibleText: await page.textContent().catch(() => ''),
      canvasRects: await page.canvasRects().catch(() => []),
    };
  }

  private async applyAction(
    page: ManagedBrowserPage,
    action: ExecutorActionWithoutTerminal
  ): Promise<void> {
    switch (action.action) {
      case 'navigate':
        await page.goto(action.url, { waitUntil: 'domcontentloaded' });
        return;
      case 'click_ref':
        await page.clickRef(action.ref);
        return;
      case 'click_point':
        await page.clickPoint(action.x, action.y);
        return;
      case 'fill_ref':
        await page.fillRef(action.ref, action.text);
        return;
      case 'press_key':
        await page.pressKey(action.key);
        return;
      case 'scroll':
        await page.scroll(action.direction, action.amount ?? 600);
        return;
      case 'wait_for':
        await page.waitFor({ text: action.text, ms: action.ms });
        return;
    }
  }

  private async attemptCaptchaSolve(page: ManagedBrowserPage, observation: PageObservation): Promise<boolean> {
    if (!this.captchaSolver) {
      return false;
    }
    try {
      const siteKey = extractRecaptchaSiteKey(observation);
      if (siteKey) {
        const obsUrl = typeof observation.url === 'string' ? observation.url.trim() : '';
        const result = await this.captchaSolver.solveRecaptchaV2(siteKey, obsUrl || page.url());
        if (result.solved && result.token) {
          await page.evaluate(
            (token: string) => {
              const textareas = document.querySelectorAll<HTMLTextAreaElement>('#g-recaptcha-response');
              textareas.forEach((ta) => { ta.innerHTML = token; });
              // Also try grecaptcha callback if available
              const cfg = (window as unknown as Record<string, unknown>).___grecaptcha_cfg;
              if (cfg && typeof cfg === 'object') {
                const clients = (cfg as Record<string, unknown>).clients as Record<string, { callback?: (token: string) => void }> | undefined;
                if (clients) {
                  Object.keys(clients).forEach((key) => {
                    if (typeof clients[key]?.callback === 'function') {
                      clients[key]!.callback!(token);
                    }
                  });
                }
              }
            },
            result.token
          );
          return true;
        }
      }
      // Fallback: try image captcha if observation has base64 image data
      const imageMatch = String(observation.visibleText ?? '').match(/base64,([A-Za-z0-9+/=]+)/);
      if (imageMatch?.[1]) {
        const result = await this.captchaSolver.solveImageCaptcha(imageMatch[1]);
        if (result.solved) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }
}

export class LlmExecutorDecider implements ExecutorDecider {
  constructor(private readonly llmClient: LlmChatClient) {}

  async decide(input: {
    task: Task;
    observation: PageObservation;
    history: Array<Record<string, unknown>>;
  }): Promise<ExecutorAction> {
    const executorModel = input.task.executorModel?.trim() ?? '';
    if (!executorModel) {
      throw new Error('Executor model is required for this request.');
    }

    if (
      input.observation.title &&
      /title|page title|页面标题/i.test(input.task.goal) &&
      input.history.length === 0
    ) {
      return {
        action: 'finish',
        label: 'Finish with observed title',
        message: `Title: ${input.observation.title}`,
      };
    }

    const completion = await this.llmClient.complete({
      model: input.observation.visual ? process.env.AUTO_BROWSER_VISION_MODEL?.trim() || executorModel : executorModel,
      modelTier: input.task.modelTier || undefined,
      temperature: 0.1,
      messages: buildExecutorMessages(input.task, input.observation, input.history),
    });

    const action = parseExecutorAction(completion.content);
    if (action.action === 'click_point' && !isValidClickPoint(action, input.observation)) {
      return {
        action: 'handoff',
        reason: 'canvas UI requires visual-capable executor: invalid click_point coordinates',
      };
    }
    return action;
  }
}

type ExecutorActionWithoutTerminal = Exclude<
  ExecutorAction,
  { action: 'finish' } | { action: 'handoff' }
>;

export function buildExecutorMessages(
  task: Task,
  observation: Record<string, unknown>,
  history: Array<Record<string, unknown>>
) {
  const visual = readVisualObservation(observation);
  const userPayload = {
    goal: task.goal,
    context: task.context,
    plan: task.planDraft,
    observation,
    history: history.slice(-6),
  };
  const userText = JSON.stringify(userPayload, null, 2);
  const content = visual
    ? [
        {
          type: 'text' as const,
          text: `${userText}\n\nA viewport screenshot is attached because: ${visual.reason}. Prefer semantic refs for all actions. Only return click_point when the target is inside canvas or otherwise cannot be expressed by a ref. click_point coordinates must be viewport CSS pixels within 0 <= x < ${visual.viewport.width} and 0 <= y < ${visual.viewport.height}.`,
        },
        {
          type: 'image_url' as const,
          image_url: {
            url: `data:${visual.mimeType};base64,${visual.base64}`,
            detail: 'high' as const,
          },
        },
      ]
    : userText;

  return [
    {
      role: 'system' as const,
      content:
        'You control a browser. Return JSON only. Allowed actions: navigate, click_ref, click_point, fill_ref, press_key, scroll, wait_for, finish, handoff. One action per response. Include a short label field summarizing the step for UI display. Every action must include all required fields: navigate needs url, click_ref needs ref, click_point needs x and y viewport CSS pixel coordinates, fill_ref needs ref and text, press_key needs key, scroll needs direction, wait_for needs text or ms, handoff needs reason. Prefer refs over coordinates. Use click_point only when a canvas or visual UI target cannot be represented by a semantic ref. For fill_ref, also include textPreview with a short redacted preview when useful. If the answer is already visible from the current page title or text, return finish instead of repeating actions.\n\nCORRECT EXAMPLE:\n{"action":"navigate","url":"https://example.com","label":"Go to example"}\n{"action":"click_ref","ref":"e1","label":"Click continue"}\n{"action":"fill_ref","ref":"e2","text":"hello","textPreview":"he***","label":"Fill search"}\n{"action":"finish","message":"Done: found the answer","label":"Finish task"}\n\nWRONG FORMAT (do NOT use):\n{"navigate":{"url":"https://example.com"}}\n{"click_ref":{"ref":"e1"}}\n{"action":"finish","result":"some result"}\n\nAlways use the "action" field at the top level with action name as value, NOT as a key name.',
    },
    {
      role: 'user' as const,
      content,
    },
  ];
}

export function parseExecutorAction(text: string): ExecutorAction {
  const normalized = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const match = normalized.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match?.[0] ?? normalized) as Record<string, unknown>;

  // Normalize: if parsed has no "action" field but exactly one key matching a known action name,
  // unwrap it to the standard {action, ...params} format (e.g. {"navigate":{"url":"..."}} → {action:"navigate",url:"..."})
  if (!('action' in parsed)) {
    const knownActions = ['navigate', 'click_ref', 'click_point', 'fill_ref', 'press_key', 'scroll', 'wait_for', 'finish', 'handoff'];
    const keys = Object.keys(parsed).filter((k) => k !== 'label');
    if (keys.length === 1 && knownActions.includes(keys[0]!)) {
      const params = parsed[keys[0]!];
      if (params && typeof params === 'object' && !Array.isArray(params)) {
        const unwrapped = params as Record<string, unknown>;
        parsed.action = keys[0];
        for (const [k, v] of Object.entries(unwrapped)) {
          if (!(k in parsed)) {
            parsed[k] = v;
          }
        }
        delete parsed[keys[0]!];
      }
    }
  }

  const action = typeof parsed.action === 'string' ? parsed.action : '';
  const label = typeof parsed.label === 'string' && parsed.label.trim() ? parsed.label.trim() : undefined;
  const textPreview =
    typeof parsed.textPreview === 'string' && parsed.textPreview.trim()
      ? parsed.textPreview.trim()
      : undefined;

  switch (action) {
    case 'navigate':
      if (typeof parsed.url === 'string' && parsed.url.trim()) {
        return { action, url: parsed.url, label };
      }
      break;
    case 'click_ref':
      if (typeof parsed.ref === 'string' && parsed.ref.trim()) {
        return { action, ref: parsed.ref, label };
      }
      break;
    case 'click_point':
      if (
        typeof parsed.x === 'number' &&
        Number.isFinite(parsed.x) &&
        typeof parsed.y === 'number' &&
        Number.isFinite(parsed.y)
      ) {
        return { action, x: parsed.x, y: parsed.y, label };
      }
      break;
    case 'fill_ref':
      if (
        typeof parsed.ref === 'string' &&
        parsed.ref.trim() &&
        typeof parsed.text === 'string'
      ) {
        return { action, ref: parsed.ref, text: parsed.text, label, textPreview };
      }
      break;
    case 'press_key':
      if (typeof parsed.key === 'string' && parsed.key.trim()) {
        return { action, key: parsed.key, label };
      }
      break;
    case 'scroll':
      if (parsed.direction === 'up' || parsed.direction === 'down') {
        return {
          action,
          direction: parsed.direction,
          amount: typeof parsed.amount === 'number' ? parsed.amount : undefined,
          label,
        };
      }
      break;
    case 'wait_for':
      if (
        typeof parsed.text === 'string' ||
        typeof parsed.ms === 'number' ||
        typeof parsed.duration === 'number'
      ) {
        return {
          action,
          text: typeof parsed.text === 'string' ? parsed.text : undefined,
          ms:
            typeof parsed.ms === 'number'
              ? parsed.ms
              : typeof parsed.duration === 'number'
                ? parsed.duration
                : undefined,
          label,
        };
      }
      break;
    case 'finish':
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        return { action, message: parsed.message, label };
      }
      for (const field of ['answer', 'result', 'title'] as const) {
        if (typeof parsed[field] === 'string' && parsed[field].trim()) {
          return { action, message: parsed[field], label };
        }
      }
      if (
        typeof parsed.result === 'object' &&
        parsed.result !== null &&
        typeof (parsed.result as { error?: unknown }).error === 'string' &&
        (parsed.result as { error: string }).error.trim()
      ) {
        return { action, message: (parsed.result as { error: string }).error, label };
      }
      return { action, label };
    case 'handoff':
      if (typeof parsed.reason === 'string' && parsed.reason.trim()) {
        return { action, reason: parsed.reason, label };
      }
      break;
  }

  throw controlServiceError(
    'parseExecutorAction',
    `Executor returned an invalid action payload: ${normalized.slice(0, 300)}`
  );
}

function defaultActionLabel(action: ExecutorAction): string {
  switch (action.action) {
    case 'navigate':
      return `Navigate to ${action.url}`;
    case 'click_ref':
      return `Click ${action.ref}`;
    case 'click_point':
      return `Click (${Math.round(action.x)}, ${Math.round(action.y)})`;
    case 'fill_ref':
      return `Fill ${action.ref}`;
    case 'press_key':
      return `Press ${action.key}`;
    case 'scroll':
      return `Scroll ${action.direction}`;
    case 'wait_for':
      return action.text ? `Wait for ${action.text}` : `Wait ${action.ms ?? 1000}ms`;
    case 'finish':
      return 'Finish task';
    case 'handoff':
      return 'Request handoff';
  }
}

export function sanitizeTextPreview(text: string, maxLength = 24): string {
  const normalized = text.trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= 2) {
    return '*'.repeat(normalized.length);
  }
  const head = normalized.slice(0, Math.min(2, normalized.length));
  return `${head}${'*'.repeat(Math.min(maxLength, Math.max(3, normalized.length - 3)))}`;
}

export function summarizeExecutorAction(action: ExecutorAction): ActionSummary {
  return {
    action: action.action,
    label: action.label?.trim() || defaultActionLabel(action),
    ref: 'ref' in action ? action.ref : undefined,
    url: action.action === 'navigate' ? action.url : undefined,
    key: action.action === 'press_key' ? action.key : undefined,
    direction: action.action === 'scroll' ? action.direction : undefined,
    amount: action.action === 'scroll' ? action.amount : undefined,
    textPreview:
      action.action === 'fill_ref'
        ? action.textPreview?.trim() || sanitizeTextPreview(action.text)
        : undefined,
    reason: action.action === 'handoff' ? action.reason : undefined,
  };
}

function readVisualObservation(observation: Record<string, unknown>): PageObservation['visual'] | null {
  const visual = observation.visual;
  if (!visual || typeof visual !== 'object') {
    return null;
  }
  const candidate = visual as PageObservation['visual'];
  if (
    typeof candidate?.base64 === 'string' &&
    typeof candidate.mimeType === 'string' &&
    typeof candidate.reason === 'string' &&
    typeof candidate.viewport?.width === 'number' &&
    typeof candidate.viewport.height === 'number'
  ) {
    return candidate;
  }
  return null;
}

function getObservationRefCount(observation: Record<string, unknown>): number {
  const refs = observation.refs;
  if (Array.isArray(refs)) {
    return refs.length;
  }
  if (refs && typeof refs === 'object') {
    return Object.keys(refs).length;
  }
  return 0;
}

function getCanvasRects(observation: Record<string, unknown>): Array<RefDescriptor['rect']> {
  return Array.isArray(observation.canvasRects)
    ? observation.canvasRects.filter(
        (rect): rect is RefDescriptor['rect'] =>
          Boolean(rect) &&
          typeof rect === 'object' &&
          typeof (rect as RefDescriptor['rect']).x === 'number' &&
          typeof (rect as RefDescriptor['rect']).y === 'number' &&
          typeof (rect as RefDescriptor['rect']).width === 'number' &&
          typeof (rect as RefDescriptor['rect']).height === 'number'
      )
    : [];
}

function getVisualObservationReason(
  goal: string,
  observation: Record<string, unknown>,
  repeatedObservationCount: number
): string | null {
  const canvasRects = getCanvasRects(observation);
  if (canvasRects.length === 0) {
    return null;
  }
  if (getObservationRefCount(observation) < 2) {
    return 'visible canvas with too few semantic refs';
  }
  if (repeatedObservationCount >= 2) {
    return 'visible canvas after repeated unchanged observations';
  }
  if (/\b(canvas|game|chart|graph|diagram|map|drawing|whiteboard)\b|图形|画布|地图|图表|游戏/i.test(goal)) {
    return 'task goal suggests a graphical canvas UI';
  }
  const visibleText = typeof observation.visibleText === 'string' ? observation.visibleText : '';
  if (/\b(canvas|game|chart|graph|diagram|map|drawing|whiteboard)\b|图形|画布|地图|图表|游戏/i.test(visibleText)) {
    return 'page text suggests a graphical canvas UI';
  }
  return null;
}

function getVisualRetryReason(message: string, observation: Record<string, unknown>): string | null {
  if (getCanvasRects(observation).length === 0) {
    return null;
  }
  if (/unknown snapshot ref|target ref not found|invalid action payload|ref .*not found/i.test(message)) {
    return 'ref action failed on a visible canvas page';
  }
  return null;
}

async function attachVisualObservation(
  page: ManagedBrowserPage,
  observation: PageObservation,
  reason: string
): Promise<boolean> {
  try {
    const screenshot = await page.screenshot();
    observation.visual = { ...screenshot, reason };
    return true;
  } catch {
    return false;
  }
}

function isValidClickPoint(action: Extract<ExecutorAction, { action: 'click_point' }>, observation: PageObservation): boolean {
  const viewport = observation.visual?.viewport;
  if (!viewport) {
    return false;
  }
  return action.x >= 0 && action.y >= 0 && action.x < viewport.width && action.y < viewport.height;
}

function formatFinishMessage(observation: Record<string, unknown>): string {
  const title = typeof observation.title === 'string' ? observation.title.trim() : '';
  const url = typeof observation.url === 'string' ? observation.url.trim() : '';

  if (title && url) {
    return `Finished on "${title}" (${url})`;
  }
  if (title) {
    return `Finished on "${title}"`;
  }
  if (url) {
    return `Finished on ${url}`;
  }
  return 'Finished.';
}

const CLOUDFLARE_PATTERNS = [
  'checking your browser',
  'just a moment',
  'ddos protection',
  'challenges.cloudflare.com',
  '正在检查您的浏览器',
  '浏览器安全检查',
];

function detectCloudflareChallenge(observation: Record<string, unknown>): {
  isChallenge: boolean;
  reason: string | null;
} {
  const title = typeof observation.title === 'string' ? observation.title.trim().toLowerCase() : '';
  const url = typeof observation.url === 'string' ? observation.url.trim().toLowerCase() : '';
  const visibleText =
    typeof observation.visibleText === 'string' ? observation.visibleText.trim().toLowerCase() : '';
  const combined = `${title} ${url} ${visibleText}`;

  if (CLOUDFLARE_PATTERNS.some((p) => combined.includes(p))) {
    return { isChallenge: true, reason: `Anti-bot challenge detected: page shows a security check` };
  }

  return { isChallenge: false, reason: null };
}

function detectHumanInterventionReason(
  goal: string,
  observation: Record<string, unknown>
): string | null {
  const title = typeof observation.title === 'string' ? observation.title.trim() : '';
  const url = typeof observation.url === 'string' ? observation.url.trim() : '';
  const visibleText =
    typeof observation.visibleText === 'string' ? observation.visibleText.trim() : '';
  const lowerGoal = goal.toLowerCase();
  const combined = `${title}\n${url}\n${visibleText}`.toLowerCase();

  const likelyAuthGoal =
    lowerGoal.includes('login') ||
    lowerGoal.includes('log in') ||
    lowerGoal.includes('sign in') ||
    lowerGoal.includes('gmail') ||
    lowerGoal.includes('google') ||
    lowerGoal.includes('inbox') ||
    lowerGoal.includes('account') ||
    lowerGoal.includes('mail') ||
    lowerGoal.includes('收件箱') ||
    lowerGoal.includes('邮箱') ||
    lowerGoal.includes('邮件') ||
    lowerGoal.includes('登录');

  const hasCredentialSignals =
    combined.includes('accounts.google.com') ||
    combined.includes('mail.google.com') ||
    combined.includes('sign in') ||
    combined.includes('log in') ||
    combined.includes('login') ||
    combined.includes('choose an account') ||
    combined.includes('use your google account') ||
    combined.includes('email or phone') ||
    combined.includes('forgot email') ||
    combined.includes('enter your password') ||
    combined.includes('password') ||
    combined.includes('passkey') ||
    combined.includes('登录') ||
    combined.includes('登入') ||
    combined.includes('选择账号') ||
    combined.includes('选择帐户') ||
    combined.includes('使用您的 google 账号') ||
    combined.includes('使用您的 google 帐号') ||
    combined.includes('电子邮件或电话号码') ||
    combined.includes('邮箱或电话号码') ||
    combined.includes('忘记了电子邮件地址') ||
    combined.includes('输入您的密码') ||
    combined.includes('密码');

  const hasVerificationSignals =
    combined.includes('verification code') ||
    combined.includes('two-factor') ||
    combined.includes('2-step') ||
    combined.includes('authenticator') ||
    combined.includes('security check') ||
    combined.includes('captcha') ||
    combined.includes('verify you are human') ||
    combined.includes('checking your browser') ||
    combined.includes('验证码') ||
    combined.includes('两步验证') ||
    combined.includes('双重验证') ||
    combined.includes('安全检查') ||
    combined.includes('验证您是真人');

  const hasUnsupportedBrowserSignals =
    combined.includes('this browser or app may not be secure') ||
    combined.includes('browser or app may not be secure') ||
    combined.includes('try using a different browser') ||
    combined.includes('此浏览器或应用可能不安全') ||
    combined.includes('请尝试使用其他浏览器') ||
    combined.includes('此浏览器可能不安全');

  if (hasUnsupportedBrowserSignals) {
    return 'The site rejected this automated browser session and requires a different browser or manual intervention.';
  }

  if (hasVerificationSignals) {
    return 'Authentication or verification requires human input before the task can continue.';
  }

  if (likelyAuthGoal && hasCredentialSignals) {
    return 'Login requires user credentials or account selection before the task can continue.';
  }

  return null;
}

function detectFinishMessageInterventionReason(
  goal: string,
  finishMessage: string | undefined,
  observation: Record<string, unknown>
): string | null {
  const observationReason = detectHumanInterventionReason(goal, observation);
  if (observationReason) {
    return observationReason;
  }

  const message = (finishMessage ?? '').trim().toLowerCase();
  const lowerGoal = goal.toLowerCase();
  const likelyAuthGoal =
    lowerGoal.includes('login') ||
    lowerGoal.includes('log in') ||
    lowerGoal.includes('sign in') ||
    lowerGoal.includes('gmail') ||
    lowerGoal.includes('google') ||
    lowerGoal.includes('inbox') ||
    lowerGoal.includes('account') ||
    lowerGoal.includes('mail') ||
    lowerGoal.includes('收件箱') ||
    lowerGoal.includes('邮箱') ||
    lowerGoal.includes('邮件') ||
    lowerGoal.includes('登录');

  if (!likelyAuthGoal) {
    return null;
  }

  if (
    message.includes('login page') ||
    message.includes('sign in page') ||
    message.includes('google account') ||
    message.includes('登录页') ||
    message.includes('登录页面') ||
    message.includes('登入頁')
  ) {
    return 'Login requires user credentials or account selection before the task can continue.';
  }

  if (
    message.includes('not be secure') ||
    message.includes('unsafe browser') ||
    message.includes('不安全') ||
    message.includes('其他浏览器')
  ) {
    return 'The site rejected this automated browser session and requires a different browser or manual intervention.';
  }

  return null;
}

function isSerpUrl(url: string): boolean {
  try {
    const { hostname, pathname, searchParams } = new URL(url);
    const host = hostname.replace(/^www\./, '');
    // Google, Baidu, Bing, DuckDuckGo, Yahoo Search
    if (host === 'google.com' && pathname === '/search') return true;
    if (host === 'baidu.com' && (pathname === '/s' || pathname === '/baidu')) return true;
    if (host === 'bing.com' && pathname === '/search') return true;
    if (host === 'duckduckgo.com' && searchParams.has('q')) return true;
    if ((host === 'search.yahoo.com' || host === 'yahoo.com') && pathname === '/search') return true;
    return false;
  } catch {
    return false;
  }
}

function shouldAutoFinish(
  goal: string,
  observation: Record<string, unknown>,
  history: Array<Record<string, unknown>>,
  repeatedObservationCount: number
): boolean {
  if (detectHumanInterventionReason(goal, observation)) {
    return false;
  }

  if (history.length === 0 || repeatedObservationCount < 3) {
    return false;
  }

  // Don't auto-finish on search engine results pages — the agent hasn't reached a content page yet
  const url = typeof observation.url === 'string' ? observation.url.trim() : '';
  if (url && isSerpUrl(url)) {
    return false;
  }

  const lowerGoal = goal.toLowerCase();
  if (
    !lowerGoal.includes('title') &&
    !lowerGoal.includes('year') &&
    !lowerGoal.includes('when') &&
    !lowerGoal.includes('what is') &&
    !lowerGoal.includes('tell me')
  ) {
    return false;
  }

  const title = typeof observation.title === 'string' ? observation.title.trim() : '';
  const visibleText =
    typeof observation.visibleText === 'string' ? observation.visibleText.trim() : '';

  return Boolean(title || visibleText);
}

function inferAutoFinishMessage(goal: string, observation: Record<string, unknown>): string {
  const lowerGoal = goal.toLowerCase();
  const title = typeof observation.title === 'string' ? observation.title.trim() : '';
  const visibleText =
    typeof observation.visibleText === 'string' ? observation.visibleText.trim() : '';
  const url = typeof observation.url === 'string' ? observation.url.trim() : '';

  // If still on a SERP, explain that we found search results and need to navigate
  if (url && isSerpUrl(url)) {
    return `Found search results for "${goal}" — navigating to a relevant page for details.`;
  }

  if (lowerGoal.includes('title') && title) {
    return `Title: ${title}`;
  }

  if (lowerGoal.includes('birth year') || lowerGoal.includes('year')) {
    const yearMatch = visibleText.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
    if (yearMatch) {
      return `Birth year: ${yearMatch[1]}`;
    }
  }

  if (title) {
    return `Title: ${title}`;
  }

  return formatFinishMessage(observation);
}

export class InMemoryControlService extends EventEmitter {
  private readonly conversations = new Map<string, Conversation>();
  private readonly tasks = new Map<string, Task>();
  private readonly events: TaskEvent[] = [];
  private readonly planner: Planner;
  private readonly executionDriver: ExecutionDriver;
  private readonly browserRegistry: BrowserRegistry;
  private readonly executorDecider: ExecutorDecider | null;
  private activeTaskId: string | null = null;

  constructor(options: ControlServiceOptions) {
    super();
    this.planner = options.planner;
    this.executionDriver = options.executionDriver;
    this.browserRegistry = options.browserRegistry ?? new BrowserRegistry();
    this.executorDecider = options.executorDecider ?? null;
  }

  createConversation(): Conversation {
    const timestamp = new Date().toISOString();
    const conversation: Conversation = {
      id: this.createId('conv'),
      createdAt: timestamp,
      updatedAt: timestamp,
      title: null,
      messages: [],
    };
    this.conversations.set(conversation.id, conversation);
    this.recordEvent({
      taskId: conversation.id,
      type: 'conversation.created',
      source: 'service',
      data: { conversationId: conversation.id },
    });
    return conversation;
  }

  getConversation(conversationId: string): Conversation {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw controlServiceError('getConversation', `Conversation not found: ${conversationId}`);
    }
    return conversation;
  }

  getConversations(): Conversation[] {
    return Array.from(this.conversations.values());
  }

  updateConversationTitle(conversationId: string, title: string | null): Conversation {
    const conversation = this.getConversation(conversationId);
    conversation.title = title?.trim() ? title.trim() : null;
    this.touchConversation(conversation);
    return conversation;
  }

  deleteConversation(conversationId: string): void {
    const conversation = this.getConversation(conversationId);
    const hasActiveTask = Array.from(this.tasks.values()).some(
      (task) =>
        task.conversationId === conversationId &&
        task.id === this.activeTaskId &&
        !this.isTerminal(task.status)
    );
    if (hasActiveTask) {
      throw controlServiceError(
        'deleteConversation',
        `Cannot delete conversation with active task: ${conversationId}`
      );
    }

    const taskIds = new Set(
      Array.from(this.tasks.values())
        .filter((task) => task.conversationId === conversationId)
        .map((task) => task.id)
    );
    for (const taskId of taskIds) {
      this.tasks.delete(taskId);
    }
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (event && (taskIds.has(event.taskId) || event.taskId === conversation.id)) {
        this.events.splice(index, 1);
      }
    }
    this.conversations.delete(conversationId);
  }

  getTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw controlServiceError('getTask', `Task not found: ${taskId}`);
    }
    return task;
  }

  getTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  getEventsSince(index: number): TaskEvent[] {
    return this.events.slice(index);
  }

  getActiveTask(): Task | null {
    return this.activeTaskId ? this.getTask(this.activeTaskId) : null;
  }

  clearActiveTask(): string | null {
    const taskId = this.activeTaskId;
    this.activeTaskId = null;
    return taskId;
  }

  async submitUserMessage(
    conversationId: string,
    content: string,
    options: SubmitMessageOptions
  ): Promise<Task> {
    if (this.activeTaskId) {
      throw controlServiceError('submitUserMessage', 'Only one active task can run at a time');
    }

    this.browserRegistry.validateExecutablePath(
      options.browserConfig.mode,
      options.browserConfig.executablePath
    );
    const profileResult = this.browserRegistry.validateProfilePath(options.browserConfig.profilePath);
    if (!profileResult.ok) {
      throw controlServiceError('submitUserMessage', profileResult.message);
    }

    const conversation = this.getConversation(conversationId);
    conversation.messages.push({
      id: this.createId('msg'),
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    });
    this.touchConversation(conversation);

    const plannerModel = options.plannerModel.trim();
    if (!plannerModel) {
      throw controlServiceError('submitUserMessage', 'Planner model is required for this request.');
    }

    const modelTier = options.modelTier?.trim() || null;
    const planDraft = await this.planner.draft(content, options.browserConfig, plannerModel, modelTier || undefined);
    const task: Task = {
      id: this.createId('task'),
      conversationId,
      goal: content,
      context: options.context || null,
      status: 'draft',
      planDraft,
      browserConfig: options.browserConfig,
      plannerModel,
      executorModel: null,
      modelTier,
      currentStepIndex: null,
      resultSummary: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      handoffSource: null,
      executionSource: null,
    };

    this.tasks.set(task.id, task);
    this.recordEvent({
      taskId: task.id,
      type: 'task.drafted',
      source: 'service',
      data: { summary: planDraft.summary, stepCount: planDraft.steps.length },
    });
    return task;
  }

  enterHandoff(taskId: string, source: string): Task {
    const task = this.getTask(taskId);
    if (this.isTerminal(task.status)) {
      throw controlServiceError('enterHandoff', `Cannot hand off a ${task.status} task`);
    }

    task.status = 'handoff';
    task.handoffSource = source;
    task.updatedAt = new Date().toISOString();
    if (this.activeTaskId === task.id) {
      this.activeTaskId = null;
    }

    this.recordEvent({
      taskId,
      type: 'task.handoff',
      source: task.executionSource ?? 'service',
      data: { source },
    });
    return task;
  }

  async resumeTask(taskId: string, options: ResumeTaskOptions): Promise<Task> {
    const task = this.getTask(taskId);
    const plannerModel = options.plannerModel.trim();
    if (!plannerModel) {
      throw controlServiceError('resumeTask', 'Planner model is required for this request.');
    }

    const modelTier = options.modelTier?.trim() || null;
    const planDraft = await this.planner.replanRemaining(taskId, task, plannerModel, modelTier || undefined);
    task.planDraft = planDraft;
    task.plannerModel = plannerModel;
    task.modelTier = modelTier;
    task.status = 'draft';
    task.updatedAt = new Date().toISOString();
    task.handoffSource = null;

    this.recordEvent({
      taskId,
      type: 'task.replanned',
      source: 'service',
      data: { stepCount: planDraft.steps.length },
    });
    return task;
  }

  async approveTask(taskId: string, options: ApproveTaskOptions): Promise<Task> {
    const task = this.getTask(taskId);
    if (this.activeTaskId && this.activeTaskId !== taskId) {
      throw controlServiceError('approveTask', 'Only one active task can run at a time');
    }

    const executorModel = options.executorModel.trim();
    if (!executorModel) {
      throw controlServiceError('approveTask', 'Executor model is required for this request.');
    }

    task.status = 'ready';
    task.executorModel = executorModel;
    task.modelTier = options.modelTier?.trim() || null;
    task.executionSource = options.source ?? 'service';
    task.updatedAt = new Date().toISOString();
    this.activeTaskId = task.id;
    this.recordEvent({
      taskId,
      type: 'task.ready',
      source: task.executionSource,
      data: { stepCount: task.planDraft.steps.length },
    });

    task.status = 'running';
    task.currentStepIndex = 0;
    task.updatedAt = new Date().toISOString();
    this.recordEvent({
      taskId,
      type: 'task.running',
      source: task.executionSource,
      data: { currentStepIndex: 0 },
    });

    try {
      const result = await this.executionDriver.execute(taskId, task, options.signal);
      task.resultSummary = result.finalMessage;
      task.updatedAt = new Date().toISOString();
      this.activeTaskId = null;
      if (result.finalStatus === 'completed') {
        task.status = 'completed';
        task.currentStepIndex = result.steps.length > 0 ? result.steps.length - 1 : null;
        this.getConversation(task.conversationId).messages.push({
          id: this.createId('msg'),
          role: 'assistant',
          content: result.finalMessage,
          createdAt: new Date().toISOString(),
        });
        this.touchConversationById(task.conversationId);
        this.recordEvent({
          taskId,
          type: 'task.completed',
          source: task.executionSource,
          data: { resultSummary: result.finalMessage },
        });
      } else {
        task.status = 'handoff';
        task.handoffSource = 'execution_driver';
        task.currentStepIndex = result.steps.length > 0 ? result.steps.length - 1 : task.currentStepIndex;
        this.recordEvent({
          taskId,
          type: 'task.handoff',
          source: task.executionSource,
          data: { source: 'execution_driver', reason: result.finalMessage },
        });
      }
      return task;
    } catch (error) {
      task.status = 'failed';
      task.updatedAt = new Date().toISOString();
      this.activeTaskId = null;
      this.recordEvent({
        taskId,
        type: 'task.failed',
        source: task.executionSource ?? 'service',
        data: { message: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  async executeTaskAsync(taskId: string, options: ApproveTaskOptions): Promise<Task> {
    const task = this.getTask(taskId);
    if (this.activeTaskId && this.activeTaskId !== taskId) {
      throw controlServiceError('executeTaskAsync', 'Only one active task can run at a time');
    }

    const executorModel = options.executorModel.trim();
    if (!executorModel) {
      throw controlServiceError('executeTaskAsync', 'Executor model is required for this request.');
    }

    task.status = 'ready';
    task.executorModel = executorModel;
    task.modelTier = options.modelTier?.trim() || null;
    task.executionSource = options.source ?? 'service';
    task.updatedAt = new Date().toISOString();
    this.activeTaskId = task.id;
    this.recordEvent({
      taskId,
      type: 'task.ready',
      source: task.executionSource,
      data: { stepCount: task.planDraft.steps.length },
    });

    task.status = 'running';
    task.currentStepIndex = 0;
    task.updatedAt = new Date().toISOString();
    this.recordEvent({
      taskId,
      type: 'task.running',
      source: task.executionSource,
      data: { currentStepIndex: 0 },
    });

    const bridge = new EventEmitter();
    bridge.on('iteration.started', (data: { taskId: string; iteration: number; url: string; title: string }) => {
      this.recordEvent({
        taskId: data.taskId,
        type: 'task.execution.iteration.started',
        source: task.executionSource ?? 'service',
        data: {
          iteration: data.iteration,
          url: data.url,
          title: data.title,
        },
      });
    });

    bridge.on('llm.completion', (data: { taskId: string; iteration: number; content: string; model?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }) => {
      this.recordEvent({
        taskId: data.taskId,
        type: 'task.execution.llm.completion',
        source: task.executionSource ?? 'service',
        data: {
          iteration: data.iteration,
          content: data.content,
          model: data.model,
          usage: data.usage,
        },
      });
    });

    bridge.on('iteration.completed', (data: { taskId: string; iteration: number; action: ActionSummary; url: string; title: string }) => {
      this.recordEvent({
        taskId: data.taskId,
        type: 'task.execution.iteration.completed',
        source: task.executionSource ?? 'service',
        summary: data.action,
        data: {
          iteration: data.iteration,
          url: data.url,
          title: data.title,
        },
      });
    });

    if (this.executionDriver instanceof AgentLoopExecutionDriver) {
      this.executionDriver.setEventEmitter(bridge);
    }

    void this.executionDriver
      .execute(taskId, task, options.signal)
      .then((result) => {
        task.resultSummary = result.finalMessage;
        task.updatedAt = new Date().toISOString();
        this.activeTaskId = null;
        if (result.finalStatus === 'completed') {
          task.status = 'completed';
          task.currentStepIndex = result.steps.length > 0 ? result.steps.length - 1 : null;
          this.getConversation(task.conversationId).messages.push({
            id: this.createId('msg'),
            role: 'assistant',
            content: result.finalMessage,
            createdAt: new Date().toISOString(),
          });
          this.touchConversationById(task.conversationId);
          this.recordEvent({
            taskId,
            type: 'task.completed',
            source: task.executionSource ?? 'service',
            data: { resultSummary: result.finalMessage },
          });
        } else {
          task.status = 'handoff';
          task.handoffSource = 'execution_driver';
          task.currentStepIndex = result.steps.length > 0 ? result.steps.length - 1 : task.currentStepIndex;
          this.recordEvent({
            taskId,
            type: 'task.handoff',
            source: task.executionSource ?? 'service',
            data: { source: 'execution_driver', reason: result.finalMessage },
          });
        }
      })
      .catch((error) => {
        task.status = 'failed';
        task.updatedAt = new Date().toISOString();
        this.activeTaskId = null;
        this.recordEvent({
          taskId,
          type: 'task.failed',
          source: task.executionSource ?? 'service',
          data: { message: error instanceof Error ? error.message : String(error) },
        });
      });

    return task;
  }

  async cancelTask(taskId: string): Promise<Task> {
    const task = this.getTask(taskId);
    if (this.isTerminal(task.status)) {
      throw controlServiceError('cancelTask', `Cannot cancel a task in terminal status: ${task.status}`);
    }
    task.status = 'cancelled';
    task.updatedAt = new Date().toISOString();
    if (this.activeTaskId === taskId) {
      this.activeTaskId = null;
    }
    this.recordEvent({
      taskId,
      type: 'task.cancelled',
      source: 'service',
      data: {},
    });
    return task;
  }

  async approveExtensionTask(taskId: string, options: ExtensionApprovalOptions): Promise<Task> {
    const task = this.getTask(taskId);
    if (this.activeTaskId && this.activeTaskId !== taskId) {
      throw controlServiceError('approveExtensionTask', 'Only one active task can run at a time');
    }
    const executorModel = options.executorModel.trim();
    if (!executorModel) {
      throw controlServiceError('approveExtensionTask', 'Executor model is required for this request.');
    }

    task.status = 'ready';
    task.executorModel = executorModel;
    task.modelTier = options.modelTier?.trim() || null;
    task.executionSource = 'extension';
    task.updatedAt = new Date().toISOString();
    this.activeTaskId = task.id;
    this.recordEvent({
      taskId,
      type: 'task.ready',
      source: 'extension',
      data: { stepCount: task.planDraft.steps.length, executionSource: 'extension' },
    });

    task.status = 'running';
    task.currentStepIndex = 0;
    task.updatedAt = new Date().toISOString();
    this.recordEvent({
      taskId,
      type: 'task.running',
      source: 'extension',
      data: { currentStepIndex: 0, executionSource: 'extension' },
    });
    return task;
  }

  async decideAction(
    taskId: string,
    observation: PageObservation,
    history: Array<Record<string, unknown>>
  ): Promise<ExecutorAction> {
    if (!this.executorDecider) {
      throw controlServiceError('decideAction', 'Extension executor decider is not configured.');
    }
    const task = this.getTask(taskId);
    return this.executorDecider.decide({ task, observation, history });
  }

  reportTaskProgress(taskId: string, report: ExtensionExecutionReport): Task {
    const task = this.getTask(taskId);
    const summary = report.action ? summarizeExecutorAction(report.action) : undefined;
    task.updatedAt = new Date().toISOString();

    if (report.phase === 'action_started') {
      this.recordEvent({
        taskId,
        type: 'task.execution.action_started',
        source: 'extension',
        summary,
        data: {
          outcome: report.outcome ?? 'success',
          observationSummary: report.observationSummary ?? '',
        },
      });
      return task;
    }

    if (report.phase === 'action_completed') {
      if (task.currentStepIndex !== null && task.planDraft.steps.length > 0) {
        task.currentStepIndex = Math.min(task.currentStepIndex + 1, task.planDraft.steps.length - 1);
      }
      this.recordEvent({
        taskId,
        type: 'task.execution.action_completed',
        source: 'extension',
        summary,
        data: {
          outcome: report.outcome ?? 'success',
          observationSummary: report.observationSummary ?? '',
        },
      });
      return task;
    }

    if (report.phase === 'blocked') {
      task.status = 'blocked';
      task.resultSummary = report.message ?? summary?.reason ?? report.observationSummary ?? 'Blocked';
      this.activeTaskId = null;
      this.recordEvent({
        taskId,
        type: 'task.execution.blocked',
        source: 'extension',
        summary,
        data: {
          outcome: report.outcome ?? 'blocked',
          message: task.resultSummary,
          observationSummary: report.observationSummary ?? '',
        },
      });
      return task;
    }

    task.status = report.outcome === 'blocked' ? 'handoff' : 'completed';
    task.resultSummary = report.message ?? summary?.label ?? report.observationSummary ?? 'Completed';
    this.activeTaskId = null;
    if (task.status === 'completed') {
      this.getConversation(task.conversationId).messages.push({
        id: this.createId('msg'),
        role: 'assistant',
        content: task.resultSummary,
        createdAt: new Date().toISOString(),
      });
      this.touchConversationById(task.conversationId);
    } else {
      task.handoffSource = 'extension';
    }
    this.recordEvent({
      taskId,
      type: 'task.execution.completed',
      source: 'extension',
      summary,
      data: {
        outcome: report.outcome ?? (task.status === 'completed' ? 'success' : 'blocked'),
        message: task.resultSummary,
        observationSummary: report.observationSummary ?? '',
        finalStatus: task.status,
      },
    });
    return task;
  }

  private recordEvent(input: Omit<TaskEvent, 'id' | 'createdAt'>): void {
    const event: TaskEvent = {
      id: this.createId('evt'),
      createdAt: new Date().toISOString(),
      ...input,
    };
    this.events.push(event);
    this.emit('event', event);
  }

  private isTerminal(status: TaskStatus): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
  }

  private touchConversationById(conversationId: string): void {
    this.touchConversation(this.getConversation(conversationId));
  }

  private touchConversation(conversation: Conversation): void {
    conversation.updatedAt = new Date().toISOString();
  }

  private createId(prefix: string): string {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

export type { BrowserRuntimeConfig };
