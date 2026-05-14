export interface ErrorContext {
  module: string;
  file: string;
  location: string;
  problem: string;
}

type ErrorContextDefaults = Omit<ErrorContext, 'problem'> & {
  problem?: string;
};

export class ContextualError extends Error {
  readonly context: ErrorContext;
  override cause?: unknown;

  constructor(context: ErrorContext, cause?: unknown) {
    super(context.problem);
    this.name = 'ContextualError';
    this.context = context;
    this.cause = cause;
  }
}

export function isErrorContext(value: unknown): value is ErrorContext {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.module === 'string' &&
    typeof candidate.file === 'string' &&
    typeof candidate.location === 'string' &&
    typeof candidate.problem === 'string'
  );
}

export function extractErrorContext(error: unknown): ErrorContext | null {
  if (error instanceof ContextualError) {
    return error.context;
  }

  if (!error || typeof error !== 'object') {
    return null;
  }

  const candidate = error as Record<string, unknown>;
  if (isErrorContext(candidate.context)) {
    return candidate.context;
  }
  if (isErrorContext(candidate)) {
    return candidate;
  }
  return null;
}

export function wrapError(error: unknown, defaults: ErrorContextDefaults): ContextualError {
  const existing = extractErrorContext(error);
  const context: ErrorContext = {
    module: existing?.module ?? defaults.module,
    file: existing?.file ?? defaults.file,
    location: existing?.location ?? defaults.location,
    problem: defaults.problem?.trim() || existing?.problem || getErrorProblem(error),
  };

  if (
    error instanceof ContextualError &&
    error.context.module === context.module &&
    error.context.file === context.file &&
    error.context.location === context.location &&
    error.context.problem === context.problem
  ) {
    return error;
  }

  return new ContextualError(context, error);
}

export function getErrorProblem(error: unknown): string {
  const context = extractErrorContext(error);
  if (context) {
    return context.problem;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

export function formatError(error: unknown, defaults?: ErrorContextDefaults): string {
  const context = defaults ? wrapError(error, defaults).context : extractErrorContext(error);
  const resolved = context ?? {
    module: 'unknown',
    file: 'unknown',
    location: 'unknown',
    problem: getErrorProblem(error),
  };

  return [
    `module: ${resolved.module}`,
    `file: ${resolved.file}`,
    `location: ${resolved.location}`,
    `problem: ${resolved.problem}`,
  ].join('\n');
}

export function isStructuredErrorPayload(value: unknown): value is { error: ErrorContext } {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return isErrorContext(candidate.error);
}

export function toErrorPayload(error: unknown, defaults: ErrorContextDefaults): { error: ErrorContext } {
  return { error: wrapError(error, defaults).context };
}
