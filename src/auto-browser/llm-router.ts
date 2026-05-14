import type { BrowserRuntimeConfig } from './browser-registry.js';
import type { PlanDraft, Task } from './control-service.js';
import { wrapError } from './error-context.js';

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  modelTier?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatCompletionResult {
  content: string;
  model?: string;
  usage?: TokenUsage;
}

export interface LlmChatClient {
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
}

interface RouterModelListResponse {
  data?: Array<{
    id?: unknown;
    owned_by?: unknown;
  }>;
}

export interface LlmRouterClientOptions {
  baseUrl?: string;
  apiKey?: string;
  defaultTier?: string;
  fetch?: typeof fetch;
}

interface JsonPlanStep {
  title?: unknown;
  intent?: unknown;
}

interface JsonPlanDraft {
  summary?: unknown;
  steps?: JsonPlanStep[];
}

function llmRouterError(location: string, problem: string) {
  return wrapError(new Error(problem), {
    module: 'auto-browser.llm-router',
    file: 'src/auto-browser/llm-router.ts',
    location,
  });
}

export class LlmRouterClient implements LlmChatClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultTier: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LlmRouterClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:18000').replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? '';
    this.defaultTier = options.defaultTier ?? '';
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listModels(): Promise<string[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw llmRouterError(
        'LlmRouterClient.listModels',
        `LLM Router model catalog request failed with ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`
      );
    }

    const payload = (await response.json()) as RouterModelListResponse;
    if (!Array.isArray(payload.data)) {
      return [];
    }

    const modelIds: string[] = [];
    for (const item of payload.data) {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (!id) {
        continue;
      }
      modelIds.push(id);

      const owner = typeof item?.owned_by === 'string' ? item.owned_by.trim() : '';
      if (owner && !id.includes('/')) {
        modelIds.push(`${owner}/${id}`);
      }
    }

    return [...new Set(modelIds)];
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const tier = request.modelTier ?? this.defaultTier;
    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(tier),
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const detail = extractRouterErrorDetail(body);
      if (response.status === 404 && detail?.toLowerCase() === 'model not found') {
        throw llmRouterError('LlmRouterClient.complete', `LLM Router could not find model "${request.model}".`);
      }
      if (response.status === 503 && detail?.toLowerCase() === 'no available provider account') {
        throw llmRouterError(
          'LlmRouterClient.complete',
          `LLM Router has no available provider account for model "${request.model}". Configure that provider in the router or choose a model from a provider with an available account.`
        );
      }
      throw llmRouterError(
        'LlmRouterClient.complete',
        `LLM Router request failed with ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`
      );
    }

    const payload = (await response.json()) as {
      model?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      choices?: Array<{
        message?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
      }>;
    };
    const content = readMessageContent(payload.choices?.[0]?.message?.content);
    if (!content.trim()) {
      throw llmRouterError('LlmRouterClient.complete', 'LLM Router returned an empty completion.');
    }

    const result: ChatCompletionResult = { content };
    if (typeof payload.model === 'string' && payload.model.trim()) {
      result.model = payload.model.trim();
    }
    if (payload.usage && typeof payload.usage === 'object') {
      const promptTokens = typeof payload.usage.prompt_tokens === 'number' ? payload.usage.prompt_tokens : 0;
      const completionTokens = typeof payload.usage.completion_tokens === 'number' ? payload.usage.completion_tokens : 0;
      const totalTokens = typeof payload.usage.total_tokens === 'number' ? payload.usage.total_tokens : promptTokens + completionTokens;
      if (promptTokens > 0 || completionTokens > 0) {
        result.usage = { promptTokens, completionTokens, totalTokens };
      }
    }
    return result;
  }

  private buildHeaders(tier?: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...(tier ? { 'x-model-tier': tier } : {}),
    };
  }
}

export class LlmPlanner {
  constructor(private readonly client: LlmChatClient) {}

  async draft(goal: string, browserConfig: BrowserRuntimeConfig, model: string, modelTier?: string): Promise<PlanDraft> {
    const plannerModel = this.requireModel(model);
    const response = await this.client.complete({
      model: plannerModel,
      modelTier,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content:
            'You are a browser-task planner. Return JSON only with shape {"summary":"","steps":[{"title":"","intent":""}]}. Keep steps short, concrete, and safe.',
        },
        {
          role: 'user',
          content: JSON.stringify(
            {
              mode: 'draft',
              goal,
              browserConfig: {
                browserFamily: browserConfig.browserFamily,
                extensionEnabled: browserConfig.extensionEnabled,
                previewEnabled: browserConfig.previewEnabled,
              },
            },
            null,
            2
          ),
        },
      ],
    });

    return parsePlanDraft(response.content, `Drafted browser task for: ${goal}`);
  }

  async replanRemaining(taskId: string, task: Task, model: string, modelTier?: string): Promise<PlanDraft> {
    const plannerModel = this.requireModel(model);
    const response = await this.client.complete({
      model: plannerModel,
      modelTier,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content:
            'You are a browser-task planner. Return JSON only with shape {"summary":"","steps":[{"title":"","intent":""}]}. Replan from the current state and keep steps minimal.',
        },
        {
          role: 'user',
          content: JSON.stringify(
            {
              mode: 'replan',
              taskId,
              goal: task.goal,
              currentStatus: task.status,
              currentPlan: task.planDraft,
              handoffSource: task.handoffSource,
            },
            null,
            2
          ),
        },
      ],
    });

    return parsePlanDraft(response.content, `Replanned remaining work for ${taskId}`);
  }

  private requireModel(model: string): string {
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      throw llmRouterError('LlmPlanner.requireModel', 'Planner model is required for this request.');
    }
    return normalizedModel;
  }
}

function readMessageContent(
  content: string | Array<{ type?: string; text?: string }> | undefined
): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item) => {
      if (typeof item?.text === 'string') {
        return item.text;
      }
      return '';
    })
    .join('\n');
}

function extractRouterErrorDetail(body: string): string | null {
  if (!body.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(body) as { detail?: unknown; error?: { message?: unknown } };
    if (typeof parsed.detail === 'string' && parsed.detail.trim()) {
      return parsed.detail.trim();
    }
    if (typeof parsed.error?.message === 'string' && parsed.error.message.trim()) {
      return parsed.error.message.trim();
    }
  } catch {
    return null;
  }

  return null;
}

function parsePlanDraft(text: string, fallbackSummary: string): PlanDraft {
  const normalized = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const match = normalized.match(/\{[\s\S]*\}/);
  const parsedText = match?.[0] ?? normalized;
  const parsed = JSON.parse(parsedText) as JsonPlanDraft;
  const steps = Array.isArray(parsed.steps)
    ? parsed.steps
        .map((step, index) => {
          const title = typeof step?.title === 'string' ? step.title.trim() : '';
          const intent = typeof step?.intent === 'string' ? step.intent.trim() : '';
          if (!title || !intent) {
            return null;
          }
          return {
            id: `plan-${index + 1}`,
            title,
            intent,
          };
        })
        .filter((step): step is PlanDraft['steps'][number] => Boolean(step))
    : [];

  if (steps.length === 0) {
    throw llmRouterError('parsePlanDraft', 'Planner response did not contain any valid plan steps.');
  }

  return {
    summary:
      typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : fallbackSummary,
    steps,
  };
}
