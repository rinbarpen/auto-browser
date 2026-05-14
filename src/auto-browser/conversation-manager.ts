interface ConversationSummary {
  id: string;
  createdAt: string;
  updatedAt?: string;
}

interface CreatedConversation {
  id: string;
  createdAt: string;
  updatedAt?: string;
  messages: unknown[];
}

export async function ensureManagedConversationId(
  conversations: ConversationSummary[],
  createConversation: () => Promise<CreatedConversation>
): Promise<string> {
  if (conversations.length === 0) {
    const created = await createConversation();
    return created.id;
  }

  const sorted = [...conversations].sort((left, right) => {
    const updatedDelta =
      new Date(right.updatedAt ?? right.createdAt).getTime() -
      new Date(left.updatedAt ?? left.createdAt).getTime();
    if (updatedDelta !== 0) {
      return updatedDelta;
    }
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });

  return sorted[0].id;
}
