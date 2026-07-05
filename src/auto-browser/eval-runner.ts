import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LlmRouterClient } from './llm-router.js';

export interface EvalItem {
  id: number;
  prompt: string;
  expectedOutput: string;
}

export interface EvalRunResult {
  evalId: number;
  pass: boolean;
  summary: string;
  actualOutput: string;
  evidence: string;
}

interface CliConfigLike {
  routerBaseUrl: string;
  routerApiKey: string;
  plannerModel: string;
  modelTier: string;
}

export class EvalRunner {
  private readonly client: LlmRouterClient;
  private readonly config: CliConfigLike;

  constructor(config: CliConfigLike) {
    this.config = config;
    this.client = new LlmRouterClient({
      baseUrl: config.routerBaseUrl,
      apiKey: config.routerApiKey,
    });
  }

  async list(): Promise<EvalItem[]> {
    const evalsPath = fileURLToPath(new URL('../../skills/auto-browser/evals/evals.json', import.meta.url));
    if (!existsSync(evalsPath)) {
      return [];
    }
    const raw = JSON.parse(readFileSync(evalsPath, 'utf8')) as {
      evals?: Array<{ id: number; prompt: string; expected_output?: string; expectedOutput?: string }>;
    };
    return (raw.evals ?? []).map((e) => ({
      id: e.id,
      prompt: e.prompt,
      expectedOutput: e.expected_output ?? e.expectedOutput ?? '',
    }));
  }

  async run(evalId?: string): Promise<EvalRunResult[]> {
    const allEvals = await this.list();
    if (allEvals.length === 0) {
      return [];
    }

    const filtered = evalId
      ? allEvals.filter((e) => String(e.id) === evalId)
      : allEvals;

    if (filtered.length === 0) {
      return [];
    }

    const results: EvalRunResult[] = [];
    for (const ev of filtered) {
      const result = await this.runSingle(ev);
      results.push(result);
    }
    return results;
  }

  private async runSingle(ev: EvalItem): Promise<EvalRunResult> {
    const startTime = Date.now();
    try {
      const response = await this.client.complete({
        model: this.config.plannerModel || 'deepseek-v4-pro',
        messages: [
          {
            role: 'system',
            content: 'You are an expert browser automation assistant. Answer the user\'s question based on your knowledge.',
          },
          { role: 'user', content: ev.prompt },
        ],
        temperature: 0.3,
        modelTier: this.config.modelTier || undefined,
      });

      const actualOutput = response.content;
      const elapsed = Date.now() - startTime;

      const evalResult = await this.client.complete({
        model: this.config.plannerModel || 'deepseek-v4-pro',
        messages: [
          {
            role: 'system',
            content: `You are an eval judge. Determine if the assistant's response meets the expected output criteria.
Respond with ONLY "PASS" or "FAIL" followed by a brief reason on the next line.`,
          },
          {
            role: 'user',
            content: `Expected output criteria: ${ev.expectedOutput}

Assistant response:
${actualOutput}

Does the response meet the expected output criteria?`,
          },
        ],
        temperature: 0.1,
        modelTier: this.config.modelTier || undefined,
      });

      const judgeText = evalResult.content.trim();
      const pass = judgeText.startsWith('PASS');
      const evidence = judgeText.replace(/^PASS\s*/i, '').replace(/^FAIL\s*/i, '').trim();
      const summary = pass
        ? `Passed in ${elapsed}ms`
        : `Failed in ${elapsed}ms: ${evidence || 'Output did not meet expected criteria'}`;

      return {
        evalId: ev.id,
        pass,
        summary,
        actualOutput,
        evidence,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        evalId: ev.id,
        pass: false,
        summary: `Error: ${msg}`,
        actualOutput: '',
        evidence: msg,
      };
    }
  }
}
