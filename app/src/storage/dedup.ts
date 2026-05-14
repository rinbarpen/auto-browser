import { createHash } from 'node:crypto';
import type { ResourceLink } from '../types.js';
import { existsByHash } from './db.js';

export function computeContentHash(link: ResourceLink): string {
  const str = `${link.url}|${link.extractCode ?? ''}|${link.unzipPassword ?? ''}`;
  return createHash('sha256').update(str).digest('hex');
}

export function isDuplicate(hash: string): boolean {
  return existsByHash(hash);
}
