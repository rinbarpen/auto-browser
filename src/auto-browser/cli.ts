#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BrowserRuntimeConfig, Task } from './control-service.js';
import { extractErrorContext, formatError, getErrorProblem, isStructuredErrorPayload, wrapError } from './error-context.js';
import { LlmRouterClient } from './llm-router.js';

const CLI_VERSION = '0.1.0';

type CommandName = 'serve' | 'state' | 'submit' | 'approve' | 'handoff' | 'resume' | 'run' | 'completion' | 'goal' | 'plan' | 'version' | 'skill' | 'eval';
type ParsedArguments = {
  command: CommandName;
  options: Record<string, string | boolean>;
  positionals: string[];
};

export type CliConfig = {
  controlPort: number;
  plannerModel: string;
  executorModel: string;
  modelTier: string;
  routerBaseUrl: string;
  routerApiKey: string;
};

const MODEL_TIERS: Record<string, { plannerModel: string; executorModel: string }> = {
  standard: { plannerModel: 'deepseek-v4-pro', executorModel: 'deepseek-v4-flash' },
  premium: { plannerModel: 'deepseek-v4-pro', executorModel: 'deepseek-v4-pro' },
  economy: { plannerModel: 'deepseek-v4-flash', executorModel: 'deepseek-v4-flash' },
};

type BrowserDefaults = {
  mode?: 'system' | 'managed';
  browserFamily?: string;
  executablePath?: string;
  profilePath?: string;
};

type BrowserDefaultsResolver = (config: CliConfig) => Promise<BrowserDefaults>;

type SubmitTaskResponse = Pick<Task, 'id' | 'conversationId' | 'status' | 'planDraft'>;

type EnsureServiceAvailableOptions = {
  command?: CommandName;
  config: CliConfig;
  isHealthy?: (config: CliConfig) => Promise<boolean>;
  validateModels?: (command: CommandName | undefined, config: CliConfig) => Promise<void>;
  spawnService?: (config: CliConfig) => void;
  waitForReady?: (config: CliConfig) => Promise<void>;
};

export const CLI_EXIT_CODES = {
  success: 0,
  usage: 2,
  config: 3,
  service: 4,
  request: 5,
  internal: 1,
} as const;

type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

export class CliError extends Error {
  readonly exitCode: CliExitCode;
  readonly context?: {
    module: string;
    file: string;
    location: string;
    problem: string;
  };

  constructor(
    message: string,
    exitCode: CliExitCode,
    context?: {
      module: string;
      file: string;
      location: string;
      problem: string;
    }
  ) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.context = context;
  }
}

const HELP_TEXT = `auto-browser <command> [options]

Commands:
  serve                                  Start the local control service
  state [--json]                         Show control-service state
  submit --goal "<text>" [--json]        Submit a browser task draft
  run --goal "<text>" [--json] [--tui]  Submit a draft and immediately approve it
  approve --task-id <id> [--json]        Approve and run a drafted task
  handoff --task-id <id> [--source cli]  Enter handoff mode
  resume --task-id <id> [--json]         Resume a handed-off task
  version                                Show CLI version
  completion <bash|zsh>                  Print a shell completion script

  goal create --title "..." [options]    Create a new goal (without drafting a plan)
  goal list [--status <status>] [--json] List all goals
  goal show --goal-id <id> [--json]      Show goal details
  goal archive --goal-id <id>            Archive a goal

  plan create --goal-id <id> [--json]    Draft a plan for a goal
  plan list --goal-id <id> [--json]      List plans for a goal
  plan show --plan-id <id> [--json]      Show plan details and version info
  plan edit --plan-id <id> [options]     Edit plan steps (creates new version)

  skill list [--json]                    List all project skills
  skill show --skill-path <path> [--json] Show skill file contents
  skill update --skill-path <path>       Update a skill file

  eval list [--json]                     List available eval tests
  eval run [--eval-id <id>] [--json]    Run eval tests against the LLM router

Common options:
  --port <n>
  --planner-model <id>
  --executor-model <id>
  --model-tier <tier>
  --router-base-url <url>
  --router-api-key <key>
  --json

Goal options:
  --title "<text>"        Goal title
  --description "<text>"  Goal description
  --context "<text>"      Goal reference context

Plan edit options:
  --step-id <id>          Step to edit (repeatable)
  --title "<text>"        New step title
  --intent "<text>"       New step intent

Examples:
  auto-browser run --goal "open example.com and tell me the title" \\
    --planner-model openai/gpt-5.4 --executor-model openai/gpt-5.4
  auto-browser goal create --title "Search docs" --description "Find API references"
  auto-browser plan create --goal-id <id> --json
  auto-browser submit --goal "log in and stop before submit" --json
  auto-browser version
  auto-browser skill list
  auto-browser eval list
  auto-browser completion bash

Exit codes:
  0 success
  1 internal error
  2 usage or unsupported arguments
  3 missing or invalid CLI configuration
  4 control service startup or readiness failure
  5 API request failure
`;

function cliContext(location: string, problem?: string) {
  return {
    module: 'auto-browser.cli',
    file: 'src/auto-browser/cli.ts',
    location,
    problem: problem ?? '',
  };
}

function createStructuredCliError(problem: string, exitCode: CliExitCode, location: string): CliError {
  const context = cliContext(location, problem);
  return new CliError(formatError(context), exitCode, context);
}

export function parseCliArgs(argv: string[]): ParsedArguments {
  const [commandToken, ...rest] = argv;
  if (!commandToken || commandToken === 'help' || commandToken === '--help') {
    throw new CliError(HELP_TEXT.trim(), CLI_EXIT_CODES.usage);
  }
  if (commandToken === '--version') {
    throw new CliError(`auto-browser v${CLI_VERSION}`, CLI_EXIT_CODES.success);
  }
  const command = commandToken as CommandName | undefined;
  if (!command || !['serve', 'state', 'submit', 'approve', 'handoff', 'resume', 'run', 'completion', 'goal', 'plan', 'version', 'skill', 'eval'].includes(command)) {
    throw new CliError(HELP_TEXT.trim(), CLI_EXIT_CODES.usage);
  }

  if (rest.includes('--help')) {
    throw new CliError(HELP_TEXT.trim(), CLI_EXIT_CODES.usage);
  }
  if (rest.includes('--version')) {
    throw new CliError(`auto-browser v${CLI_VERSION}`, CLI_EXIT_CODES.success);
  }

  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const booleanFlags = new Set(['json', 'tui', 'headless', 'headed', 'extensionEnabled', 'previewEnabled', 'cloakHumanize']);

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const rawKey = token.slice(2);
    if (rawKey.startsWith('no-')) {
      options[toCamelCase(rawKey.slice(3))] = false;
      continue;
    }

    if (booleanFlags.has(toCamelCase(rawKey))) {
      options[toCamelCase(rawKey)] = true;
      continue;
    }

    const next = rest[index + 1];
    if (!next || next.startsWith('--')) {
      options[toCamelCase(rawKey)] = true;
      continue;
    }

    options[toCamelCase(rawKey)] = next;
    index += 1;
  }

  return { command, options, positionals };
}

export function resolveCliConfig(
  parsed: { options: Record<string, string | boolean> },
  env: NodeJS.ProcessEnv
): CliConfig {
  const explicitPlannerModel = parsed.options.plannerModel;
  const explicitExecutorModel = parsed.options.executorModel;
  const modelTier = String(parsed.options.modelTier ?? env.AUTO_BROWSER_MODEL_TIER ?? '').trim();
  const tierPreset = modelTier ? MODEL_TIERS[modelTier] : undefined;

  return {
    controlPort: Number(parsed.options.port ?? env.AUTO_BROWSER_CONTROL_PORT ?? '4317'),
    plannerModel: String(explicitPlannerModel ?? env.AUTO_BROWSER_PLANNER_MODEL ?? tierPreset?.plannerModel ?? 'deepseek-v4-pro'),
    executorModel: String(explicitExecutorModel ?? env.AUTO_BROWSER_EXECUTOR_MODEL ?? tierPreset?.executorModel ?? 'deepseek-v4-flash'),
    modelTier,
    routerBaseUrl: String(
      parsed.options.routerBaseUrl ?? env.AUTO_BROWSER_LLM_ROUTER_BASE_URL ?? 'http://127.0.0.1:18000'
    ),
    routerApiKey: String(parsed.options.routerApiKey ?? env.AUTO_BROWSER_LLM_ROUTER_API_KEY ?? ''),
  };
}

export function validateCommandConfig(command: CommandName, config: CliConfig): void {
  if ((command === 'submit' || command === 'resume' || command === 'run') && !config.plannerModel.trim()) {
    throw createStructuredCliError(
      'Planner model is required. Pass --planner-model <id> or set AUTO_BROWSER_PLANNER_MODEL.',
      CLI_EXIT_CODES.config,
      `command:${command}`
    );
  }

  if ((command === 'approve' || command === 'run') && !config.executorModel.trim()) {
    throw createStructuredCliError(
      'Executor model is required. Pass --executor-model <id> or set AUTO_BROWSER_EXECUTOR_MODEL.',
      CLI_EXIT_CODES.config,
      `command:${command}`
    );
  }
}

export function getCompletionScript(shell: string): string {
  if (shell === 'bash') {
    return `# bash completion for auto-browser
_auto_browser() {
  local cur prev words cword
  _init_completion || return

  local commands="serve state submit run approve handoff resume version skill eval completion help"
  local global_opts="--help --json --port --planner-model --executor-model --model-tier --router-base-url --router-api-key"

  if [[ $cword -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return
  fi

  case "\${words[1]}" in
    completion)
      COMPREPLY=( $(compgen -W "bash zsh" -- "$cur") )
      ;;
    approve|resume|handoff)
      COMPREPLY=( $(compgen -W "--task-id --json" -- "$cur") )
      ;;
    version)
      COMPREPLY=( $(compgen -W "--json" -- "$cur") )
      ;;
    skill)
      COMPREPLY=( $(compgen -W "list show update --skill-path --json --content" -- "$cur") )
      ;;
    eval)
      COMPREPLY=( $(compgen -W "list run --eval-id --json" -- "$cur") )
      ;;
    submit|run)
      COMPREPLY=( $(compgen -W "--goal --context --conversation-id --browser-family --executable-path --profile-path --cookies-path --credentials-path --headless --headed --extension-enabled --no-extension-enabled --preview-enabled --no-preview-enabled --cloak-humanize --cloak-fingerprint-seed --cloak-timezone --cloak-locale $global_opts" -- "$cur") )
      ;;
    state)
      COMPREPLY=( $(compgen -W "--json --port" -- "$cur") )
      ;;
    serve)
      COMPREPLY=( $(compgen -W "--port --planner-model --planner-tier --executor-model --executor-tier --router-base-url --router-api-key" -- "$cur") )
      ;;
    *)
      COMPREPLY=( $(compgen -W "$global_opts" -- "$cur") )
      ;;
  esac
}

complete -F _auto_browser auto-browser
`;
  }

  if (shell === 'zsh') {
    return `#compdef auto-browser

local -a commands
commands=(
  'serve:Start the local control service'
  'state:Show control-service state'
  'submit:Submit a browser task draft'
  'run:Submit a draft and immediately approve it'
  'approve:Approve and run a drafted task'
  'handoff:Enter handoff mode'
  'resume:Resume a handed-off task'
  'completion:Print a shell completion script'
  'version:Show CLI version'
  'skill:Manage project skills'
  'eval:Run eval tests'
)

_arguments \
  '1:command:->command' \
  '*::arg:->args'

case $state in
  command)
    _describe 'commands' commands
    ;;
  args)
    case $words[2] in
      completion)
        _values 'shell' bash zsh
        ;;
      approve|resume|handoff)
        _arguments '--task-id[Task identifier]' '--json[Emit JSON output]'
        ;;
      submit|run)
        _arguments \
          '--goal[Task goal]:goal:' \
          '--context[Extra context for the LLM]:context:' \
          '--conversation-id[Conversation identifier]:conversation:' \
          '--browser-family[Browser family]:browser:(chrome chromium edge cloak)' \
          '--executable-path[Browser executable path]:path:_files' \
          '--profile-path[Browser profile path]:path:_files' \
          '--cookies-path[Cookies storage state file path]:path:_files' \
          '--credentials-path[Credentials JSON file path]:path:_files' \
          '--headless[Force headless browser mode]' \
          '--headed[Force headed browser mode]' \
          '--extension-enabled[Enable extension]' \
          '--no-extension-enabled[Disable extension]' \
          '--preview-enabled[Enable preview]' \
          '--no-preview-enabled[Disable preview]' \
          '--cloak-humanize[Enable CloakBrowser humanize mode]' \
          '--cloak-fingerprint-seed[CloakBrowser fingerprint seed]:seed:' \
          '--cloak-timezone[CloakBrowser timezone override]:tz:' \
          '--cloak-locale[CloakBrowser locale override]:locale:' \
          '--planner-model[Planner model id]:model:' \
	          '--executor-tier[Executor model tier]:tier:' \
	          '--planner-tier[Planner model tier]:tier:' \
          '--executor-model[Executor model id]:model:' \
	          '--executor-tier[Executor model tier]:tier:' \
          '--router-base-url[Router base URL]:url:' \
          '--router-api-key[Router API key]:key:' \
          '--port[Control service port]:port:' \
          '--json[Emit JSON output]'
        ;;
      state)
        _arguments '--json[Emit JSON output]' '--port[Control service port]:port:'
        ;;
      serve)
        _arguments \
          '--port[Control service port]:port:' \
          '--planner-model[Planner model id]:model:' \
	          '--executor-tier[Executor model tier]:tier:' \
	          '--planner-tier[Planner model tier]:tier:' \
          '--executor-model[Executor model id]:model:' \
	          '--executor-tier[Executor model tier]:tier:' \
          '--router-base-url[Router base URL]:url:' \
          '--router-api-key[Router API key]:key:'
        ;;
      version)
        _arguments '--json[Emit JSON output]'
        ;;
      skill)
        _values 'action' list show update
        ;;
      eval)
        _values 'action' list run
        ;;
    esac
    ;;
esac
`;
  }

  throw new CliError(
    `Unsupported shell "${shell}". Use "bash" or "zsh".`,
    CLI_EXIT_CODES.usage
  );
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }

  const context = extractErrorContext(error);
  const problem = context?.problem ?? getErrorProblem(error);
  const message = context ? formatError(context) : problem;
  if (
    problem.includes('Planner model is required') ||
    problem.includes('Executor model is required') ||
    problem.includes('model is not available in the configured LLM router') ||
    problem.includes('LLM Router could not find model') ||
    problem.includes('LLM Router has no available provider account') ||
    problem.includes('Goal is required') ||
    problem.endsWith('is required.')
  ) {
    return new CliError(message, CLI_EXIT_CODES.config, context ?? undefined);
  }
  if (
    problem.includes('Timed out waiting for control service') ||
    problem.includes('Control service entrypoint not found')
  ) {
    return new CliError(message, CLI_EXIT_CODES.service, context ?? undefined);
  }
  if (problem.startsWith('Request failed:') || problem.includes('Request returned')) {
    return new CliError(message, CLI_EXIT_CODES.request, context ?? undefined);
  }
  return new CliError(message, CLI_EXIT_CODES.internal, context ?? undefined);
}

export async function ensureServiceAvailable({
  command,
  config,
  isHealthy = probeServiceHealth,
  validateModels = validateRouterModels,
  spawnService = spawnControlService,
  waitForReady = waitForServiceReady,
}: EnsureServiceAvailableOptions): Promise<void> {
  await validateModels(command, config);

  if (await isHealthy(config)) {
    return;
  }

  spawnService(config);
  await waitForReady(config);
}

export function formatSubmitResult(task: SubmitTaskResponse): string {
  const lines = [
    `Conversation: ${task.conversationId}`,
    `Task: ${task.id}`,
    `Status: ${task.status}`,
    `Summary: ${task.planDraft.summary}`,
    'Steps:',
  ];

  for (const [index, step] of task.planDraft.steps.entries()) {
    lines.push(`${index + 1}. ${step.title} - ${step.intent}`);
  }

  return lines.join('\n');
}

function formatTaskResult(task: Partial<Task> & { id: string; status: string }): string {
  const lines = [`Task: ${task.id}`, `Status: ${task.status}`];
  if (typeof task.resultSummary === 'string' && task.resultSummary.trim()) {
    lines.push(`Summary: ${task.resultSummary}`);
  }
  return lines.join('\n');
}

function formatStateResult(payload: { conversations: unknown[]; tasks: unknown[]; activeTask: unknown }): string {
  const lines = [
    `Conversations: ${payload.conversations.length}`,
    `Tasks: ${payload.tasks.length}`,
    `Active task: ${payload.activeTask ? 'yes' : 'no'}`,
  ];
  return lines.join('\n');
}

function formatGoalResult(goal: { id: string; title: string; description?: string | null; status: string; createdAt: string }): string {
  const lines = [
    `Goal: ${goal.id}`,
    `Title: ${goal.title}`,
    `Status: ${goal.status}`,
    `Created: ${goal.createdAt}`,
  ];
  if (goal.description) lines.push(`Description: ${goal.description}`);
  return lines.join('\n');
}

function formatGoalListResult(goals: Array<{ id: string; title: string; status: string; createdAt: string }>): string {
  if (!goals.length) return 'No goals found.';
  const lines = ['Goals:'];
  for (const goal of goals) {
    lines.push(`  ${goal.id}  ${goal.status.padEnd(10)} ${goal.title}  (${goal.createdAt.slice(0, 10)})`);
  }
  return lines.join('\n');
}

function formatPlanResult(plan: { id: string; goalId: string; version: number; summary: string; steps: Array<{ id: string; title: string; intent: string }>; status: string }): string {
  const lines = [
    `Plan: ${plan.id}`,
    `Goal: ${plan.goalId}`,
    `Version: ${plan.version}`,
    `Status: ${plan.status}`,
    `Summary: ${plan.summary}`,
    'Steps:',
  ];
  for (const step of plan.steps) {
    lines.push(`  ${step.id}  ${step.title} - ${step.intent}`);
  }
  return lines.join('\n');
}

function formatPlanListResult(plans: Array<{ id: string; version: number; status: string; summary: string; createdAt: string }>): string {
  if (!plans.length) return 'No plans found.';
  const lines = ['Plans:'];
  for (const plan of plans) {
    lines.push(`  ${plan.id}  v${plan.version}  ${plan.status.padEnd(10)} ${plan.summary.slice(0, 60)}  (${plan.createdAt.slice(0, 10)})`);
  }
  return lines.join('\n');
}

function formatEvalListResult(evals: Array<{ id: number; prompt: string; expectedOutput: string }>): string {
  if (!evals.length) return 'No evals found.';
  const lines = ['Evals:'];
  for (const ev of evals) {
    const truncatedPrompt = ev.prompt.length > 60 ? `${ev.prompt.slice(0, 57)}...` : ev.prompt;
    lines.push(`  ${ev.id}: ${truncatedPrompt}`);
  }
  return lines.join('\n');
}

function formatEvalRunResult(results: Array<{ evalId: number; pass: boolean; summary: string }>): string {
  if (!results.length) return 'No results.';
  const lines = ['Eval Results:'];
  for (const r of results) {
    const badge = r.pass ? '✓ PASS' : '✗ FAIL';
    lines.push(`  [${badge}] Eval ${r.evalId}: ${r.summary}`);
  }
  const passed = results.filter((r) => r.pass).length;
  lines.push(`\n${passed}/${results.length} passed`);
  return lines.join('\n');
}

async function handleSkillCommand(parsed: ParsedArguments): Promise<void> {
  const sub = String(parsed.positionals[0] ?? '').toLowerCase();
  if (sub === 'list') {
    const skillsDir = fileURLToPath(new URL('../../skills', import.meta.url));
    if (!existsSync(skillsDir)) {
      outputResult([], parsed.options.json === true ? '[]' : 'No skills directory found.');
      return;
    }
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const entries = readdirSync(skillsDir);
    const skills: Array<{ name: string; description: string; path: string }> = [];
    for (const entry of entries) {
      const skillDirPath = join(skillsDir, entry);
      const skillFilePath = join(skillDirPath, 'SKILL.md');
      if (!existsSync(skillFilePath)) continue;
      const content = readFileSync(skillFilePath, 'utf8');
      const nameMatch = content.match(/^name:\s*(.+)$/m);
      const descMatch = content.match(/^description:\s*>\s*\n\s+(.+)$/m);
      skills.push({
        name: nameMatch?.[1]?.trim() ?? entry,
        description: descMatch?.[1]?.trim() ?? '(no description)',
        path: skillFilePath,
      });
    }
    const text = skills.length === 0
      ? 'No skills found.'
      : skills.map((s) => `  ${s.name}: ${s.description}`).join('\n');
    outputResult(skills, parsed.options.json === true ? JSON.stringify(skills, null, 2) : text);
    return;
  }

  if (sub === 'show') {
    const skillPath = typeof parsed.options.skillPath === 'string' ? parsed.options.skillPath.trim() : '';
    if (!skillPath) {
      throw createStructuredCliError(
        '--skill-path is required for skill show.',
        CLI_EXIT_CODES.usage,
        'command:skill:show'
      );
    }
    const { readFileSync } = await import('node:fs');
    const resolvedPath = skillPath.startsWith('/') ? skillPath : fileURLToPath(new URL(`../../${skillPath}`, import.meta.url));
    if (!existsSync(resolvedPath)) {
      throw createStructuredCliError(
        `Skill file not found: ${resolvedPath}`,
        CLI_EXIT_CODES.config,
        'command:skill:show'
      );
    }
    const content = readFileSync(resolvedPath, 'utf8');
    outputResult(content, parsed.options.json === true ? JSON.stringify({ path: resolvedPath, content }) : content);
    return;
  }

  if (sub === 'update') {
    const skillPath = typeof parsed.options.skillPath === 'string' ? parsed.options.skillPath.trim() : '';
    if (!skillPath) {
      throw createStructuredCliError(
        '--skill-path is required for skill update.',
        CLI_EXIT_CODES.usage,
        'command:skill:update'
      );
    }
    const resolvedPath = skillPath.startsWith('/') ? skillPath : fileURLToPath(new URL(`../../${skillPath}`, import.meta.url));
    if (!existsSync(resolvedPath)) {
      throw createStructuredCliError(
        `Skill file not found: ${resolvedPath}`,
        CLI_EXIT_CODES.config,
        'command:skill:update'
      );
    }
    if (typeof parsed.options.content === 'string') {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(resolvedPath, parsed.options.content, 'utf8');
      outputResult(resolvedPath, `Skill updated: ${resolvedPath}`);
      return;
    }
    const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi';
    const { spawnSync } = await import('node:child_process');
    spawnSync(editor, [resolvedPath], { stdio: 'inherit' });
    outputResult(resolvedPath, `Skill updated: ${resolvedPath}`);
    return;
  }

  throw createStructuredCliError(
    `Unknown skill sub-command: ${sub}. Use: list, show, update`,
    CLI_EXIT_CODES.usage,
    'command:skill'
  );
}

async function main(): Promise<void> {
  let activeCommand: CommandName | undefined;

  try {
    const parsed = parseCliArgs(process.argv.slice(2));
    activeCommand = parsed.command;
    const config = resolveCliConfig(parsed, process.env);

    if (parsed.command === 'serve') {
      await runServeCommand(config);
      return;
    }

    if (parsed.command === 'completion') {
      const shell = parsed.positionals[0] ?? parsed.options.shell;
      if (typeof shell !== 'string' || !shell.trim()) {
        throw createStructuredCliError(
          'Shell is required. Use auto-browser completion <bash|zsh>.',
          CLI_EXIT_CODES.usage,
          'command:completion'
        );
      }
      const script = getCompletionScript(shell.trim());
      outputResult(script, script);
      return;
    }

    if (parsed.command === 'version') {
      outputResult(CLI_VERSION, `auto-browser v${CLI_VERSION}`);
      return;
    }

    if (parsed.command === 'skill') {
      await handleSkillCommand(parsed);
      return;
    }

    validateCommandConfig(parsed.command, config);
    await ensureServiceAvailable({ command: parsed.command, config });

    switch (parsed.command) {
      case 'state': {
        const payload = await requestJson(`${getBaseUrl(config)}/state`, undefined, cliContext('command:state'));
        outputResult(payload, parsed.options.json === true ? JSON.stringify(payload, null, 2) : formatStateResult(payload));
        return;
      }
      case 'submit':
      case 'run': {
        const goal = resolveGoal(parsed);
        const browserConfig = await resolveBrowserConfig(config, parsed.options);
        const conversationId =
          typeof parsed.options.conversationId === 'string'
            ? parsed.options.conversationId
            : (await requestJson(`${getBaseUrl(config)}/conversations`, { method: 'POST' }, cliContext(`command:${parsed.command}`))).id;

        const context = String(parsed.options.context ?? '');

        const task = (await requestJson(`${getBaseUrl(config)}/conversations/${conversationId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content: goal,
            context,
            browserConfig,
            plannerModel: config.plannerModel,
            modelTier: config.modelTier || undefined,
          }),
        }, cliContext(`command:${parsed.command}`))) as SubmitTaskResponse;

        if (parsed.command === 'run') {
          if (parsed.options.tui === true) {
            const runTask = await requestJson(`${getBaseUrl(config)}/tasks/${task.id}/run`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                executorModel: config.executorModel,
                modelTier: config.modelTier || undefined,
              }),
            }, cliContext('command:run:tui'));

            const baseUrl = getBaseUrl(config);
            const { startTui } = await import('./tui.js');
            const handle = startTui({
              taskId: task.id,
              goal,
              baseUrl,
              onCancel: async () => {
                await requestJson(`${baseUrl}/tasks/${task.id}/cancel`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({}),
                }, cliContext('command:run:tui:cancel')).catch(() => undefined);
              },
              onRerun: async () => {
                try {
                  const newTask = (await requestJson(`${getBaseUrl(config)}/conversations/${conversationId}/messages`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                      content: goal,
                      context,
                      browserConfig,
                      plannerModel: config.plannerModel,
                      modelTier: config.modelTier || undefined,
                    }),
                  }, cliContext('command:run:tui:rerun'))) as SubmitTaskResponse;
                  await requestJson(`${getBaseUrl(config)}/tasks/${newTask.id}/run`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                      executorModel: config.executorModel,
                      modelTier: config.modelTier || undefined,
                    }),
                  }, cliContext('command:run:tui:rerun'));
                  return newTask.id;
                } catch (error) {
                  const msg = error instanceof Error ? error.message : String(error);
                  process.stderr.write(`Re-run failed: ${msg}\n`);
                  return null;
                }
              },
            });
            await handle.waitUntilExit();
            return;
          }

          const approvedTask = await requestJson(`${getBaseUrl(config)}/tasks/${task.id}/approve`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              executorModel: config.executorModel,
              modelTier: config.modelTier || undefined,
            }),
          }, cliContext('command:run'));
          outputResult(
            approvedTask,
            parsed.options.json === true ? JSON.stringify(approvedTask, null, 2) : formatTaskResult(approvedTask)
          );
          return;
        }

        outputResult(task, parsed.options.json === true ? JSON.stringify(task, null, 2) : formatSubmitResult(task));
        return;
      }
      case 'approve': {
        const taskId = requireStringOption(parsed.options.taskId, '--task-id');
        const task = await requestJson(`${getBaseUrl(config)}/tasks/${taskId}/approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            executorModel: config.executorModel,
            modelTier: config.modelTier || undefined,
          }),
        }, cliContext('command:approve'));
        outputResult(task, parsed.options.json === true ? JSON.stringify(task, null, 2) : formatTaskResult(task));
        return;
      }
      case 'handoff': {
        const taskId = requireStringOption(parsed.options.taskId, '--task-id');
        const source = typeof parsed.options.source === 'string' ? parsed.options.source : 'cli';
        const task = await requestJson(`${getBaseUrl(config)}/tasks/${taskId}/handoff`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source }),
        }, cliContext('command:handoff'));
        outputResult(task, parsed.options.json === true ? JSON.stringify(task, null, 2) : formatTaskResult(task));
        return;
      }
      case 'resume': {
        const taskId = requireStringOption(parsed.options.taskId, '--task-id');
        const task = await requestJson(`${getBaseUrl(config)}/tasks/${taskId}/resume`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            plannerModel: config.plannerModel,
            modelTier: config.modelTier || undefined,
          }),
        }, cliContext('command:resume'));
        outputResult(task, parsed.options.json === true ? JSON.stringify(task, null, 2) : formatTaskResult(task));
        return;
      }
      case 'goal': {
        const sub = String(parsed.positionals[0] ?? '').toLowerCase();
        if (sub === 'create') {
          const title = requireStringOption(parsed.options.title, '--title');
          const description = typeof parsed.options.description === 'string' ? parsed.options.description : undefined;
          const context = typeof parsed.options.context === 'string' ? parsed.options.context : undefined;
          const goal = await requestJson(`${getBaseUrl(config)}/goals`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title, description, context }),
          }, cliContext('command:goal:create'));
          outputResult(goal, parsed.options.json === true ? JSON.stringify(goal, null, 2) : formatGoalResult(goal));
          return;
        }
        if (sub === 'list') {
          const status = typeof parsed.options.status === 'string' ? parsed.options.status : undefined;
          const url = `${getBaseUrl(config)}/goals${status ? `?status=${encodeURIComponent(status)}` : ''}`;
          const goals = await requestJson(url, undefined, cliContext('command:goal:list'));
          outputResult(goals, parsed.options.json === true ? JSON.stringify(goals, null, 2) : formatGoalListResult(goals));
          return;
        }
        if (sub === 'show') {
          const goalId = requireStringOption(parsed.options.goalId, '--goal-id');
          const goal = await requestJson(`${getBaseUrl(config)}/goals/${goalId}`, undefined, cliContext('command:goal:show'));
          outputResult(goal, parsed.options.json === true ? JSON.stringify(goal, null, 2) : formatGoalResult(goal));
          return;
        }
        if (sub === 'archive') {
          const goalId = requireStringOption(parsed.options.goalId, '--goal-id');
          const goal = await requestJson(`${getBaseUrl(config)}/goals/${goalId}`, {
            method: 'DELETE',
          }, cliContext('command:goal:archive'));
          outputResult(goal, parsed.options.json === true ? JSON.stringify(goal, null, 2) : formatGoalResult(goal));
          return;
        }
        throw createStructuredCliError(
          `Unknown goal sub-command: ${sub}. Use: create, list, show, archive`,
          CLI_EXIT_CODES.usage,
          'command:goal'
        );
      }
      case 'plan': {
        const sub = String(parsed.positionals[0] ?? '').toLowerCase();
        if (sub === 'create') {
          const goalId = requireStringOption(parsed.options.goalId, '--goal-id');
          const browserConfig = await resolveBrowserConfig(config, parsed.options);
          const plan = await requestJson(`${getBaseUrl(config)}/goals/${goalId}/plans`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              plannerModel: config.plannerModel,
              modelTier: config.modelTier || undefined,
            }),
          }, cliContext('command:plan:create'));
          outputResult(plan, parsed.options.json === true ? JSON.stringify(plan, null, 2) : formatPlanResult(plan));
          return;
        }
        if (sub === 'list') {
          const goalId = requireStringOption(parsed.options.goalId, '--goal-id');
          const plans = await requestJson(`${getBaseUrl(config)}/goals/${goalId}/plans`, undefined, cliContext('command:plan:list'));
          outputResult(plans, parsed.options.json === true ? JSON.stringify(plans, null, 2) : formatPlanListResult(plans));
          return;
        }
        if (sub === 'show') {
          const planId = requireStringOption(parsed.options.planId, '--plan-id');
          const plan = await requestJson(`${getBaseUrl(config)}/plans/${planId}`, undefined, cliContext('command:plan:show'));
          outputResult(plan, parsed.options.json === true ? JSON.stringify(plan, null, 2) : formatPlanResult(plan));
          return;
        }
        if (sub === 'edit') {
          const planId = requireStringOption(parsed.options.planId, '--plan-id');
          const stepId = requireStringOption(parsed.options.stepId, '--step-id');
          const plan = await requestJson(`${getBaseUrl(config)}/plans/${planId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              edits: [{
                stepId,
                title: typeof parsed.options.title === 'string' ? parsed.options.title : undefined,
                intent: typeof parsed.options.intent === 'string' ? parsed.options.intent : undefined,
              }],
            }),
          }, cliContext('command:plan:edit'));
          outputResult(plan, parsed.options.json === true ? JSON.stringify(plan, null, 2) : formatPlanResult(plan));
          return;
        }
        throw createStructuredCliError(
          `Unknown plan sub-command: ${sub}. Use: create, list, show, edit`,
          CLI_EXIT_CODES.usage,
          'command:plan'
        );
      }
      case 'eval': {
        const { EvalRunner } = await import('./eval-runner.js');
        const runner = new EvalRunner(config);
        const sub = String(parsed.positionals[0] ?? '').toLowerCase();
        if (sub === 'list') {
          const evals = await runner.list();
          outputResult(evals, parsed.options.json === true ? JSON.stringify(evals, null, 2) : formatEvalListResult(evals));
          return;
        }
        if (sub === 'run') {
          const evalId = typeof parsed.options.evalId === 'string' ? parsed.options.evalId : undefined;
          const results = await runner.run(evalId);
          outputResult(results, parsed.options.json === true ? JSON.stringify(results, null, 2) : formatEvalRunResult(results));
          return;
        }
        throw createStructuredCliError(
          `Unknown eval sub-command: ${sub}. Use: list, run`,
          CLI_EXIT_CODES.usage,
          'command:eval'
        );
      }
      default:
        throw new CliError(HELP_TEXT.trim(), CLI_EXIT_CODES.usage);
    }
  } catch (error) {
    const normalizedError =
      activeCommand && !(error instanceof CliError && error.context)
        ? wrapError(error, cliContext(`command:${activeCommand}`))
        : error;
    const cliError = toCliError(normalizedError);
    console.error(cliError.message);
    process.exitCode = cliError.exitCode;
  }
}

async function runServeCommand(config: CliConfig): Promise<void> {
  if (process.env.AUTO_BROWSER_CONTROL_PORT !== String(config.controlPort)) {
    process.env.AUTO_BROWSER_CONTROL_PORT = String(config.controlPort);
  }
  if (config.plannerModel) process.env.AUTO_BROWSER_PLANNER_MODEL = config.plannerModel;
  if (config.executorModel) process.env.AUTO_BROWSER_EXECUTOR_MODEL = config.executorModel;
  if (config.modelTier) process.env.AUTO_BROWSER_MODEL_TIER = config.modelTier;
  if (config.routerBaseUrl) process.env.AUTO_BROWSER_LLM_ROUTER_BASE_URL = config.routerBaseUrl;
  if (config.routerApiKey) process.env.AUTO_BROWSER_LLM_ROUTER_API_KEY = config.routerApiKey;

  await import('./server.js');
}

export async function resolveBrowserConfig(
  config: CliConfig,
  options: Record<string, string | boolean>,
  getDefaults: BrowserDefaultsResolver = async (runtimeConfig) =>
    (await requestJson(
      `${getBaseUrl(runtimeConfig)}/browser-runtime/defaults`,
      undefined,
      cliContext('resolveBrowserConfig')
    )) as BrowserDefaults
): Promise<BrowserRuntimeConfig> {
  const defaults = await getDefaults(config);
  const explicitExecutablePath = String(options.executablePath ?? '').trim();
  if (options.headless === true && options.headed === true) {
    throw createStructuredCliError(
      'Cannot use --headless and --headed together.',
      CLI_EXIT_CODES.config,
      'resolveBrowserConfig'
    );
  }

  const mode = explicitExecutablePath.length > 0 ? 'system' : (defaults.mode ?? 'managed');

  return {
    mode,
    browserFamily: String(
      options.browserFamily ??
        defaults.browserFamily ??
        (mode === 'managed' ? 'chromium' : 'chrome')
    ) as BrowserRuntimeConfig['browserFamily'],
    executablePath: explicitExecutablePath || (mode === 'system' ? String(defaults.executablePath ?? '') : ''),
    profilePath: String(options.profilePath ?? defaults.profilePath ?? ''),
    cookiesPath: String(options.cookiesPath ?? ''),
    credentialsPath: String(options.credentialsPath ?? ''),
    launchMode: options.headless === true ? 'headless' : options.headed === true ? 'headed' : 'auto',
    extensionEnabled: options.extensionEnabled === false ? false : true,
    previewEnabled: options.previewEnabled === false ? false : true,
    cdpUrl: '',
    cloakHumanize: options.cloakHumanize === true,
    cloakFingerprintSeed: String(options.cloakFingerprintSeed ?? ''),
    cloakTimezone: String(options.cloakTimezone ?? ''),
    cloakLocale: String(options.cloakLocale ?? ''),
  };
}

export async function requestJson(
  url: string,
  init?: RequestInit,
  contextDefaults = cliContext('requestJson')
): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const context = wrapError(error, contextDefaults).context;
    throw new CliError(formatError(context), CLI_EXIT_CODES.request, context);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (isStructuredErrorPayload(payload)) {
      throw new CliError(formatError(payload.error), CLI_EXIT_CODES.request, payload.error);
    }

    const problem = typeof payload.error === 'string' ? payload.error : `Request failed: ${response.status}`;
    const context = wrapError(new Error(problem), contextDefaults).context;
    throw new CliError(formatError(context), CLI_EXIT_CODES.request, context);
  }
  return payload;
}

async function probeServiceHealth(config: CliConfig): Promise<boolean> {
  try {
    const response = await fetch(`${getBaseUrl(config)}/state`);
    return response.ok;
  } catch {
    return false;
  }
}

async function validateRouterModels(command: CommandName | undefined, config: CliConfig): Promise<void> {
  const requiredModels = getRequiredModels(command, config);
  if (requiredModels.length === 0) {
    return;
  }

  const client = new LlmRouterClient({
    baseUrl: config.routerBaseUrl,
    apiKey: config.routerApiKey,
  });

  let availableModels: string[];
  try {
    availableModels = await client.listModels();
  } catch {
    return;
  }

  if (availableModels.length === 0) {
    return;
  }

  const knownModels = new Set(availableModels);
  for (const requiredModel of requiredModels) {
    const resolvedModel = resolveCatalogModel(requiredModel.value, availableModels);
    if (resolvedModel) {
      config[requiredModel.key] = resolvedModel;
      continue;
    }

    const suggestions = suggestModels(requiredModel.value, availableModels).slice(0, 3);
    const suggestionText = suggestions.length > 0 ? ` Try one of: ${suggestions.join(', ')}` : '';
    throw createStructuredCliError(
      `${requiredModel.label} "${requiredModel.value}" is not available in the configured LLM router.${suggestionText} Use an exact model id from the router catalog.`,
      CLI_EXIT_CODES.config,
      command ? `command:${command}` : 'validateRouterModels'
    );
  }
}

function spawnControlService(config: CliConfig): void {
  const serverPath = resolveServerEntry();
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      AUTO_BROWSER_CONTROL_PORT: String(config.controlPort),
      AUTO_BROWSER_PLANNER_MODEL: config.plannerModel,
      AUTO_BROWSER_EXECUTOR_MODEL: config.executorModel,
      AUTO_BROWSER_MODEL_TIER: config.modelTier,
      AUTO_BROWSER_LLM_ROUTER_BASE_URL: config.routerBaseUrl,
      AUTO_BROWSER_LLM_ROUTER_API_KEY: config.routerApiKey,
    },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function waitForServiceReady(config: CliConfig): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await probeServiceHealth(config)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw createStructuredCliError(
    `Timed out waiting for control service on ${getBaseUrl(config)}`,
    CLI_EXIT_CODES.service,
    'waitForServiceReady'
  );
}

function resolveServerEntry(): string {
  const compiledPath = fileURLToPath(new URL('./server.js', import.meta.url));
  if (existsSync(compiledPath)) {
    return compiledPath;
  }

  throw createStructuredCliError(
    `Control service entrypoint not found at ${compiledPath}. Run npm run build first.`,
    CLI_EXIT_CODES.service,
    'resolveServerEntry'
  );
}

function resolveGoal(parsed: ParsedArguments): string {
  if (typeof parsed.options.goal === 'string' && parsed.options.goal.trim()) {
    return parsed.options.goal.trim();
  }
  const positionalGoal = parsed.positionals.join(' ').trim();
  if (positionalGoal) {
    return positionalGoal;
  }
  throw createStructuredCliError(
    'Goal is required. Pass --goal "<text>" or a positional goal.',
    CLI_EXIT_CODES.config,
    `command:${parsed.command}`
  );
}

function requireStringOption(value: string | boolean | undefined, flagName: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  throw createStructuredCliError(`${flagName} is required.`, CLI_EXIT_CODES.config, 'requireStringOption');
}

function getBaseUrl(config: CliConfig): string {
  return `http://127.0.0.1:${config.controlPort}/api`;
}

function getRequiredModels(
  command: CommandName | undefined,
  config: CliConfig
): Array<{ label: 'Planner model' | 'Executor model'; value: string; key: 'plannerModel' | 'executorModel' }> {
  const models: Array<{
    label: 'Planner model' | 'Executor model';
    value: string;
    key: 'plannerModel' | 'executorModel';
  }> = [];

  if ((command === 'submit' || command === 'resume' || command === 'run') && config.plannerModel.trim()) {
    models.push({ label: 'Planner model', value: config.plannerModel.trim(), key: 'plannerModel' });
  }

  if ((command === 'approve' || command === 'run') && config.executorModel.trim()) {
    models.push({ label: 'Executor model', value: config.executorModel.trim(), key: 'executorModel' });
  }

  return models;
}

function suggestModels(requestedModel: string, availableModels: string[]): string[] {
  const requestedSuffix = requestedModel.split('/').pop()?.toLowerCase() ?? requestedModel.toLowerCase();
  const requestedLower = requestedModel.toLowerCase();
  const ranked = availableModels
    .map((model) => {
      const lower = model.toLowerCase();
      const suffix = model.split('/').pop()?.toLowerCase() ?? lower;
      let score = 0;
      if (suffix === requestedSuffix) score += 4;
      else if (suffix.includes(requestedSuffix) || requestedSuffix.includes(suffix)) score += 3;
      if (lower.includes(requestedLower) || requestedLower.includes(lower)) score += 2;
      if (requestedSuffix.includes('gpt-') && suffix.includes('gpt-')) score += 1;
      return { model, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.model.localeCompare(right.model));

  return [...new Set(ranked.map((entry) => entry.model))];
}

function resolveCatalogModel(requestedModel: string, availableModels: string[]): string | null {
  const requested = requestedModel.trim().toLowerCase();
  for (const model of availableModels) {
    if (model.trim().toLowerCase() === requested) {
      return model;
    }
  }

  const suffix = requestedModel.split('/').pop()?.trim().toLowerCase();
  if (suffix) {
    for (const model of availableModels) {
      if (model.trim().toLowerCase() === suffix) {
        return model;
      }
    }
  }

  return null;
}

function outputResult(_payload: unknown, text: string): void {
  process.stdout.write(`${text}\n`);
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

export function isExecutedAsMain(importMetaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) {
    return false;
  }

  try {
    const modulePath = realpathSync(fileURLToPath(importMetaUrl));
    const entryPath = realpathSync(argv1);
    return modulePath === entryPath;
  } catch {
    return importMetaUrl === new URL(argv1, 'file://').href;
  }
}

if (isExecutedAsMain(import.meta.url, process.argv[1])) {
  void main();
}
