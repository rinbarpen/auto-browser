import { describe, expect, it } from 'vitest';
import { ensureManagedConversationId } from './conversation-manager.js';

describe('ensureManagedConversationId', () => {
  it('creates a new conversation when none exist yet', async () => {
    const calls: string[] = [];
    const conversationId = await ensureManagedConversationId([], async () => {
      calls.push('create');
      return {
        id: 'conv_newest',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:00:00.000Z',
        messages: [],
      };
    });

    expect(conversationId).toBe('conv_newest');
    expect(calls).toEqual(['create']);
  });

  it('reuses the most recently created conversation when history exists', async () => {
    const conversationId = await ensureManagedConversationId(
      [
        {
          id: 'conv_old',
          createdAt: '2026-04-09T09:00:00.000Z',
          updatedAt: '2026-04-12T09:00:00.000Z',
          messages: [],
        },
        {
          id: 'conv_new',
          createdAt: '2026-04-10T09:00:00.000Z',
          updatedAt: '2026-04-11T09:00:00.000Z',
          messages: [],
        },
      ],
      async () => {
        throw new Error('should not create a new conversation');
      }
    );

    expect(conversationId).toBe('conv_old');
  });
});
