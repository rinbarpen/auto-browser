import { config } from '../config.js';
import type { ExtractedResource, ResourceLink } from '../types.js';

export async function extractResourcesFromPage(snapshot: string, html: string): Promise<ExtractedResource[]> {
  const apiKey = config.openrouter.apiKey;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
  const content = `Snapshot:\n${snapshot.slice(0, 8000)}\n\nHTML:\n${html.slice(0, 12000)}`;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: config.openrouter.model,
      messages: [
        { role: 'system', content: 'Extract cloud storage links, extractCode, unzipPassword. Output JSON: {"items":[{"title":"","links":[{"url":"","platform":"baidu|aliyun|other","extractCode":"","unzipPassword":""}],"extractCode":"","unzipPassword":"","context":""}]}' },
        { role: 'user', content },
      ],
      temperature: 0.1,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter error: ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content ?? '';
  return parseResponse(text);
}

function parseResponse(text: string): ExtractedResource[] {
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let parsed: { items?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(cleaned) as { items?: Array<Record<string, unknown>> };
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    parsed = m ? (JSON.parse(m[0]) as { items?: Array<Record<string, unknown>> }) : { items: [] };
  }
  const items = parsed.items ?? [];
  const result: ExtractedResource[] = [];
  for (const item of items) {
    const links = (item.links as ResourceLink[] | undefined) ?? [];
    const ec = item.extractCode as string | undefined;
    const up = item.unzipPassword as string | undefined;
    const nl: ResourceLink[] = links.map((l) => ({
      url: typeof l.url === 'string' ? l.url : '',
      platform: ['baidu', 'aliyun', 'other'].includes(String(l.platform)) ? (l.platform as ResourceLink['platform']) : 'other',
      extractCode: l.extractCode ?? ec,
      unzipPassword: l.unzipPassword ?? up,
    }));
    result.push({
      title: (item.title as string) ?? '',
      links: nl.filter((l) => l.url),
      extractCode: ec,
      unzipPassword: up,
      context: (item.context as string) ?? '',
    });
  }
  return result;
}
