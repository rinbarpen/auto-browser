#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  AgentLoopExecutionDriver,
  DemoExecutionDriver,
  DemoPlanner,
  InMemoryControlService,
  LlmExecutorDecider,
} from './control-service.js';
import { LlmPlanner, LlmRouterClient } from './llm-router.js';
import { isExecutedAsMain } from './cli.js';
import { loadStorageState, matchesDomain, normalizeCookies } from './cookie-manager.js';
import type { Cookie } from './cookie-manager.js';

export function createControlService(): InMemoryControlService {
  if (process.env.NODE_ENV === 'test') {
    return new InMemoryControlService({
      planner: new DemoPlanner(),
      executionDriver: new DemoExecutionDriver(),
      executorDecider: {
        async decide() {
          return { action: 'finish' as const, message: 'Done', label: 'Finish task' };
        },
      },
    });
  }

  const llmClient = new LlmRouterClient({
    baseUrl: process.env.AUTO_BROWSER_LLM_ROUTER_BASE_URL ?? 'http://127.0.0.1:18000',
    apiKey: process.env.AUTO_BROWSER_LLM_ROUTER_API_KEY ?? '',
  });

  return new InMemoryControlService({
    planner: new LlmPlanner(llmClient),
    executionDriver: new AgentLoopExecutionDriver({ llmClient }),
    executorDecider: new LlmExecutorDecider(llmClient),
  });
}

function formatError(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function registerAllTools(server: McpServer, service: InMemoryControlService): void {
  server.registerTool(
    'auto-browser_submit_goal',
    {
      description: 'Submit a browser automation goal and draft a plan. Returns the task ID and plan steps.',
      inputSchema: z.object({
        goal: z.string().describe('The natural language goal to accomplish in the browser'),
        context: z.string().optional().describe('Optional context to help the planner understand the task'),
        plannerModel: z.string().optional().describe('Override the default planner model ID'),
        modelTier: z.string().optional().describe('Model tier: standard, premium, or economy'),
      }),
    },
    async (args) => {
      try {
        const conversation = service.createConversation();
        const task = await service.submitUserMessage(conversation.id, args.goal, {
          browserConfig: {
            mode: 'managed',
            browserFamily: 'chromium',
            executablePath: '',
            profilePath: '',
            cookiesPath: '',
            credentialsPath: '',
            launchMode: 'auto',
            extensionEnabled: false,
            previewEnabled: false,
            cdpUrl: '',
            cloakHumanize: false,
            cloakFingerprintSeed: '',
            cloakTimezone: '',
            cloakLocale: '',
          },
          plannerModel: args.plannerModel ?? process.env.AUTO_BROWSER_PLANNER_MODEL ?? '',
          modelTier: args.modelTier ?? process.env.AUTO_BROWSER_MODEL_TIER ?? '',
          context: args.context ?? '',
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  taskId: task.id,
                  conversationId: task.conversationId,
                  status: task.status,
                  planSummary: task.planDraft.summary,
                  steps: task.planDraft.steps.map((s) => ({
                    id: s.id,
                    title: s.title,
                    intent: s.intent,
                  })),
                },
                null,
                2,
              ),
            },
          ],
        } satisfies CallToolResult;
      } catch (error) {
        return formatError(error);
      }
    },
  );

  server.registerTool(
    'auto-browser_approve_and_run',
    {
      description:
        'Approve a drafted task plan and execute it. Blocks until the task completes, hands off, or fails.',
      inputSchema: z.object({
        taskId: z.string().describe('The task ID returned from submit_goal'),
        executorModel: z.string().optional().describe('Override the default executor model ID'),
        modelTier: z.string().optional().describe('Model tier: standard, premium, or economy'),
        timeoutMs: z
          .number()
          .optional()
          .describe('Execution timeout in milliseconds (default: 120000)'),
      }),
    },
    async (args) => {
      try {
        const timeoutMs =
          args.timeoutMs ?? Number(process.env.AUTO_BROWSER_EXECUTION_TIMEOUT_MS ?? '120000');
        const abortController = new AbortController();
        const timeout = setTimeout(() => abortController.abort(), timeoutMs);
        try {
          const task = await service.approveTask(args.taskId, {
            executorModel: args.executorModel ?? process.env.AUTO_BROWSER_EXECUTOR_MODEL ?? '',
            modelTier: args.modelTier ?? process.env.AUTO_BROWSER_MODEL_TIER ?? '',
            signal: abortController.signal,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    taskId: task.id,
                    status: task.status,
                    resultSummary: task.resultSummary,
                    currentStepIndex: task.currentStepIndex,
                    planSummary: task.planDraft.summary,
                    steps: task.planDraft.steps.map((s) => ({ id: s.id, title: s.title })),
                  },
                  null,
                  2,
                ),
              },
            ],
          } satisfies CallToolResult;
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        return formatError(error);
      }
    },
  );

  server.registerTool(
    'auto-browser_get_task',
    {
      description: 'Get the current status and details of a task.',
      inputSchema: z.object({
        taskId: z.string().describe('The task ID'),
      }),
    },
    async (args) => {
      try {
        const task = service.getTask(args.taskId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  id: task.id,
                  conversationId: task.conversationId,
                  goal: task.goal,
                  status: task.status,
                  resultSummary: task.resultSummary,
                  currentStepIndex: task.currentStepIndex,
                  planSummary: task.planDraft.summary,
                  steps: task.planDraft.steps,
                  createdAt: task.createdAt,
                  updatedAt: task.updatedAt,
                },
                null,
                2,
              ),
            },
          ],
        } satisfies CallToolResult;
      } catch (error) {
        return formatError(error);
      }
    },
  );

  server.registerTool(
    'auto-browser_list_tasks',
    {
      description: 'List all tasks across all conversations.',
    },
    async () => {
      try {
        const tasks = service.getTasks();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                tasks.map((t) => ({
                  id: t.id,
                  conversationId: t.conversationId,
                  status: t.status,
                  goal: t.goal,
                  resultSummary: t.resultSummary,
                  createdAt: t.createdAt,
                })),
                null,
                2,
              ),
            },
          ],
        } satisfies CallToolResult;
      } catch (error) {
        return formatError(error);
      }
    },
  );

  server.registerTool(
    'auto-browser_cancel_task',
    {
      description: 'Cancel a running or pending task.',
      inputSchema: z.object({
        taskId: z.string().describe('The task ID to cancel'),
      }),
    },
    async (args) => {
      try {
        const task = await service.cancelTask(args.taskId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ taskId: task.id, status: task.status }, null, 2),
            },
          ],
        } satisfies CallToolResult;
      } catch (error) {
        return formatError(error);
      }
    },
  );

  server.registerTool(
    'auto-browser_resume_task',
    {
      description:
        'Replan and resume a task that was handed off for human intervention.',
      inputSchema: z.object({
        taskId: z.string().describe('The task ID to resume'),
        plannerModel: z.string().optional().describe('Override the default planner model ID'),
        modelTier: z.string().optional().describe('Model tier: standard, premium, or economy'),
      }),
    },
    async (args) => {
      try {
        const task = await service.resumeTask(args.taskId, {
          plannerModel: args.plannerModel ?? process.env.AUTO_BROWSER_PLANNER_MODEL ?? '',
          modelTier: args.modelTier ?? process.env.AUTO_BROWSER_MODEL_TIER ?? '',
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  taskId: task.id,
                  status: task.status,
                  planSummary: task.planDraft.summary,
                  steps: task.planDraft.steps.map((s) => ({
                    id: s.id,
                    title: s.title,
                    intent: s.intent,
                  })),
                },
                null,
                2,
              ),
            },
          ],
        } satisfies CallToolResult;
      } catch (error) {
        return formatError(error);
      }
    },
  );

  server.registerTool(
    'auto-browser_get_state',
    {
      description:
        'Get a full snapshot of the service state including all conversations, tasks, and recent events.',
    },
    async () => {
      try {
        const state = {
          conversations: service.getConversations(),
          tasks: service.getTasks(),
          activeTask: service.getActiveTask(),
          events: service.getEventsSince(0),
        };
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(state, null, 2),
            },
          ],
        } satisfies CallToolResult;
      } catch (error) {
        return formatError(error);
      }
    },
  );

  server.registerTool(
    'auto-browser_get_cookies',
    {
      description: 'Read cookies from a cookie file. Returns all cookies grouped by domain.',
      inputSchema: z.object({
        cookiesPath: z.string().describe('Path to the cookie file (storage state JSON)'),
        domain: z.string().optional().describe('Optional domain filter (e.g., "example.com")'),
      }),
    },
    async (args) => {
      try {
        const state = loadStorageState(args.cookiesPath);
        let cookies = state.cookies;
        if (args.domain) {
          const filterDomain = args.domain.startsWith('.') ? args.domain : `.${args.domain}`;
          cookies = cookies.filter(
            (c) =>
              c.domain === args.domain ||
              c.domain === filterDomain ||
              c.domain.endsWith(filterDomain),
          );
        }
        const now = Date.now() / 1000;
        const groups = new Map<string, Cookie[]>();
        for (const c of cookies) {
          const domain = c.domain || '(no domain)';
          if (!groups.has(domain)) groups.set(domain, []);
          groups.get(domain)!.push(c);
        }
        const result: Array<{
          domain: string;
          count: number;
          cookies: Array<{
            name: string;
            value: string;
            httpOnly: boolean;
            secure: boolean;
            sameSite?: string;
            expires: string;
          }>;
        }> = [];
        for (const [domain, domainCookies] of [...groups.entries()].sort()) {
          result.push({
            domain,
            count: domainCookies.length,
            cookies: domainCookies.map((c) => ({
              name: c.name,
              value: c.value,
              httpOnly: c.httpOnly ?? false,
              secure: c.secure ?? false,
              sameSite: c.sameSite,
              expires:
                c.expires !== undefined
                  ? c.expires < now
                    ? 'expired'
                    : new Date(c.expires * 1000).toISOString()
                  : 'session',
            })),
          });
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ total: cookies.length, domains: result }, null, 2) }],
        } satisfies CallToolResult;
      } catch (error) {
        return formatError(error);
      }
    },
  );

  server.registerTool(
    'auto-browser_import_cookies',
    {
      description: 'Import cookies from JSON data into a cookie file. The file will be created or overwritten.',
      inputSchema: z.object({
        cookies: z.string().describe('JSON array of cookie objects [{name, value, domain, ...}]'),
        outputPath: z.string().describe('Output file path to save the cookies'),
        domain: z.string().optional().describe('Optional domain filter — only keep cookies matching this domain'),
      }),
    },
    async (args) => {
      try {
        let parsed: Cookie[];
        try {
          parsed = JSON.parse(args.cookies) as Cookie[];
        } catch {
          return {
            content: [{ type: 'text', text: 'Invalid JSON: failed to parse cookies input' }],
            isError: true,
          } satisfies CallToolResult;
        }
        if (!Array.isArray(parsed) || parsed.length === 0) {
          return {
            content: [{ type: 'text', text: 'Cookies must be a non-empty JSON array' }],
            isError: true,
          } satisfies CallToolResult;
        }
        const normalized = normalizeCookies(parsed);
        let filtered = normalized;
        if (args.domain) {
          const filterDomain = args.domain.startsWith('.') ? args.domain : `.${args.domain}`;
          filtered = normalized.filter(
            (c) =>
              c.domain === args.domain ||
              c.domain === filterDomain ||
              c.domain.endsWith(filterDomain),
          );
        }
        if (filtered.length === 0) {
          return {
            content: [{ type: 'text', text: 'No valid cookies after filtering' }],
            isError: true,
          } satisfies CallToolResult;
        }
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { dirname, resolve } = await import('node:path');
        const resolvedPath = resolve(args.outputPath);
        mkdirSync(dirname(resolvedPath), { recursive: true });
        writeFileSync(resolvedPath, JSON.stringify({ cookies: filtered, origins: [] }, null, 2), 'utf-8');
        const domains = [...new Set(filtered.map((c) => c.domain))].join(', ');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  imported: filtered.length,
                  domains,
                  outputPath: resolvedPath,
                },
                null,
                2,
              ),
            },
          ],
        } satisfies CallToolResult;
      } catch (error) {
        return formatError(error);
      }
    },
  );

  server.registerTool(
    'auto-browser_clear_cookies',
    {
      description: 'Remove cookies from a cookie file by domain and/or name.',
      inputSchema: z.object({
        cookiesPath: z.string().describe('Path to the cookie file'),
        domain: z.string().optional().describe('Remove all cookies matching this domain'),
        name: z.string().optional().describe('Remove all cookies with this name'),
      }),
    },
    async (args) => {
      try {
        if (!args.domain && !args.name) {
          return {
            content: [{ type: 'text', text: 'Specify --domain and/or --name to filter cookies to remove' }],
            isError: true,
          } satisfies CallToolResult;
        }
        const { existsSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const resolvedPath = resolve(args.cookiesPath);
        if (!existsSync(resolvedPath)) {
          return {
            content: [{ type: 'text', text: `File not found: ${resolvedPath}` }],
            isError: true,
          } satisfies CallToolResult;
        }
        const state = loadStorageState(args.cookiesPath);
        const before = state.cookies.length;
        state.cookies = state.cookies.filter((c) => {
          if (args.domain && args.name) {
            return !(matchesDomain(c.domain, args.domain) && c.name === args.name);
          }
          if (args.domain) return !matchesDomain(c.domain, args.domain);
          if (args.name) return c.name !== args.name;
          return true;
        });
        const removed = before - state.cookies.length;
        if (removed === 0) {
          return {
            content: [{ type: 'text', text: 'No matching cookies found to remove' }],
          } satisfies CallToolResult;
        }
        const { writeFileSync } = await import('node:fs');
        writeFileSync(resolvedPath, JSON.stringify(state, null, 2), 'utf-8');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ removed, remaining: state.cookies.length, file: resolvedPath }, null, 2),
            },
          ],
        } satisfies CallToolResult;
      } catch (error) {
        return formatError(error);
      }
    },
  );
}

export async function startMcpServer(
  serverInstance?: McpServer,
  serviceInstance?: InMemoryControlService,
): Promise<McpServer> {
  const service = serviceInstance ?? createControlService();
  const server = serverInstance ?? new McpServer(
    { name: 'auto-browser', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  registerAllTools(server, service);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  return server;
}

// Auto-start when run directly
if (isExecutedAsMain(import.meta.url, process.argv[1])) {
  startMcpServer().catch((err) => {
    console.error('MCP server failed:', err);
    process.exit(1);
  });
}
