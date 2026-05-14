import type { FlowStepDefinition, RawRecordedEvent } from './types';

export function deriveStepsFromRawEvents(events: RawRecordedEvent[]): FlowStepDefinition[] {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const steps: FlowStepDefinition[] = [];

  if (sorted.length > 0 && sorted[0].type !== 'navigate') {
    steps.push({
      id: `step-open-${sorted[0].id}`,
      type: 'open',
      label: 'Open recorded page',
      target: null,
      input: { url: sorted[0].pageUrl },
      timeoutMs: 30000,
      enabled: true,
    });
  }

  for (const event of sorted) {
    const previousStep = steps.at(-1);

    if (
      event.type === 'input' &&
      previousStep?.type === 'click' &&
      sameTarget(previousStep.target, event.target ?? null)
    ) {
      steps[steps.length - 1] = {
        ...previousStep,
        type: 'fill',
        label: `Fill ${event.target?.descriptor ?? event.target?.locator.value ?? 'field'}`,
        input: {
          value: event.value ?? '',
        },
      };
      continue;
    }

    if (
      event.type === 'input' &&
      previousStep?.type === 'fill' &&
      sameTarget(previousStep.target, event.target ?? null)
    ) {
      steps[steps.length - 1] = {
        ...previousStep,
        input: {
          value: event.value ?? '',
        },
      };
      continue;
    }

    steps.push(toStep(event));
  }

  return steps;
}

function toStep(event: RawRecordedEvent): FlowStepDefinition {
  switch (event.type) {
    case 'navigate':
      return {
        id: stepId(event),
        type: 'open',
        label: 'Open page',
        target: null,
        input: {
          url: event.value ?? event.pageUrl,
        },
        timeoutMs: 30000,
        enabled: true,
      };
    case 'click':
      return {
        id: stepId(event),
        type: 'click',
        label: `Click ${event.target?.descriptor ?? event.target?.locator.value ?? 'element'}`,
        target: event.target ?? null,
        input: {},
        timeoutMs: 30000,
        enabled: true,
      };
    case 'input':
      return {
        id: stepId(event),
        type: 'fill',
        label: `Fill ${event.target?.descriptor ?? event.target?.locator.value ?? 'field'}`,
        target: event.target ?? null,
        input: {
          value: event.value ?? '',
        },
        timeoutMs: 30000,
        enabled: true,
      };
    case 'press':
      return {
        id: stepId(event),
        type: 'press',
        label: `Press ${event.key ?? 'key'}`,
        target: event.target ?? null,
        input: {
          key: event.key ?? '',
        },
        timeoutMs: 10000,
        enabled: true,
      };
    case 'wait_for':
      return {
        id: stepId(event),
        type: 'wait',
        label: `Wait for ${event.value ?? 'condition'}`,
        target: event.target ?? null,
        input: {
          text: event.value ?? '',
        },
        timeoutMs: 10000,
        enabled: true,
      };
    case 'select':
      return {
        id: stepId(event),
        type: 'select',
        label: `Select ${event.value ?? 'option'}`,
        target: event.target ?? null,
        input: {
          value: event.value ?? '',
        },
        timeoutMs: 30000,
        enabled: true,
      };
    case 'check':
    case 'uncheck':
      return {
        id: stepId(event),
        type: event.type,
        label: `${event.type === 'check' ? 'Check' : 'Uncheck'} ${event.target?.descriptor ?? event.target?.locator.value ?? 'option'}`,
        target: event.target ?? null,
        input: {},
        timeoutMs: 30000,
        enabled: true,
      };
  }
}

function sameTarget(
  left: FlowStepDefinition['target'],
  right: RawRecordedEvent['target'] | null
): boolean {
  if (!left || !right) return false;
  return (
    left.locator.kind === right.locator.kind &&
    left.locator.value === right.locator.value &&
    left.locator.name === right.locator.name
  );
}

function stepId(event: RawRecordedEvent): string {
  return `step-${event.id}`;
}
