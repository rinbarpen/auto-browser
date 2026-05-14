import { nanoid } from 'nanoid';
import type { FlowDefinition } from './types';

export function makeDefaultFlow(input?: Partial<Pick<FlowDefinition, 'name' | 'startUrl'>>): FlowDefinition {
  const now = new Date().toISOString();
  const id = nanoid();
  const startUrl = input?.startUrl?.trim() || 'https://example.com';
  return {
    id,
    name: input?.name?.trim() || 'New automation flow',
    startUrl,
    sessionConfig: {
      sessionName: `flow-${id}`,
      viewport: { width: 1440, height: 900 },
      headless: false,
      profile: null,
    },
    steps: [
      {
        id: nanoid(),
        type: 'open',
        label: 'Open start page',
        enabled: true,
        timeoutMs: 30000,
        target: null,
        input: { url: startUrl },
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}
