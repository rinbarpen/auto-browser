import { describe, expect, it, vi } from 'vitest';
import { extractErrorContext } from './error-context.js';
import { LlmPlanner, LlmRouterClient } from './llm-router.js';

describe('LlmRouterClient', () => {
  it('lists model ids from the router catalog', async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'openai/gpt-5.4' },
            { id: 'gpt-5.3-codex', owned_by: 'vapi' },
            { id: 'gpt-5.3-codex', owned_by: 'aihubmix' },
            { id: 123 },
          ],
        }),
      };
    });
    const client = new LlmRouterClient({
      baseUrl: 'http://127.0.0.1:18000',
      fetch: fetchMock,
    });

    await expect(client.listModels()).resolves.toEqual([
      'openai/gpt-5.4',
      'gpt-5.3-codex',
      'vapi/gpt-5.3-codex',
      'aihubmix/gpt-5.3-codex',
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18000/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          'content-type': 'application/json',
        }),
      })
    );
  });

  it('posts OpenAI-compatible chat completions requests to llm-router', async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"summary":"Plan","steps":[{"title":"Open","intent":"Go"}]}' } }],
        }),
      };
    });
    const client = new LlmRouterClient({
      baseUrl: 'http://127.0.0.1:18000',
      apiKey: 'secret',
      fetch: fetchMock,
    });

    const response = await client.complete({
      model: 'openai/gpt-5.1',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.2,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18000/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          authorization: 'Bearer secret',
        }),
      })
    );
    expect(response.content).toContain('"summary":"Plan"');
  });

  it('raises a clearer error when the router rejects an unknown model', async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: false,
        status: 404,
        text: async () => '{"detail":"model not found"}',
      };
    });
    const client = new LlmRouterClient({
      baseUrl: 'http://127.0.0.1:18000',
      fetch: fetchMock,
    });

    await expect(
      client.complete({
        model: 'vapi/gpt-4.1',
        messages: [{ role: 'user', content: 'Hello' }],
      })
    ).rejects.toThrow('LLM Router could not find model "vapi/gpt-4.1"');
  });

  it('raises a clearer error when the router has no provider account for the model', async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: false,
        status: 503,
        text: async () => '{"detail":"no available provider account"}',
      };
    });
    const client = new LlmRouterClient({
      baseUrl: 'http://127.0.0.1:18000',
      fetch: fetchMock,
    });

    await expect(
      client.complete({
        model: 'vapi/gpt-5.3-codex',
        messages: [{ role: 'user', content: 'Hello' }],
      })
    ).rejects.toThrow(
      'LLM Router has no available provider account for model "vapi/gpt-5.3-codex". Configure that provider in the router or choose a model from a provider with an available account.'
    );
  });
});

describe('LlmPlanner', () => {
  it('fails clearly when planner model is missing', async () => {
    const planner = new LlmPlanner({
      complete: async () => ({ content: '' }),
    });

    await expect(
      planner.draft('Open the dashboard', {
        mode: 'system',
        browserFamily: 'chrome',
        executablePath: process.execPath,
        profilePath: '/tmp/profile',
        launchMode: 'auto',
        extensionEnabled: false,
        previewEnabled: true,
      }, '')
    ).rejects.toThrow('Planner model is required for this request.');
  });

  it('tags planner-model failures with llm-router context', async () => {
    const planner = new LlmPlanner({
      complete: async () => ({ content: '' }),
    });

    try {
      await planner.draft(
        'Open the dashboard',
        {
          mode: 'system',
          browserFamily: 'chrome',
          executablePath: process.execPath,
          profilePath: '/tmp/profile',
          launchMode: 'auto',
          extensionEnabled: false,
          previewEnabled: true,
          cdpUrl: '',
        },
        ''
      );
      throw new Error('Expected draft to fail');
    } catch (error) {
      expect(extractErrorContext(error)).toEqual({
        module: 'auto-browser.llm-router',
        file: 'src/auto-browser/llm-router.ts',
        location: 'LlmPlanner.requireModel',
        problem: 'Planner model is required for this request.',
      });
    }
  });

  it('parses a structured plan draft from llm-router output', async () => {
    const planner = new LlmPlanner({
      complete: async () => ({
        content:
          '```json\n{"summary":"Drafted browser task","steps":[{"title":"Open site","intent":"Navigate to the start page"},{"title":"Finish task","intent":"Complete the requested workflow"}]}\n```',
      }),
    });

    const draft = await planner.draft('Log in and check the inbox', {
      mode: 'system',
      browserFamily: 'chrome',
      executablePath: process.execPath,
      profilePath: '/tmp/profile',
      launchMode: 'auto',
      extensionEnabled: false,
      previewEnabled: true,
    }, 'openai/gpt-5.1');

    expect(draft.summary).toBe('Drafted browser task');
    expect(draft.steps).toHaveLength(2);
    expect(draft.steps[0]).toMatchObject({
      title: 'Open site',
      intent: 'Navigate to the start page',
    });
  });
});
