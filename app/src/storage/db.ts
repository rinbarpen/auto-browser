import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import type { Resource } from '../types.js';

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    const dbPath = path.resolve(config.db.path);
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        sourceUrl TEXT NOT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        links TEXT NOT NULL,
        qrContent TEXT,
        context TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        contentHash TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_resources_hash ON resources(contentHash);
      CREATE INDEX IF NOT EXISTS idx_resources_category ON resources(category);
      CREATE INDEX IF NOT EXISTS idx_resources_created ON resources(createdAt);
    `);
  }
  return db;
}

export function insertResource(resource: Resource): void {
  const database = getDb();
  database.prepare(`
    INSERT INTO resources (id, sourceUrl, title, category, links, qrContent, context, createdAt, contentHash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    resource.id,
    resource.sourceUrl,
    resource.title,
    resource.category,
    JSON.stringify(resource.links),
    resource.qrContent ?? null,
    resource.context,
    resource.createdAt,
    resource.contentHash
  );
}

export function existsByHash(hash: string): boolean {
  const row = getDb().prepare('SELECT 1 FROM resources WHERE contentHash = ?').get(hash);
  return !!row;
}

export function findAll(options?: { category?: string; limit?: number; offset?: number }): Resource[] {
  const database = getDb();
  let sql = 'SELECT * FROM resources';
  const params: (string | number)[] = [];
  if (options?.category) {
    sql += ' WHERE category = ?';
    params.push(options.category);
  }
  sql += ' ORDER BY createdAt DESC';
  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }
  if (options?.offset) {
    sql += ' OFFSET ?';
    params.push(options.offset);
  }
  const rows = database.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToResource);
}

export function findById(id: string): Resource | null {
  const row = getDb().prepare('SELECT * FROM resources WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToResource(row) : null;
}

function rowToResource(row: Record<string, unknown>): Resource {
  return {
    id: row.id as string,
    sourceUrl: row.sourceUrl as string,
    title: row.title as string,
    category: row.category as string,
    links: JSON.parse(row.links as string),
    qrContent: row.qrContent as string | undefined,
    context: row.context as string,
    createdAt: row.createdAt as string,
    contentHash: row.contentHash as string,
  };
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
