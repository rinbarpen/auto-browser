import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentLoopExecutionDriver,
  type ManagedBrowser,
  type ManagedBrowserPage,
  type Task,
} from './control-service.js';

class FakeAgentPage implements ManagedBrowserPage {
  currentUrl = 'about:blank';
  snapshotIndex = 0;
  readonly actions: Array<Record<string, unknown>> = [];

  async goto(url: string, options: { waitUntil: 'domcontentloaded' }): Promise<void> {
    this.actions.push({ type: 'goto', url, options });
    this.currentUrl = url;
  }

  async title(): Promise<string> {
    return this.currentUrl.includes('example.com') ? 'Example Domain' : 'Blank';
  }

  url(): string {
    return this.currentUrl;
  }

  async snapshot(): Promise<{ tree: string; refs: Record<string, { role: string; name?: string }> }> {
    const snapshots = [
      {
        tree: 'document\n  button "Continue" [ref=e1]',
        refs: { e1: { role: 'button', name: 'Continue' } },
      },
      {
        tree: 'document\n  heading "Done"',
        refs: {},
      },
    ];
    const snapshot = snapshots[Math.min(this.snapshotIndex, snapshots.length - 1)];
    this.snapshotIndex += 1;
    return snapshot;
  }

  async clickRef(ref: string): Promise<void> {
    this.actions.push({ type: 'clickRef', ref });
  }

  async clickPoint(x: number, y: number): Promise<void> {
    this.actions.push({ type: 'clickPoint', x, y });
  }

  async fillRef(ref: string, text: string): Promise<void> {
    this.actions.push({ type: 'fillRef', ref, text });
  }

  async pressKey(key: string): Promise<void> {
    this.actions.push({ type: 'pressKey', key });
  }

  async scroll(direction: 'up' | 'down', amount: number): Promise<void> {
    this.actions.push({ type: 'scroll', direction, amount });
  }

  async waitFor(options: { text?: string; ms?: number }): Promise<void> {
    this.actions.push({ type: 'waitFor', ...options });
  }

  async textContent(): Promise<string> {
    return 'Page content';
  }

  async canvasRects() {
    return [];
  }

  async screenshot() {
    return {
      base64: Buffer.from('fake-image').toString('base64'),
      mimeType: 'image/jpeg',
      viewport: { width: 800, height: 600 },
    };
  }
}

class FakeAgentBrowser implements ManagedBrowser {
  readonly page = new FakeAgentPage();
  readonly launchCalls: unknown[] = [];

  async launch(options: {
    id: string;
    action: 'launch';
    headless: boolean;
    browser: 'chromium';
    executablePath?: string;
    profile: string;
  }): Promise<void> {
    this.launchCalls.push(options);
  }

  getPage(): ManagedBrowserPage {
    return this.page;
  }

  async close(): Promise<void> {}
}

type FlowState = {
  url: string;
  title: string;
  tree: string;
  refs: Record<string, { role: string; name?: string }>;
  text: string;
  canvasRects?: Array<{ x: number; y: number; width: number; height: number }>;
};

class ScenarioAgentPage implements ManagedBrowserPage {
  readonly actions: Array<Record<string, unknown>> = [];
  private stateIndex = 0;

  constructor(private readonly states: FlowState[]) {}

  private get state(): FlowState {
    return this.states[Math.min(this.stateIndex, this.states.length - 1)];
  }

  private advance(): void {
    this.stateIndex = Math.min(this.stateIndex + 1, this.states.length - 1);
  }

  async goto(url: string, options: { waitUntil: 'domcontentloaded' }): Promise<void> {
    this.actions.push({ type: 'goto', url, options });
    if (this.state.url !== url) {
      this.advance();
    }
  }

  async title(): Promise<string> {
    return this.state.title;
  }

  url(): string {
    return this.state.url;
  }

  async snapshot(): Promise<{ tree: string; refs: Record<string, { role: string; name?: string }> }> {
    return {
      tree: this.state.tree,
      refs: this.state.refs,
    };
  }

  async clickRef(ref: string): Promise<void> {
    this.actions.push({ type: 'clickRef', ref });
    this.advance();
  }

  async clickPoint(x: number, y: number): Promise<void> {
    this.actions.push({ type: 'clickPoint', x, y });
    this.advance();
  }

  async fillRef(ref: string, text: string): Promise<void> {
    this.actions.push({ type: 'fillRef', ref, text });
  }

  async pressKey(key: string): Promise<void> {
    this.actions.push({ type: 'pressKey', key });
    this.advance();
  }

  async scroll(direction: 'up' | 'down', amount: number): Promise<void> {
    this.actions.push({ type: 'scroll', direction, amount });
  }

  async waitFor(options: { text?: string; ms?: number }): Promise<void> {
    this.actions.push({ type: 'waitFor', ...options });
  }

  async textContent(): Promise<string> {
    return this.state.text;
  }

  async canvasRects() {
    return this.state.canvasRects ?? [];
  }

  async screenshot() {
    return {
      base64: Buffer.from('fake-image').toString('base64'),
      mimeType: 'image/jpeg',
      viewport: { width: 800, height: 600 },
    };
  }
}

class ScenarioAgentBrowser implements ManagedBrowser {
  readonly launchCalls: unknown[] = [];

  constructor(readonly page: ScenarioAgentPage) {}

  async launch(options: {
    id: string;
    action: 'launch';
    headless: boolean;
    browser: 'chromium';
    executablePath?: string;
    profile: string;
  }): Promise<void> {
    this.launchCalls.push(options);
  }

  getPage(): ManagedBrowserPage {
    return this.page;
  }

  async close(): Promise<void> {}
}

function makeTask(): Task {
  return {
    id: 'task-agent',
    conversationId: 'conv-agent',
    goal: 'Open example.com and stop when the page is ready',
    context: null,
    status: 'running',
    planDraft: {
      summary: 'Drafted browser task',
      steps: [{ id: 'step-1', title: 'Open target', intent: 'Navigate to the target page' }],
    },
    browserConfig: {
      mode: 'system',
      browserFamily: 'chrome',
      executablePath: process.execPath,
      profilePath: '/tmp/profile',
      cookiesPath: '',
      credentialsPath: '',
      launchMode: 'auto',
      extensionEnabled: false,
      previewEnabled: true,
      cdpUrl: '',
    },
    plannerModel: 'planner-model',
    executorModel: 'openai/gpt-5.1',
    currentStepIndex: 0,
    resultSummary: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handoffSource: null,
    executionSource: 'service',
  };
}

const ORIGINAL_PROXY_ENV = {
  ALL_PROXY: process.env.ALL_PROXY,
  all_proxy: process.env.all_proxy,
  HTTP_PROXY: process.env.HTTP_PROXY,
  http_proxy: process.env.http_proxy,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  https_proxy: process.env.https_proxy,
  NO_PROXY: process.env.NO_PROXY,
  no_proxy: process.env.no_proxy,
  AGENT_BROWSER_PROXY: process.env.AGENT_BROWSER_PROXY,
  AGENT_BROWSER_PROXY_BYPASS: process.env.AGENT_BROWSER_PROXY_BYPASS,
  AUTO_BROWSER_VISION_MODEL: process.env.AUTO_BROWSER_VISION_MODEL,
};

describe('AgentLoopExecutionDriver', () => {
  beforeEach(() => {
    delete process.env.ALL_PROXY;
    delete process.env.all_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    delete process.env.AGENT_BROWSER_PROXY;
    delete process.env.AGENT_BROWSER_PROXY_BYPASS;
    delete process.env.AUTO_BROWSER_VISION_MODEL;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL_PROXY_ENV)) {
      if (typeof value === 'string') {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  });

  it('completes a task from llm-router actions', async () => {
    const browser = new FakeAgentBrowser();
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async ({ messages }) => {
          const prompt = String(messages[messages.length - 1]?.content ?? '');
          if (prompt.includes('about:blank')) {
            return {
              content: '{"action":"navigate","url":"https://example.com"}',
            };
          }
          return {
            content: '{"action":"finish","message":"Reached the target page"}',
          };
        },
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => true,
      maxIterations: 5,
    });

    const result = await driver.execute('task-agent', makeTask());

    expect(result.finalStatus).toBe('completed');
    expect(result.finalMessage).toBe('Reached the target page');
    expect(browser.launchCalls).toEqual([
      expect.objectContaining({
        headless: false,
        proxy: undefined,
      }),
    ]);
    expect(browser.page.actions).toContainEqual({
      type: 'goto',
      url: 'https://example.com',
      options: { waitUntil: 'domcontentloaded' },
    });
  });

  it('accepts concise finish answer fields from smaller executor models', async () => {
    const browser = new FakeAgentBrowser();
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async () => ({
          content: '{"action":"finish","title":"Example Domain"}',
        }),
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => true,
      maxIterations: 5,
    });

    const result = await driver.execute('task-agent', makeTask());

    expect(result.finalStatus).toBe('completed');
    expect(result.finalMessage).toBe('Example Domain');
  });

  it('falls back to the observed page title when finish omits a message', async () => {
    const browser = new FakeAgentBrowser();
    browser.page.currentUrl = 'https://example.com';
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async () => ({
          content: '{"action":"finish"}',
        }),
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => true,
      maxIterations: 5,
    });

    const result = await driver.execute('task-agent', makeTask());

    expect(result.finalStatus).toBe('completed');
    expect(result.finalMessage).toBe('Finished on "Example Domain" (https://example.com)');
  });

  it('accepts wait duration as an alias for milliseconds', async () => {
    const browser = new FakeAgentBrowser();
    let calls = 0;
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async () => {
          calls += 1;
          return calls === 1
            ? { content: '{"action":"wait_for","duration":2000}' }
            : { content: '{"action":"finish","message":"done"}' };
        },
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => true,
      maxIterations: 5,
    });

    const result = await driver.execute('task-agent', makeTask());

    expect(result.finalStatus).toBe('completed');
    expect(browser.page.actions).toContainEqual({
      type: 'waitFor',
      text: undefined,
      ms: 2000,
    });
  });

  it('sends visual observation for low-ref canvas screens and executes click_point', async () => {
    const browser = new ScenarioAgentBrowser(
      new ScenarioAgentPage([
        {
          url: 'https://game.example.test',
          title: 'Canvas Game',
          tree: 'document',
          refs: {},
          text: 'Choose the highlighted start tile',
          canvasRects: [{ x: 0, y: 0, width: 640, height: 480 }],
        },
        {
          url: 'https://game.example.test',
          title: 'Canvas Game',
          tree: 'document\n  text "Started"',
          refs: {},
          text: 'Started',
        },
      ])
    );
    const seenModels: string[] = [];
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async ({ model, messages }) => {
          seenModels.push(model);
          const userContent = messages[messages.length - 1]?.content;
          expect(Array.isArray(userContent)).toBe(true);
          expect(JSON.stringify(userContent)).toContain('click_point coordinates must be viewport CSS pixels');
          return { content: '{"action":"click_point","x":120,"y":160,"label":"Click start tile"}' };
        },
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => true,
      maxIterations: 1,
    });

    process.env.AUTO_BROWSER_VISION_MODEL = 'vision/model';
    const result = await driver.execute('task-agent', {
      ...makeTask(),
      goal: 'Play the canvas game and click the highlighted start tile',
    });
    delete process.env.AUTO_BROWSER_VISION_MODEL;

    expect(result.finalStatus).toBe('handoff');
    expect(result.finalMessage).toContain('exceeding 1 iterations');
    expect(seenModels).toEqual(['vision/model']);
    expect(browser.page.actions).toContainEqual({ type: 'clickPoint', x: 120, y: 160 });
  });

  it('hands off instead of failing when the model asks for help', async () => {
    const browser = new FakeAgentBrowser();
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async () => ({
          content: '{"action":"handoff","reason":"Login requires human approval"}',
        }),
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => true,
      maxIterations: 5,
    });

    const result = await driver.execute('task-agent', makeTask());

    expect(result.finalStatus).toBe('handoff');
    expect(result.finalMessage).toContain('Login requires human approval');
  });

  it('retries after an invalid executor payload and can still finish', async () => {
    const browser = new FakeAgentBrowser();
    let calls = 0;
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async () => {
          calls += 1;
          return calls === 1
            ? { content: '{"action":"fill_ref","ref":"e11"}' }
            : { content: '{"action":"finish","message":"Recovered after retry"}' };
        },
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => true,
      maxIterations: 5,
    });

    const result = await driver.execute('task-agent', makeTask());

    expect(result.finalStatus).toBe('completed');
    expect(result.finalMessage).toBe('Recovered after retry');
  });

  it('auto-finishes title extraction tasks after repeated unchanged observations', async () => {
    const browser = new FakeAgentBrowser();
    browser.page.currentUrl = 'https://example.com';
    let calls = 0;
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async () => {
          calls += 1;
          return { content: '{"action":"wait_for","ms":100}' };
        },
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => true,
      maxIterations: 5,
    });

    const result = await driver.execute('task-agent', {
      ...makeTask(),
      goal: 'Open example.com and tell me the page title',
    });

    expect(result.finalStatus).toBe('completed');
    expect(result.finalMessage).toBe('Title: Example Domain');
    expect(calls).toBeLessThan(5);
  });

  it('hands off instead of throwing when execution exceeds the iteration budget', async () => {
    const browser = new FakeAgentBrowser();
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async () => ({ content: '{"action":"wait_for","ms":100}' }),
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => true,
      maxIterations: 2,
    });

    const result = await driver.execute('task-agent', {
      ...makeTask(),
      goal: 'Complete a complex checkout flow',
    });

    expect(result.finalStatus).toBe('handoff');
    expect(result.finalMessage).toContain('exceeding 2 iterations');
  });

  it('passes proxy settings from the environment into the browser launch', async () => {
    process.env.ALL_PROXY = 'http://127.0.0.1:15732';
    process.env.NO_PROXY = 'localhost,127.0.0.1,::1';

    const browser = new FakeAgentBrowser();
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async () => ({
          content: '{"action":"finish","message":"done"}',
        }),
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => false,
      maxIterations: 5,
    });

    await driver.execute('task-agent', makeTask());

    expect(browser.launchCalls).toEqual([
      expect.objectContaining({
        proxy: {
          server: 'http://127.0.0.1:15732',
          bypass: 'localhost,127.0.0.1,::1',
        },
      }),
    ]);
  });

  it('launches headless in auto mode when no display server is present', async () => {
    const browser = new FakeAgentBrowser();
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async () => ({
          content: '{"action":"finish","message":"done"}',
        }),
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => false,
      maxIterations: 1,
    });

    const result = await driver.execute('task-agent', makeTask());

    expect(result.finalStatus).toBe('completed');
    expect(browser.launchCalls).toEqual([
      expect.objectContaining({
        headless: true,
      }),
    ]);
  });

  it('fails clearly for explicit headed mode when no display server is present', async () => {
    const browser = new FakeAgentBrowser();
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async () => ({
          content: '{"action":"finish","message":"done"}',
        }),
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => false,
      maxIterations: 1,
    });

    await expect(
      driver.execute('task-agent', {
        ...makeTask(),
        browserConfig: {
          ...makeTask().browserConfig,
          launchMode: 'headed',
        },
      })
    ).rejects.toThrow('Headed browser execution requires DISPLAY or WAYLAND_DISPLAY');
  });

  it('completes a multi-page search flow and extracts a year from the destination page', async () => {
    const browser = new ScenarioAgentBrowser(
      new ScenarioAgentPage([
        {
          url: 'about:blank',
          title: 'Blank',
          tree: 'document',
          refs: {},
          text: '',
        },
        {
          url: 'https://www.wikipedia.org',
          title: 'Wikipedia',
          tree: 'document\n  searchbox [ref=e11]\n  button "Search" [ref=e12]',
          refs: {
            e11: { role: 'textbox', name: 'Search Wikipedia' },
            e12: { role: 'button', name: 'Search' },
          },
          text: 'Wikipedia The Free Encyclopedia',
        },
        {
          url: 'https://en.wikipedia.org/wiki/Alan_Turing',
          title: 'Alan Turing - Wikipedia',
          tree: 'document\n  heading "Alan Turing"\n  text "23 June 1912"',
          refs: {},
          text: 'Alan Turing Born 23 June 1912 Died 7 June 1954',
        },
      ])
    );
    let calls = 0;
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async () => {
          calls += 1;
          if (calls === 1) return { content: '{"action":"navigate","url":"https://www.wikipedia.org"}' };
          if (calls === 2) return { content: '{"action":"fill_ref","ref":"e11","text":"Alan Turing"}' };
          if (calls === 3) return { content: '{"action":"press_key","key":"Enter"}' };
          return { content: '{"action":"finish","message":"Birth year: 1912"}' };
        },
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => true,
      maxIterations: 8,
    });

    const result = await driver.execute('task-agent', {
      ...makeTask(),
      goal: 'Open Wikipedia, search for Alan Turing, and tell me his birth year',
      planDraft: {
        summary: 'Search and extract a birth year',
        steps: [
          { id: 'step-1', title: 'Open Wikipedia', intent: 'Navigate to Wikipedia' },
          { id: 'step-2', title: 'Search Alan Turing', intent: 'Use the search field' },
          { id: 'step-3', title: 'Extract birth year', intent: 'Read the year from the article' },
        ],
      },
    });

    expect(result.finalStatus).toBe('completed');
    expect(result.finalMessage).toBe('Birth year: 1912');
    expect(browser.page.actions).toEqual([
      { type: 'goto', url: 'https://www.wikipedia.org', options: { waitUntil: 'domcontentloaded' } },
      { type: 'fillRef', ref: 'e11', text: 'Alan Turing' },
      { type: 'pressKey', key: 'Enter' },
    ]);
    expect(await browser.page.title()).toBe('Alan Turing - Wikipedia');
  });

  it('completes a cross-page click flow and reports the destination title', async () => {
    const browser = new ScenarioAgentBrowser(
      new ScenarioAgentPage([
        {
          url: 'about:blank',
          title: 'Blank',
          tree: 'document',
          refs: {},
          text: '',
        },
        {
          url: 'https://www.example.com',
          title: 'Example Domain',
          tree: 'document\n  link "More information..." [ref=e1]',
          refs: {
            e1: { role: 'link', name: 'More information...' },
          },
          text: 'Example Domain More information...',
        },
        {
          url: 'https://www.iana.org/help/example-domains',
          title: 'About Us',
          tree: 'document\n  heading "About Us"',
          refs: {},
          text: 'About Us Example domains are for use in documentation.',
        },
      ])
    );
    let calls = 0;
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async () => {
          calls += 1;
          if (calls === 1) return { content: '{"action":"navigate","url":"https://www.example.com"}' };
          if (calls === 2) return { content: '{"action":"click_ref","ref":"e1"}' };
          return { content: '{"action":"finish","message":"Title: About Us"}' };
        },
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => true,
      maxIterations: 6,
    });

    const result = await driver.execute('task-agent', {
      ...makeTask(),
      goal: 'Open example.com, click the More information link, and tell me the final page title',
    });

    expect(result.finalStatus).toBe('completed');
    expect(result.finalMessage).toBe('Title: About Us');
    expect(browser.page.actions).toEqual([
      { type: 'goto', url: 'https://www.example.com', options: { waitUntil: 'domcontentloaded' } },
      { type: 'clickRef', ref: 'e1' },
    ]);
    expect(browser.page.url()).toBe('https://www.iana.org/help/example-domains');
  });

  it('hands off a multi-page flow when a later screen requires human approval', async () => {
    const browser = new ScenarioAgentBrowser(
      new ScenarioAgentPage([
        {
          url: 'about:blank',
          title: 'Blank',
          tree: 'document',
          refs: {},
          text: '',
        },
        {
          url: 'https://app.example.test/login',
          title: 'Login',
          tree: 'document\n  textbox "Email" [ref=e1]\n  button "Continue" [ref=e2]',
          refs: {
            e1: { role: 'textbox', name: 'Email' },
            e2: { role: 'button', name: 'Continue' },
          },
          text: 'Enter your email to continue',
        },
        {
          url: 'https://app.example.test/otp',
          title: 'Two-Factor Authentication',
          tree: 'document\n  heading "Enter verification code"',
          refs: {},
          text: 'Enter verification code from your authenticator app',
        },
      ])
    );
    let calls = 0;
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async () => {
          calls += 1;
          if (calls === 1) return { content: '{"action":"navigate","url":"https://app.example.test/login"}' };
          if (calls === 2) return { content: '{"action":"click_ref","ref":"e2"}' };
          return { content: '{"action":"handoff","reason":"Two-factor code is required on the verification page"}' };
        },
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => true,
      maxIterations: 6,
    });

    const result = await driver.execute('task-agent', {
      ...makeTask(),
      goal: 'Log in to the app and stop if verification is required',
    });

    expect(result.finalStatus).toBe('handoff');
    expect(result.finalMessage).toContain('Two-factor code is required');
    expect(browser.page.actions).toEqual([
      { type: 'goto', url: 'https://app.example.test/login', options: { waitUntil: 'domcontentloaded' } },
      { type: 'clickRef', ref: 'e2' },
    ]);
    expect(browser.page.url()).toBe('https://app.example.test/otp');
  });

  it('hands off when a captcha verification screen appears', async () => {
    const browser = new ScenarioAgentBrowser(
      new ScenarioAgentPage([
        {
          url: 'about:blank',
          title: 'Blank',
          tree: 'document',
          refs: {},
          text: '',
        },
        {
          url: 'https://shop.example.test/checkout',
          title: 'Checkout',
          tree: 'document\n  button "Continue to payment" [ref=e1]',
          refs: {
            e1: { role: 'button', name: 'Continue to payment' },
          },
          text: 'Checkout Continue to payment',
        },
        {
          url: 'https://shop.example.test/captcha',
          title: 'Security Check',
          tree: 'document\n  heading "Verify you are human"\n  text "CAPTCHA"',
          refs: {},
          text: 'Verify you are human CAPTCHA required before continuing',
        },
      ])
    );
    let calls = 0;
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async () => {
          calls += 1;
          if (calls === 1) {
            return { content: '{"action":"navigate","url":"https://shop.example.test/checkout"}' };
          }
          if (calls === 2) {
            return { content: '{"action":"click_ref","ref":"e1"}' };
          }
          return { content: '{"action":"handoff","reason":"CAPTCHA verification is required before checkout can continue"}' };
        },
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => true,
      maxIterations: 6,
    });

    const result = await driver.execute('task-agent', {
      ...makeTask(),
      goal: 'Complete checkout and stop if a captcha is required',
    });

    expect(result.finalStatus).toBe('handoff');
    expect(result.finalMessage).toContain('CAPTCHA verification is required');
    expect(browser.page.actions).toEqual([
      { type: 'goto', url: 'https://shop.example.test/checkout', options: { waitUntil: 'domcontentloaded' } },
      { type: 'clickRef', ref: 'e1' },
    ]);
    expect(browser.page.url()).toBe('https://shop.example.test/captcha');
  });

  it('hands off when a Cloudflare challenge wall appears', async () => {
    const browser = new ScenarioAgentBrowser(
      new ScenarioAgentPage([
        {
          url: 'about:blank',
          title: 'Blank',
          tree: 'document',
          refs: {},
          text: '',
        },
        {
          url: 'https://protected.example.test',
          title: 'Just a moment...',
          tree: 'document\n  heading "Checking your browser before accessing protected.example.test"',
          refs: {},
          text: 'Checking your browser before accessing protected.example.test Cloudflare Ray ID',
        },
      ])
    );
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async ({ messages }) => {
          const prompt = String(messages[messages.length - 1]?.content ?? '');
          if (prompt.includes('about:blank')) {
            return { content: '{"action":"navigate","url":"https://protected.example.test"}' };
          }
          return {
            content:
              '{"action":"handoff","reason":"Cloudflare browser verification wall is blocking access and needs human intervention"}',
          };
        },
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => true,
      maxIterations: 5,
    });

    const result = await driver.execute('task-agent', {
      ...makeTask(),
      goal: 'Open the protected site and continue only if Cloudflare verification is not required',
    });

    expect(result.finalStatus).toBe('handoff');
    expect(result.finalMessage).toContain('Cloudflare or anti-bot challenge persisted');
    expect(browser.page.actions).toEqual([
      { type: 'goto', url: 'https://protected.example.test', options: { waitUntil: 'domcontentloaded' } },
    ]);
    await expect(browser.page.title()).resolves.toBe('Just a moment...');
  });

  it('completes an account login flow and reaches the dashboard', async () => {
    const browser = new ScenarioAgentBrowser(
      new ScenarioAgentPage([
        {
          url: 'about:blank',
          title: 'Blank',
          tree: 'document',
          refs: {},
          text: '',
        },
        {
          url: 'https://app.example.test/login',
          title: 'Login',
          tree: 'document\n  textbox "Email" [ref=e1]\n  textbox "Password" [ref=e2]\n  button "Sign in" [ref=e3]',
          refs: {
            e1: { role: 'textbox', name: 'Email' },
            e2: { role: 'textbox', name: 'Password' },
            e3: { role: 'button', name: 'Sign in' },
          },
          text: 'Sign in to your account',
        },
        {
          url: 'https://app.example.test/dashboard',
          title: 'Dashboard',
          tree: 'document\n  heading "Dashboard"\n  text "Welcome back"',
          refs: {},
          text: 'Dashboard Welcome back Recent activity',
        },
      ])
    );
    let calls = 0;
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async () => {
          calls += 1;
          if (calls === 1) return { content: '{"action":"navigate","url":"https://app.example.test/login"}' };
          if (calls === 2) return { content: '{"action":"fill_ref","ref":"e1","text":"user@example.com"}' };
          if (calls === 3) return { content: '{"action":"fill_ref","ref":"e2","text":"correct horse battery staple"}' };
          if (calls === 4) return { content: '{"action":"click_ref","ref":"e3"}' };
          return { content: '{"action":"finish","message":"Reached the dashboard"}' };
        },
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => true,
      maxIterations: 8,
    });

    const result = await driver.execute('task-agent', {
      ...makeTask(),
      goal: 'Log in to the account and confirm the dashboard loads',
    });

    expect(result.finalStatus).toBe('completed');
    expect(result.finalMessage).toBe('Reached the dashboard');
    expect(browser.page.actions).toEqual([
      { type: 'goto', url: 'https://app.example.test/login', options: { waitUntil: 'domcontentloaded' } },
      { type: 'fillRef', ref: 'e1', text: 'user@example.com' },
      { type: 'fillRef', ref: 'e2', text: 'correct horse battery staple' },
      { type: 'clickRef', ref: 'e3' },
    ]);
    expect(browser.page.url()).toBe('https://app.example.test/dashboard');
  });

  it('forces handoff when the model incorrectly finishes on a Gmail login page', async () => {
    const browser = new ScenarioAgentBrowser(
      new ScenarioAgentPage([
        {
          url: 'https://accounts.google.com/',
          title: 'Sign in - Google Accounts',
          tree: 'document\n  textbox "Email or phone" [ref=e1]\n  button "Next" [ref=e2]',
          refs: {
            e1: { role: 'textbox', name: 'Email or phone' },
            e2: { role: 'button', name: 'Next' },
          },
          text: 'Sign in Use your Google Account Email or phone Forgot email?',
        },
      ])
    );
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async () => ({
          content: '{"action":"finish","message":"Navigated to Gmail login page."}',
        }),
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => false,
      maxIterations: 3,
    });

    const result = await driver.execute('task-agent', {
      ...makeTask(),
      goal: '打开 Gmail 并检查收件箱',
    });

    expect(result.finalStatus).toBe('handoff');
    expect(result.finalMessage).toContain('Login requires user credentials or account selection');
  });

  it('forces handoff on localized Google account login pages', async () => {
    const browser = new ScenarioAgentBrowser(
      new ScenarioAgentPage([
        {
          url: 'https://accounts.google.com/v3/signin/identifier',
          title: 'Gmail',
          tree: 'document\n  textbox "电子邮件或电话号码" [ref=e1]\n  button "下一步" [ref=e2]',
          refs: {
            e1: { role: 'textbox', name: '电子邮件或电话号码' },
            e2: { role: 'button', name: '下一步' },
          },
          text: '登录 使用您的 Google 账号 电子邮件或电话号码',
        },
      ])
    );
    const driver = new AgentLoopExecutionDriver({
      llmClient: {
        complete: async () => ({
          content: '{"action":"finish","message":"Successfully opened Gmail login page."}',
        }),
      },
      browserFactory: async () => browser,
      hasDisplayServer: () => false,
      maxIterations: 3,
    });

    const result = await driver.execute('task-agent', {
      ...makeTask(),
      goal: '打开 Gmail 并检查收件箱',
    });

    expect(result.finalStatus).toBe('handoff');
    expect(result.finalMessage).toContain('Login requires user credentials or account selection');
  });
});
