import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLI_EXIT_CODES,
  CliError,
  ensureServiceAvailable,
  formatSubmitResult,
  getCompletionScript,
  isExecutedAsMain,
  parseCliArgs,
  requestJson,
  resolveBrowserConfig,
  resolveCliConfig,
  toCliError,
  validateCommandConfig,
} from './cli.js';
import { extractErrorContext } from './error-context.js';

const root = resolve(import.meta.dirname, '../..');

describe('auto-browser CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('publishes an auto-browser bin from the root package', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
    };

    expect(pkg.bin?.['auto-browser']).toBe('./dist/auto-browser/cli.js');
  });

  it('uses explicit CLI flags before env defaults', () => {
    const config = resolveCliConfig(
      {
        options: {
          plannerModel: 'openai/gpt-5.4',
          executorModel: 'openai/gpt-5.4',
          routerBaseUrl: 'http://127.0.0.1:18000',
          routerApiKey: 'cli-key',
        },
      },
      {
        AUTO_BROWSER_PLANNER_MODEL: 'env-planner',
        AUTO_BROWSER_EXECUTOR_MODEL: 'env-executor',
        AUTO_BROWSER_LLM_ROUTER_BASE_URL: 'http://127.0.0.1:9999',
        AUTO_BROWSER_LLM_ROUTER_API_KEY: 'env-key',
      }
    );

    expect(config.plannerModel).toBe('openai/gpt-5.4');
    expect(config.executorModel).toBe('openai/gpt-5.4');
    expect(config.routerBaseUrl).toBe('http://127.0.0.1:18000');
    expect(config.routerApiKey).toBe('cli-key');
  });

  it('parses headless and headed flags as first-class boolean switches', () => {
    expect(parseCliArgs(['run', '--headless', 'open example.com']).options.headless).toBe(true);
    expect(parseCliArgs(['run', '--headed', 'open example.com']).options.headed).toBe(true);
  });

  it('resolves launchMode to auto by default', async () => {
    const browserConfig = await resolveBrowserConfig(
      {
        controlPort: 4317,
        plannerModel: '',
        executorModel: '',
        routerBaseUrl: 'http://127.0.0.1:18000',
        routerApiKey: '',
      },
      {},
      async () => ({
        mode: 'managed',
        browserFamily: 'chromium',
        executablePath: '',
        profilePath: '',
      })
    );

    expect(browserConfig.mode).toBe('managed');
    expect(browserConfig.profilePath).toBe('');
    expect(browserConfig.launchMode).toBe('auto');
  });

  it('resolves launchMode to headless when --headless is passed', async () => {
    const browserConfig = await resolveBrowserConfig(
      {
        controlPort: 4317,
        plannerModel: '',
        executorModel: '',
        routerBaseUrl: 'http://127.0.0.1:18000',
        routerApiKey: '',
      },
      { headless: true },
      async () => ({
        mode: 'managed',
        browserFamily: 'chromium',
        executablePath: '',
        profilePath: '',
      })
    );

    expect(browserConfig.mode).toBe('managed');
    expect(browserConfig.profilePath).toBe('');
    expect(browserConfig.launchMode).toBe('headless');
  });

  it('resolves launchMode to headed when --headed is passed', async () => {
    const browserConfig = await resolveBrowserConfig(
      {
        controlPort: 4317,
        plannerModel: '',
        executorModel: '',
        routerBaseUrl: 'http://127.0.0.1:18000',
        routerApiKey: '',
      },
      { headed: true },
      async () => ({
        mode: 'managed',
        browserFamily: 'chromium',
        executablePath: '',
        profilePath: '',
      })
    );

    expect(browserConfig.mode).toBe('managed');
    expect(browserConfig.profilePath).toBe('');
    expect(browserConfig.launchMode).toBe('headed');
  });

  it('preserves managed mode from runtime defaults when no explicit executable path is provided', async () => {
    const browserConfig = await resolveBrowserConfig(
      {
        controlPort: 4317,
        plannerModel: '',
        executorModel: '',
        routerBaseUrl: 'http://127.0.0.1:18000',
        routerApiKey: '',
      },
      {},
      async () => ({
        mode: 'managed',
        browserFamily: 'chromium',
        executablePath: '',
        profilePath: '',
      })
    );

    expect(browserConfig).toMatchObject({
      mode: 'managed',
      browserFamily: 'chromium',
      executablePath: '',
    });
  });

  it('forces system mode when an explicit executable path is provided', async () => {
    const browserConfig = await resolveBrowserConfig(
      {
        controlPort: 4317,
        plannerModel: '',
        executorModel: '',
        routerBaseUrl: 'http://127.0.0.1:18000',
        routerApiKey: '',
      },
      { executablePath: '/custom/chrome' },
      async () => ({
        mode: 'managed',
        browserFamily: 'chromium',
        executablePath: '',
        profilePath: '',
      })
    );

    expect(browserConfig).toMatchObject({
      mode: 'system',
      executablePath: '/custom/chrome',
    });
  });

  it('rejects conflicting --headless and --headed flags', async () => {
    await expect(
      resolveBrowserConfig(
        {
          controlPort: 4317,
          plannerModel: '',
          executorModel: '',
          routerBaseUrl: 'http://127.0.0.1:18000',
          routerApiKey: '',
        },
        { headless: true, headed: true },
        async () => ({
          mode: 'managed',
          browserFamily: 'chromium',
          executablePath: '',
          profilePath: '',
        })
      )
    ).rejects.toThrowError(
      expect.objectContaining({
        message: expect.stringContaining('problem: Cannot use --headless and --headed together'),
        exitCode: CLI_EXIT_CODES.config,
      })
    );
  });

  it('preserves an explicit profile path when provided', async () => {
    const browserConfig = await resolveBrowserConfig(
      {
        controlPort: 4317,
        plannerModel: '',
        executorModel: '',
        routerBaseUrl: 'http://127.0.0.1:18000',
        routerApiKey: '',
      },
      { profilePath: '/tmp/auto-browser-profile' },
      async () => ({
        mode: 'managed',
        browserFamily: 'chromium',
        executablePath: '',
        profilePath: '',
      })
    );

    expect(browserConfig.profilePath).toBe('/tmp/auto-browser-profile');
  });

  it('fails clearly when submit is missing a planner model', () => {
    expect(() =>
      validateCommandConfig('submit', {
        controlPort: 4317,
        plannerModel: '',
        executorModel: '',
        routerBaseUrl: 'http://127.0.0.1:18000',
        routerApiKey: '',
      })
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining('problem: Planner model is required'),
        exitCode: CLI_EXIT_CODES.config,
      })
    );
  });

  it('reuses an already-running control service when healthy', async () => {
    const spawnService = vi.fn();
    const waitForReady = vi.fn();

    await ensureServiceAvailable({
      config: {
        controlPort: 4317,
        plannerModel: '',
        executorModel: '',
        routerBaseUrl: 'http://127.0.0.1:18000',
        routerApiKey: '',
      },
      isHealthy: vi.fn().mockResolvedValue(true),
      getRuntimeConfig: vi.fn().mockResolvedValue({
        plannerConfigured: true,
        executorConfigured: true,
      }),
      spawnService,
      waitForReady,
    });

    expect(spawnService).not.toHaveBeenCalled();
    expect(waitForReady).not.toHaveBeenCalled();
  });

  it('allows request-level models when an already-running service has no model defaults', async () => {
    const spawnService = vi.fn();
    const waitForReady = vi.fn();

    await ensureServiceAvailable({
      command: 'run',
      config: {
        controlPort: 4317,
        plannerModel: 'openai/gpt-5.4',
        executorModel: 'openai/gpt-5.4',
        routerBaseUrl: 'http://127.0.0.1:18000',
        routerApiKey: '',
      },
      isHealthy: vi.fn().mockResolvedValue(true),
      getRuntimeConfig: vi.fn().mockResolvedValue({
        plannerConfigured: false,
        executorConfigured: false,
      }),
      validateModels: vi.fn().mockResolvedValue(undefined),
      spawnService,
      waitForReady,
    });

    expect(spawnService).not.toHaveBeenCalled();
    expect(waitForReady).not.toHaveBeenCalled();
  });

  it('allows request-level models to differ from service environment defaults', async () => {
    const spawnService = vi.fn();
    const waitForReady = vi.fn();

    await ensureServiceAvailable({
      command: 'run',
      config: {
        controlPort: 4317,
        plannerModel: 'gpt-5.3-codex',
        executorModel: 'gpt-4.1-mini',
        routerBaseUrl: 'http://127.0.0.1:18000',
        routerApiKey: '',
      },
      isHealthy: vi.fn().mockResolvedValue(true),
      getRuntimeConfig: vi.fn().mockResolvedValue({
        plannerConfigured: true,
        executorConfigured: true,
        plannerModel: 'gpt-3.5-turbo-0125',
        executorModel: 'gpt-4.1-mini',
      }),
      validateModels: vi.fn().mockResolvedValue(undefined),
      spawnService,
      waitForReady,
    });

    expect(spawnService).not.toHaveBeenCalled();
    expect(waitForReady).not.toHaveBeenCalled();
  });

  it('fails clearly when the planner model is not available in the live router catalog', async () => {
    await expect(
      ensureServiceAvailable({
        command: 'run',
        config: {
          controlPort: 4317,
          plannerModel: 'vapi/gpt-4.1',
          executorModel: 'openai/gpt-5.4',
          routerBaseUrl: 'http://127.0.0.1:18000',
          routerApiKey: '',
        },
        isHealthy: vi.fn().mockResolvedValue(true),
        getRuntimeConfig: vi.fn().mockResolvedValue({
          plannerConfigured: true,
          executorConfigured: true,
        }),
        validateModels: vi.fn().mockRejectedValue(
          new CliError(
            'Planner model "vapi/gpt-4.1" is not available in the configured LLM router. Try one of: openai/gpt-4.1, openai/gpt-5.4',
            CLI_EXIT_CODES.config
          )
        ),
      })
    ).rejects.toThrowError(
      expect.objectContaining({
        message: expect.stringContaining('Planner model "vapi/gpt-4.1" is not available'),
        exitCode: CLI_EXIT_CODES.config,
      })
    );
  });

  it('continues when the router model catalog cannot be loaded', async () => {
    const spawnService = vi.fn();
    const waitForReady = vi.fn();

    await ensureServiceAvailable({
      command: 'run',
      config: {
        controlPort: 4317,
        plannerModel: 'openai/gpt-5.4',
        executorModel: 'openai/gpt-5.4',
        routerBaseUrl: 'http://127.0.0.1:18000',
        routerApiKey: '',
      },
      isHealthy: vi.fn().mockResolvedValue(true),
      getRuntimeConfig: vi.fn().mockResolvedValue({
        plannerConfigured: true,
        executorConfigured: true,
      }),
      validateModels: vi.fn().mockResolvedValue(undefined),
      spawnService,
      waitForReady,
    });

    expect(spawnService).not.toHaveBeenCalled();
    expect(waitForReady).not.toHaveBeenCalled();
  });

  it('accepts provider-prefixed aliases when the router catalog exposes the bare model id', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: 'gpt-4.1' }, { id: 'gpt-4.1-mini' }],
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await ensureServiceAvailable({
      command: 'run',
      config: {
        controlPort: 4317,
        plannerModel: 'vapi/gpt-4.1',
        executorModel: 'vapi/gpt-4.1-mini',
        routerBaseUrl: 'http://127.0.0.1:18000',
        routerApiKey: '',
      },
      isHealthy: vi.fn().mockResolvedValue(true),
      getRuntimeConfig: vi.fn().mockResolvedValue({
        plannerConfigured: true,
        executorConfigured: true,
      }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18000/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          'content-type': 'application/json',
        }),
      })
    );
  });

  it('rewrites accepted aliases to the router catalog ids before later execution', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: 'gpt-3.5-turbo-0125' }, { id: 'gpt-4.1-mini' }],
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const config = {
      controlPort: 4317,
      plannerModel: 'vapi/gpt-3.5-turbo-0125',
      executorModel: 'vapi/gpt-4.1-mini',
      routerBaseUrl: 'http://127.0.0.1:18000',
      routerApiKey: '',
    };

    await ensureServiceAvailable({
      command: 'run',
      config,
      isHealthy: vi.fn().mockResolvedValue(true),
      getRuntimeConfig: vi.fn().mockResolvedValue({
        plannerConfigured: true,
        executorConfigured: true,
      }),
    });

    expect(config.plannerModel).toBe('gpt-3.5-turbo-0125');
    expect(config.executorModel).toBe('gpt-4.1-mini');
  });

  it('prefers exact provider-prefixed catalog ids over earlier bare suffix matches', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: 'gpt-5.3-codex' }, { id: 'aihubmix/gpt-5.3-codex' }],
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const config = {
      controlPort: 4317,
      plannerModel: 'aihubmix/gpt-5.3-codex',
      executorModel: '',
      routerBaseUrl: 'http://127.0.0.1:18000',
      routerApiKey: '',
    };

    await ensureServiceAvailable({
      command: 'submit',
      config,
      isHealthy: vi.fn().mockResolvedValue(true),
      getRuntimeConfig: vi.fn().mockResolvedValue({
        plannerConfigured: true,
        executorConfigured: true,
      }),
    });

    expect(config.plannerModel).toBe('aihubmix/gpt-5.3-codex');
  });

  it('rewrites accepted aliases before auto-starting the control service', async () => {
    const calls: string[] = [];
    const config = {
      controlPort: 4317,
      plannerModel: 'vapi/gpt-3.5-turbo-0125',
      executorModel: 'vapi/gpt-4.1-mini',
      routerBaseUrl: 'http://127.0.0.1:18000',
      routerApiKey: '',
    };

    await ensureServiceAvailable({
      command: 'run',
      config,
      isHealthy: vi.fn().mockResolvedValue(false),
      getRuntimeConfig: vi.fn().mockResolvedValue({
        plannerConfigured: true,
        executorConfigured: true,
        plannerModel: 'gpt-3.5-turbo-0125',
        executorModel: 'gpt-4.1-mini',
      }),
      validateModels: vi.fn().mockImplementation(async () => {
        calls.push('validate');
        config.plannerModel = 'gpt-3.5-turbo-0125';
        config.executorModel = 'gpt-4.1-mini';
      }),
      spawnService: vi.fn().mockImplementation((spawnConfig) => {
        calls.push(`spawn:${spawnConfig.plannerModel}:${spawnConfig.executorModel}`);
      }),
      waitForReady: vi.fn().mockResolvedValue(undefined),
    });

    expect(calls).toEqual(['validate', 'spawn:gpt-3.5-turbo-0125:gpt-4.1-mini']);
  });

  it('auto-starts the control service when it is unavailable', async () => {
    const spawnService = vi.fn();
    const waitForReady = vi.fn().mockResolvedValue(undefined);

    await ensureServiceAvailable({
      command: 'run',
      config: {
        controlPort: 4317,
        plannerModel: 'openai/gpt-5.4',
        executorModel: 'openai/gpt-5.4',
        routerBaseUrl: 'http://127.0.0.1:18000',
        routerApiKey: 'secret',
      },
      isHealthy: vi.fn().mockResolvedValue(false),
      getRuntimeConfig: vi
        .fn()
        .mockResolvedValueOnce({ plannerConfigured: true, executorConfigured: true }),
      spawnService,
      waitForReady,
    });

    expect(spawnService).toHaveBeenCalledOnce();
    expect(waitForReady).toHaveBeenCalledOnce();
  });

  it('formats submit results as human-readable text by default', () => {
    const text = formatSubmitResult({
      id: 'task-123',
      conversationId: 'conv-456',
      status: 'draft',
      planDraft: {
        summary: 'Drafted browser task',
        steps: [
          { id: 'step-1', title: 'Open page', intent: 'Navigate to the target site' },
          { id: 'step-2', title: 'Collect answer', intent: 'Return the requested result' },
        ],
      },
    });

    expect(text).toContain('Conversation: conv-456');
    expect(text).toContain('Task: task-123');
    expect(text).toContain('Status: draft');
    expect(text).toContain('Summary: Drafted browser task');
    expect(text).toContain('1. Open page');
    expect(text).toContain('2. Collect answer');
  });

  it('accepts run as a first-class command alias', () => {
    const parsed = parseCliArgs(['run', 'open example.com']);

    expect(parsed.command).toBe('run');
    expect(parsed.positionals).toEqual(['open example.com']);
  });

  it('prints help text when --help is requested', () => {
    expect(() => parseCliArgs(['--help'])).toThrow(/auto-browser <command>/);
    expect(() => parseCliArgs(['help'])).toThrow(/auto-browser <command>/);
    expect(() => parseCliArgs(['run', '--help'])).toThrow(/auto-browser <command>/);
  });

  it('accepts completion as a first-class command', () => {
    const parsed = parseCliArgs(['completion', 'zsh']);

    expect(parsed.command).toBe('completion');
    expect(parsed.positionals).toEqual(['zsh']);
  });

  it('requires both planner and executor models for run', () => {
    expect(() =>
      validateCommandConfig('run', {
        controlPort: 4317,
        plannerModel: 'openai/gpt-5.4',
        executorModel: '',
        routerBaseUrl: 'http://127.0.0.1:18000',
        routerApiKey: '',
      })
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining('Executor model is required'),
        exitCode: CLI_EXIT_CODES.config,
      })
    );
  });

  it('renders a bash completion script', () => {
    const script = getCompletionScript('bash');

    expect(script).toContain('complete -F _auto_browser auto-browser');
    expect(script).toContain('COMPREPLY');
    expect(script).toContain('submit');
    expect(script).toContain('completion');
  });

  it('renders a zsh completion script', () => {
    const script = getCompletionScript('zsh');

    expect(script).toContain('#compdef auto-browser');
    expect(script).toContain('commands');
    expect(script).toContain('run');
    expect(script).toContain('completion');
  });

  it('rejects unsupported completion shells with a usage error code', () => {
    expect(() => getCompletionScript('fish')).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining('Unsupported shell'),
        exitCode: CLI_EXIT_CODES.usage,
      })
    );
  });

  it('maps known CLI errors to stable exit codes', () => {
    const configError = toCliError(new Error('Planner model is required. Pass --planner-model <id>.'));
    const serviceError = toCliError(new Error('Timed out waiting for control service on http://127.0.0.1:4317/api'));
    const requestError = toCliError(new Error('Request failed: 500'));
    const unknownModelError = toCliError(new Error('LLM Router could not find model "vapi/gpt-4.1".'));
    const unavailableProviderError = toCliError(
      new Error('LLM Router has no available provider account for model "vapi/gpt-5.3-codex".')
    );

    expect(configError.exitCode).toBe(CLI_EXIT_CODES.config);
    expect(serviceError.exitCode).toBe(CLI_EXIT_CODES.service);
    expect(requestError.exitCode).toBe(CLI_EXIT_CODES.request);
    expect(unknownModelError.exitCode).toBe(CLI_EXIT_CODES.config);
    expect(unavailableProviderError.exitCode).toBe(CLI_EXIT_CODES.config);
    expect(configError.message).toContain('Planner model is required');
  });

  it('preserves explicit CliError exit codes', () => {
    const error = new CliError('custom failure', CLI_EXIT_CODES.internal);

    expect(toCliError(error)).toBe(error);
  });

  it('prints structured CLI errors when a command-level config check fails', () => {
    try {
      validateCommandConfig('submit', {
        controlPort: 4317,
        plannerModel: '',
        executorModel: '',
        routerBaseUrl: 'http://127.0.0.1:18000',
        routerApiKey: '',
      });
      throw new Error('Expected validateCommandConfig to fail');
    } catch (error) {
      const cliError = toCliError(error);
      expect(cliError.message).toContain('module: auto-browser.cli');
      expect(cliError.message).toContain('file: src/auto-browser/cli.ts');
      expect(cliError.message).toContain('location: command:submit');
      expect(cliError.message).toContain('problem: Planner model is required.');
    }
  });

  it('reuses structured API errors instead of collapsing them to a bare string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({
          error: {
            module: 'auto-browser.server',
            file: 'src/auto-browser/server.ts',
            location: 'route:/api/tasks/:id/approve',
            problem: 'Executor model is required for this request.',
          },
        }),
      }))
    );

    await expect(
      requestJson('http://127.0.0.1:4317/api/tasks/task-1/approve', { method: 'POST' })
    ).rejects.toMatchObject({
      exitCode: CLI_EXIT_CODES.request,
      context: {
        module: 'auto-browser.server',
        file: 'src/auto-browser/server.ts',
        location: 'route:/api/tasks/:id/approve',
        problem: 'Executor model is required for this request.',
      },
    });
  });

  it('wraps legacy API string errors with CLI command context', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({
          error: 'Request failed: 503',
        }),
      }))
    );

    await expect(
      requestJson('http://127.0.0.1:4317/api/state', undefined, {
        module: 'auto-browser.cli',
        file: 'src/auto-browser/cli.ts',
        location: 'command:state',
        problem: '',
      })
    ).rejects.toSatisfy((error: unknown) => {
      const context = extractErrorContext(error);
      return (
        error instanceof CliError &&
        context?.module === 'auto-browser.cli' &&
        context.file === 'src/auto-browser/cli.ts' &&
        context.location === 'command:state' &&
        context.problem === 'Request failed: 503'
      );
    });
  });

  it('treats symlinked bin paths as the main module entrypoint', () => {
    expect(
      isExecutedAsMain(
        'file:///home/rczx/workspace/rinbarpen/projects/auto-browser/dist/auto-browser/cli.js',
        '/home/rczx/.local/share/nvm/v25.3.0/bin/auto-browser'
      )
    ).toBe(true);
  });

  it('prints version when --version is passed', () => {
    expect(() => parseCliArgs(['--version'])).toThrow(/auto-browser v/);
  });

  it('accepts version as a command', () => {
    const parsed = parseCliArgs(['version']);
    expect(parsed.command).toBe('version');
  });

  it('prints version when --version is passed after a command token', () => {
    expect(() => parseCliArgs(['skill', '--version'])).toThrow(/auto-browser v/);
  });

  it('prints version for --version flag with a non-version command', () => {
    expect(() => parseCliArgs(['state', '--version'])).toThrow(/auto-browser v/);
  });

  it('accepts version and returns success exit code', () => {
    try {
      parseCliArgs(['--version']);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(CLI_EXIT_CODES.success);
    }
  });

  it('includes version in the bash completion script', () => {
    const script = getCompletionScript('bash');
    expect(script).toContain('version');
    expect(script).toContain('skill');
    expect(script).toContain('eval');
  });

  it('includes version in the zsh completion script', () => {
    const script = getCompletionScript('zsh');
    expect(script).toContain('version');
    expect(script).toContain('skill');
    expect(script).toContain('eval');
  });

  it('parses skill as a valid command', () => {
    const parsed = parseCliArgs(['skill', 'list']);
    expect(parsed.command).toBe('skill');
    expect(parsed.positionals).toEqual(['list']);
  });

  it('parses eval as a valid command', () => {
    const parsed = parseCliArgs(['eval', 'list']);
    expect(parsed.command).toBe('eval');
    expect(parsed.positionals).toEqual(['list']);
  });

  it('parses eval run with --eval-id', () => {
    const parsed = parseCliArgs(['eval', 'run', '--eval-id', '1']);
    expect(parsed.command).toBe('eval');
    expect(parsed.options.evalId).toBe('1');
  });

  it('parses skill with any positional as valid command', () => {
    const parsed = parseCliArgs(['skill', 'unknown']);
    expect(parsed.command).toBe('skill');
    expect(parsed.positionals).toEqual(['unknown']);
  });

  it('parses eval with any positional as valid command', () => {
    const parsed = parseCliArgs(['eval', 'unknown']);
    expect(parsed.command).toBe('eval');
    expect(parsed.positionals).toEqual(['unknown']);
  });
});
