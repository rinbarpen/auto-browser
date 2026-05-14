import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type {
  FlowDefinition,
  FlowRunRecord,
  FlowRunStepRecord,
  RunEventRecord,
  WorkbenchStore,
  BrowserInstanceRecord,
  CookieJarRecord,
  CookieRecord,
  LlmSettingsRecord,
  LlmRole,
  LlmPreset,
  LlmProviderPreset,
  PublicLlmPreset,
  PublicLlmProviderPreset,
  PublicLlmSettingsRecord,
} from './types';

const LLM_ROLES: LlmRole[] = ['planner', 'executor', 'vision'];
const KEEP_API_KEY = '__KEEP__';

export function createWorkbenchStore(options: { dbPath: string }): WorkbenchStore {
  const dir = path.dirname(options.dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(options.dbPath);
  migrate(db);

  return {
    saveFlow(flow) {
      db.prepare(
        `
          INSERT INTO flows (id, name, startUrl, sessionConfig, steps, createdAt, updatedAt)
          VALUES (@id, @name, @startUrl, @sessionConfig, @steps, @createdAt, @updatedAt)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            startUrl = excluded.startUrl,
            sessionConfig = excluded.sessionConfig,
            steps = excluded.steps,
            updatedAt = excluded.updatedAt
        `
      ).run({
        id: flow.id,
        name: flow.name,
        startUrl: flow.startUrl,
        sessionConfig: JSON.stringify(flow.sessionConfig),
        steps: JSON.stringify(flow.steps),
        createdAt: flow.createdAt,
        updatedAt: flow.updatedAt,
      });
    },

    listFlows() {
      const rows = db
        .prepare('SELECT * FROM flows ORDER BY updatedAt DESC')
        .all() as Array<Record<string, unknown>>;
      return rows.map(rowToFlow);
    },

    getFlow(id) {
      const row = db.prepare('SELECT * FROM flows WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? rowToFlow(row) : null;
    },

    createRun(run) {
      db.prepare(
        `
          INSERT INTO flow_runs (
            id, flowId, sessionId, status, startedAt, finishedAt, currentStepId, errorSummary
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        run.id,
        run.flowId,
        run.sessionId,
        run.status,
        run.startedAt,
        run.finishedAt,
        run.currentStepId,
        run.errorSummary
      );
    },

    updateRun(runId, patch) {
      const current = db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined;
      if (!current) return;
      const next = { ...current, ...patch };
      db.prepare(
        `
          UPDATE flow_runs
          SET sessionId = ?, status = ?, startedAt = ?, finishedAt = ?, currentStepId = ?, errorSummary = ?
          WHERE id = ?
        `
      ).run(
        next.sessionId,
        next.status,
        next.startedAt,
        next.finishedAt,
        next.currentStepId,
        next.errorSummary,
        runId
      );
    },

    upsertRunStep(step) {
      db.prepare(
        `
          INSERT INTO flow_run_steps (
            runId, stepId, status, startedAt, finishedAt, durationMs, pageUrl, screenshotPath, inputSnapshot, message, errorDetail
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(runId, stepId) DO UPDATE SET
            status = excluded.status,
            startedAt = excluded.startedAt,
            finishedAt = excluded.finishedAt,
            durationMs = excluded.durationMs,
            pageUrl = excluded.pageUrl,
            screenshotPath = excluded.screenshotPath,
            inputSnapshot = excluded.inputSnapshot,
            message = excluded.message,
            errorDetail = excluded.errorDetail
        `
      ).run(
        step.runId,
        step.stepId,
        step.status,
        step.startedAt,
        step.finishedAt,
        step.durationMs,
        step.pageUrl,
        step.screenshotPath,
        JSON.stringify(step.inputSnapshot),
        step.message,
        step.errorDetail
      );
    },

    appendRunEvent(event) {
      db.prepare(
        `
          INSERT INTO flow_run_events (id, runId, type, createdAt, payload)
          VALUES (?, ?, ?, ?, ?)
        `
      ).run(event.id, event.runId, event.type, event.createdAt, JSON.stringify(event.payload));
    },

    getRunWithDetails(runId) {
      const runRow = db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined;
      if (!runRow) return null;

      const stepRows = db
        .prepare('SELECT * FROM flow_run_steps WHERE runId = ? ORDER BY startedAt IS NULL, startedAt ASC, stepId ASC')
        .all(runId) as Array<Record<string, unknown>>;
      const eventRows = db
        .prepare('SELECT * FROM flow_run_events WHERE runId = ? ORDER BY createdAt ASC, id ASC')
        .all(runId) as Array<Record<string, unknown>>;

      return {
        run: rowToRun(runRow),
        steps: stepRows.map(rowToRunStep),
        events: eventRows.map(rowToRunEvent),
      };
    },

    listBrowserInstances() {
      const rows = db
        .prepare('SELECT * FROM browser_instances ORDER BY updatedAt DESC')
        .all() as Array<Record<string, unknown>>;
      return rows.map(rowToBrowserInstance);
    },

    getBrowserInstance(id) {
      const row = db.prepare('SELECT * FROM browser_instances WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      return row ? rowToBrowserInstance(row) : null;
    },

    saveBrowserInstance(instance) {
      db.prepare(
        `
          INSERT INTO browser_instances (
            id, name, status, startUrl, mode, browserFamily, executablePath, profilePath, cookieJarId, viewport, headless, createdAt, updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            status = excluded.status,
            startUrl = excluded.startUrl,
            mode = excluded.mode,
            browserFamily = excluded.browserFamily,
            executablePath = excluded.executablePath,
            profilePath = excluded.profilePath,
            cookieJarId = excluded.cookieJarId,
            viewport = excluded.viewport,
            headless = excluded.headless,
            updatedAt = excluded.updatedAt
        `
      ).run(
        instance.id,
        instance.name,
        instance.status,
        instance.startUrl,
        instance.mode,
        instance.browserFamily,
        instance.executablePath,
        instance.profilePath,
        instance.cookieJarId,
        JSON.stringify(instance.viewport),
        instance.headless ? 1 : 0,
        instance.createdAt,
        instance.updatedAt
      );
    },

    updateBrowserInstance(id, patch) {
      const current = this.getBrowserInstance(id);
      if (!current) return;
      this.saveBrowserInstance({
        ...current,
        ...patch,
        updatedAt: patch.updatedAt ?? new Date().toISOString(),
      });
    },

    deleteBrowserInstance(id) {
      db.prepare('DELETE FROM browser_instances WHERE id = ?').run(id);
    },

    listCookieJars() {
      const rows = db
        .prepare(
          `
            SELECT cookie_jars.*, COUNT(cookies.id) AS cookieCount
            FROM cookie_jars
            LEFT JOIN cookies ON cookies.jarId = cookie_jars.id
            GROUP BY cookie_jars.id
            ORDER BY cookie_jars.updatedAt DESC
          `
        )
        .all() as Array<Record<string, unknown>>;
      return rows.map((row) => ({ ...rowToCookieJar(row), cookieCount: Number(row.cookieCount ?? 0) }));
    },

    getCookieJar(id) {
      const row = db.prepare('SELECT * FROM cookie_jars WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      const cookieRows = db
        .prepare('SELECT * FROM cookies WHERE jarId = ? ORDER BY domain ASC, path ASC, name ASC')
        .all(id) as Array<Record<string, unknown>>;
      return {
        ...rowToCookieJar(row),
        cookies: cookieRows.map(rowToCookie),
      };
    },

    saveCookieJar(jar) {
      db.prepare(
        `
          INSERT INTO cookie_jars (id, name, site, account, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            site = excluded.site,
            account = excluded.account,
            updatedAt = excluded.updatedAt
        `
      ).run(jar.id, jar.name, jar.site, jar.account, jar.createdAt, jar.updatedAt);
    },

    deleteCookieJar(id) {
      return db.transaction(() => {
        db.prepare('DELETE FROM cookies WHERE jarId = ?').run(id);
        return db.prepare('DELETE FROM cookie_jars WHERE id = ?').run(id).changes > 0;
      })();
    },

    replaceCookies(jarId, cookies) {
      const replace = db.transaction((items: CookieRecord[]) => {
        db.prepare('DELETE FROM cookies WHERE jarId = ?').run(jarId);
        const insert = db.prepare(
          `
            INSERT INTO cookies (
              id, jarId, name, value, domain, path, expires, httpOnly, secure, sameSite, url, createdAt, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        );
        for (const cookie of items) {
          insert.run(
            cookie.id,
            jarId,
            cookie.name,
            cookie.value,
            cookie.domain,
            cookie.path,
            cookie.expires,
            cookie.httpOnly ? 1 : 0,
            cookie.secure ? 1 : 0,
            cookie.sameSite,
            cookie.url,
            cookie.createdAt,
            cookie.updatedAt
          );
        }
        db.prepare('UPDATE cookie_jars SET updatedAt = ? WHERE id = ?').run(new Date().toISOString(), jarId);
      });
      replace(cookies);
    },

    listLlmSettings() {
      const activePreset = getActiveLlmPreset(db);
      return activePreset ? LLM_ROLES.map((role) => publicRole(activePreset.roles[role])) : [];
    },

    getLlmSettings(role) {
      const activePreset = getActiveLlmPreset(db);
      return activePreset?.roles[role] ?? null;
    },

    upsertLlmSettings(settings) {
      const activePreset = ensureActiveLlmPreset(db, settings.updatedAt);
      upsertPresetRole(db, activePreset.id, settings);
      db.prepare('UPDATE llm_presets SET updatedAt = ? WHERE id = ?').run(settings.updatedAt, activePreset.id);
    },

    listLlmProviderPresets() {
      return listPublicProviderPresets(db);
    },

    createLlmProviderPreset(input) {
      upsertProviderPreset(db, input);
      return getPublicProviderPreset(db, input.id)!;
    },

    updateLlmProviderPreset(id, patch) {
      const current = getProviderPreset(db, id);
      if (!current) return null;
      upsertProviderPreset(db, {
        ...current,
        name: patch.name ?? current.name,
        provider: patch.provider ?? current.provider,
        baseUrl: patch.baseUrl ?? current.baseUrl,
        apiKey: patch.apiKey === KEEP_API_KEY || patch.apiKey === undefined ? current.apiKey : patch.apiKey,
        updatedAt: patch.updatedAt,
      });
      return getPublicProviderPreset(db, id);
    },

    deleteLlmProviderPreset(id) {
      const count = db.prepare('SELECT COUNT(*) AS count FROM llm_provider_presets').get() as { count: number };
      if (count.count <= 1) return false;
      const usage = db
        .prepare('SELECT COUNT(*) AS count FROM llm_preset_roles WHERE providerPresetId = ?')
        .get(id) as { count: number };
      if (usage.count > 0) return false;
      return db.prepare('DELETE FROM llm_provider_presets WHERE id = ?').run(id).changes > 0;
    },

    listLlmPresets() {
      const presets = listPublicLlmPresets(db);
      return {
        presets,
        activePresetId: presets.find((preset) => preset.active)?.id ?? null,
      };
    },

    createLlmPreset(input) {
      const insert = db.transaction(() => {
        db.prepare('UPDATE llm_presets SET active = 0').run();
        db.prepare(
          'INSERT INTO llm_presets (id, name, active, createdAt, updatedAt) VALUES (?, ?, 1, ?, ?)'
        ).run(input.id, input.name, input.createdAt, input.updatedAt);
        for (const role of LLM_ROLES) {
          upsertPresetRole(db, input.id, input.roles[role]);
        }
      });
      insert();
      return getPublicLlmPreset(db, input.id)!;
    },

    updateLlmPreset(id, patch) {
      const current = getLlmPreset(db, id);
      if (!current) return null;
      const update = db.transaction(() => {
        db.prepare('UPDATE llm_presets SET name = ?, active = 1, updatedAt = ? WHERE id = ?').run(
          patch.name ?? current.name,
          patch.updatedAt,
          id
        );
        db.prepare('UPDATE llm_presets SET active = 0 WHERE id != ?').run(id);
        for (const role of LLM_ROLES) {
          const next = patch.roles?.[role];
          if (next) {
            upsertPresetRole(db, id, { ...next, role, updatedAt: patch.updatedAt });
          }
        }
      });
      update();
      return getPublicLlmPreset(db, id);
    },

    activateLlmPreset(id, updatedAt) {
      if (!getLlmPreset(db, id)) return null;
      db.transaction(() => {
        db.prepare('UPDATE llm_presets SET active = 0').run();
        db.prepare('UPDATE llm_presets SET active = 1, updatedAt = ? WHERE id = ?').run(updatedAt, id);
      })();
      return getPublicLlmPreset(db, id);
    },

    deleteLlmPreset(id) {
      const count = db.prepare('SELECT COUNT(*) AS count FROM llm_presets').get() as { count: number };
      if (count.count <= 1) return false;
      const current = getLlmPreset(db, id);
      if (!current) return false;
      db.transaction(() => {
        db.prepare('DELETE FROM llm_preset_roles WHERE presetId = ?').run(id);
        db.prepare('DELETE FROM llm_presets WHERE id = ?').run(id);
        if (current.active) {
          const next = db
            .prepare('SELECT id FROM llm_presets ORDER BY updatedAt DESC LIMIT 1')
            .get() as { id: string } | undefined;
          if (next) {
            db.prepare('UPDATE llm_presets SET active = 1 WHERE id = ?').run(next.id);
          }
        }
      })();
      return true;
    },
  };
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS flows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      startUrl TEXT NOT NULL,
      sessionConfig TEXT NOT NULL,
      steps TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_flows_updatedAt ON flows(updatedAt DESC);

    CREATE TABLE IF NOT EXISTS flow_runs (
      id TEXT PRIMARY KEY,
      flowId TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      status TEXT NOT NULL,
      startedAt TEXT NOT NULL,
      finishedAt TEXT,
      currentStepId TEXT,
      errorSummary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_flow_runs_flowId ON flow_runs(flowId);
    CREATE INDEX IF NOT EXISTS idx_flow_runs_startedAt ON flow_runs(startedAt DESC);

    CREATE TABLE IF NOT EXISTS flow_run_steps (
      runId TEXT NOT NULL,
      stepId TEXT NOT NULL,
      status TEXT NOT NULL,
      startedAt TEXT,
      finishedAt TEXT,
      durationMs INTEGER,
      pageUrl TEXT,
      screenshotPath TEXT,
      inputSnapshot TEXT,
      message TEXT,
      errorDetail TEXT,
      PRIMARY KEY (runId, stepId)
    );

    CREATE TABLE IF NOT EXISTS flow_run_events (
      id TEXT PRIMARY KEY,
      runId TEXT NOT NULL,
      type TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_flow_run_events_runId ON flow_run_events(runId, createdAt ASC);

    CREATE TABLE IF NOT EXISTS browser_instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      startUrl TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'managed',
      browserFamily TEXT NOT NULL DEFAULT 'chromium',
      executablePath TEXT NOT NULL DEFAULT '',
      profilePath TEXT,
      cookieJarId TEXT,
      viewport TEXT NOT NULL,
      headless INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_browser_instances_updatedAt ON browser_instances(updatedAt DESC);

    CREATE TABLE IF NOT EXISTS cookie_jars (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      site TEXT NOT NULL,
      account TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cookie_jars_updatedAt ON cookie_jars(updatedAt DESC);

    CREATE TABLE IF NOT EXISTS cookies (
      id TEXT PRIMARY KEY,
      jarId TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      domain TEXT,
      path TEXT,
      expires REAL,
      httpOnly INTEGER NOT NULL,
      secure INTEGER NOT NULL,
      sameSite TEXT,
      url TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cookies_jarId ON cookies(jarId);

    CREATE TABLE IF NOT EXISTS llm_settings (
      role TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      baseUrl TEXT NOT NULL,
      apiKey TEXT NOT NULL,
      model TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_preset_roles (
      presetId TEXT NOT NULL,
      role TEXT NOT NULL,
      providerPresetId TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL,
      baseUrl TEXT NOT NULL,
      apiKey TEXT NOT NULL,
      model TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (presetId, role)
    );
  `);
  ensureColumn(db, 'browser_instances', 'mode', "TEXT NOT NULL DEFAULT 'managed'");
  ensureColumn(db, 'browser_instances', 'browserFamily', "TEXT NOT NULL DEFAULT 'chromium'");
  ensureColumn(db, 'browser_instances', 'executablePath', "TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_provider_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      baseUrl TEXT NOT NULL,
      apiKey TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
  ensureColumn(db, 'llm_preset_roles', 'providerPresetId', "TEXT NOT NULL DEFAULT ''");
  migrateLegacyLlmSettings(db);
  migrateLlmProviderPresets(db);
}

function ensureColumn(db: Database.Database, tableName: string, columnName: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) return;
  db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
}

function rowToFlow(row: Record<string, unknown>): FlowDefinition {
  return {
    id: row.id as string,
    name: row.name as string,
    startUrl: row.startUrl as string,
    sessionConfig: JSON.parse(row.sessionConfig as string),
    steps: JSON.parse(row.steps as string),
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function rowToRun(row: Record<string, unknown>): FlowRunRecord {
  return {
    id: row.id as string,
    flowId: row.flowId as string,
    sessionId: row.sessionId as string,
    status: row.status as FlowRunRecord['status'],
    startedAt: row.startedAt as string,
    finishedAt: (row.finishedAt as string | null) ?? null,
    currentStepId: (row.currentStepId as string | null) ?? null,
    errorSummary: (row.errorSummary as string | null) ?? null,
  };
}

function rowToRunStep(row: Record<string, unknown>): FlowRunStepRecord {
  return {
    runId: row.runId as string,
    stepId: row.stepId as string,
    status: row.status as FlowRunStepRecord['status'],
    startedAt: (row.startedAt as string | null) ?? null,
    finishedAt: (row.finishedAt as string | null) ?? null,
    durationMs: (row.durationMs as number | null) ?? null,
    pageUrl: (row.pageUrl as string | null) ?? null,
    screenshotPath: (row.screenshotPath as string | null) ?? null,
    inputSnapshot: row.inputSnapshot ? JSON.parse(row.inputSnapshot as string) : null,
    message: (row.message as string | null) ?? null,
    errorDetail: (row.errorDetail as string | null) ?? null,
  };
}

function rowToRunEvent(row: Record<string, unknown>): RunEventRecord {
  return {
    id: row.id as string,
    runId: row.runId as string,
    type: row.type as RunEventRecord['type'],
    createdAt: row.createdAt as string,
    payload: JSON.parse(row.payload as string),
  };
}

function rowToBrowserInstance(row: Record<string, unknown>): BrowserInstanceRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    status: row.status as BrowserInstanceRecord['status'],
    startUrl: row.startUrl as string,
    mode: ((row.mode as string | null) ?? 'managed') as BrowserInstanceRecord['mode'],
    browserFamily: ((row.browserFamily as string | null) ?? 'chromium') as BrowserInstanceRecord['browserFamily'],
    executablePath: (row.executablePath as string | null) ?? '',
    profilePath: (row.profilePath as string | null) ?? null,
    cookieJarId: (row.cookieJarId as string | null) ?? null,
    viewport: JSON.parse(row.viewport as string),
    headless: Boolean(row.headless),
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function rowToCookieJar(row: Record<string, unknown>): CookieJarRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    site: row.site as string,
    account: (row.account as string | null) ?? null,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function rowToCookie(row: Record<string, unknown>): CookieRecord {
  return {
    id: row.id as string,
    jarId: row.jarId as string,
    name: row.name as string,
    value: row.value as string,
    domain: (row.domain as string | null) ?? null,
    path: (row.path as string | null) ?? null,
    expires: (row.expires as number | null) ?? null,
    httpOnly: Boolean(row.httpOnly),
    secure: Boolean(row.secure),
    sameSite: (row.sameSite as CookieRecord['sameSite']) ?? null,
    url: (row.url as string | null) ?? null,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function migrateLegacyLlmSettings(db: Database.Database): void {
  const presetCount = db.prepare('SELECT COUNT(*) AS count FROM llm_presets').get() as { count: number };
  if (presetCount.count > 0) return;

  const rows = db
    .prepare('SELECT * FROM llm_settings ORDER BY role ASC')
    .all() as Array<Record<string, unknown>>;
  if (rows.length === 0) return;

  const now =
    rows
      .map((row) => row.updatedAt as string)
      .filter(Boolean)
      .sort()
      .at(-1) ?? new Date().toISOString();
  const presetId = 'default';
  db.prepare('INSERT INTO llm_presets (id, name, active, createdAt, updatedAt) VALUES (?, ?, 1, ?, ?)').run(
    presetId,
    'Default',
    now,
    now
  );
  const byRole = new Map(rows.map((row) => [row.role as LlmRole, rowToLlmSettings(row)]));
  for (const role of LLM_ROLES) {
    upsertPresetRole(db, presetId, byRole.get(role) ?? defaultLlmRoleSettings(role, now));
  }
}

function migrateLlmProviderPresets(db: Database.Database): void {
  const roleRows = db
    .prepare('SELECT presetId, role, providerPresetId, provider, baseUrl, apiKey, updatedAt FROM llm_preset_roles')
    .all() as Array<Record<string, unknown>>;
  if (roleRows.length === 0) {
    ensureDefaultProviderPreset(db, new Date().toISOString());
    return;
  }

  const existing = db
    .prepare('SELECT * FROM llm_provider_presets')
    .all() as Array<Record<string, unknown>>;
  const byKey = new Map(existing.map((row) => [providerKey(row.provider as string, row.baseUrl as string, row.apiKey as string), row.id as string]));
  let nextIndex = existing.length + 1;

  for (const row of roleRows) {
    const currentId = String(row.providerPresetId ?? '').trim();
    if (currentId && getProviderPreset(db, currentId)) continue;
    const key = providerKey(String(row.provider ?? ''), String(row.baseUrl ?? ''), String(row.apiKey ?? ''));
    let providerPresetId = byKey.get(key);
    if (!providerPresetId) {
      const createdAt = String(row.updatedAt ?? new Date().toISOString());
      providerPresetId = `provider-${nextIndex++}`;
      byKey.set(key, providerPresetId);
      upsertProviderPreset(db, {
        id: providerPresetId,
        name: String(row.provider ?? '').trim() || `Provider ${nextIndex - 1}`,
        provider: String(row.provider ?? 'llm-router'),
        baseUrl: String(row.baseUrl ?? 'http://127.0.0.1:18000/v1'),
        apiKey: String(row.apiKey ?? ''),
        createdAt,
        updatedAt: createdAt,
      });
    }
    db.prepare('UPDATE llm_preset_roles SET providerPresetId = ? WHERE presetId = ? AND role = ?').run(
      providerPresetId,
      row.presetId,
      row.role
    );
  }
}

function defaultLlmRoleSettings(role: LlmRole, updatedAt: string): LlmSettingsRecord {
  const providerPresetId = 'default-provider';
  return {
    role,
    providerPresetId,
    provider: 'llm-router',
    baseUrl: 'http://127.0.0.1:18000/v1',
    apiKey: '',
    model: role === 'vision' ? '' : 'openai/gpt-4o',
    enabled: role !== 'vision',
    updatedAt,
  };
}

function ensureActiveLlmPreset(db: Database.Database, now = new Date().toISOString()): LlmPreset {
  ensureDefaultProviderPreset(db, now);
  const activePreset = getActiveLlmPreset(db);
  if (activePreset) return activePreset;

  const id = 'default';
  db.prepare(
    `
      INSERT INTO llm_presets (id, name, active, createdAt, updatedAt)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET active = 1, updatedAt = excluded.updatedAt
    `
  ).run(id, 'Default', now, now);
  for (const role of LLM_ROLES) {
    upsertPresetRole(db, id, defaultLlmRoleSettings(role, now));
  }
  return getLlmPreset(db, id)!;
}

function getActiveLlmPreset(db: Database.Database): LlmPreset | null {
  const row = db
    .prepare('SELECT * FROM llm_presets WHERE active = 1 ORDER BY updatedAt DESC LIMIT 1')
    .get() as Record<string, unknown> | undefined;
  return row ? rowToLlmPreset(db, row) : null;
}

function getLlmPreset(db: Database.Database, id: string): LlmPreset | null {
  const row = db.prepare('SELECT * FROM llm_presets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToLlmPreset(db, row) : null;
}

function getPublicLlmPreset(db: Database.Database, id: string): PublicLlmPreset | null {
  const preset = getLlmPreset(db, id);
  return preset ? publicPreset(preset) : null;
}

function listPublicLlmPresets(db: Database.Database): PublicLlmPreset[] {
  ensureActiveLlmPreset(db);
  const rows = db
    .prepare('SELECT * FROM llm_presets ORDER BY active DESC, updatedAt DESC')
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => publicPreset(rowToLlmPreset(db, row)));
}

function ensureDefaultProviderPreset(db: Database.Database, now: string): LlmProviderPreset {
  const existing = getProviderPreset(db, 'default-provider');
  if (existing) return existing;
  upsertProviderPreset(db, {
    id: 'default-provider',
    name: 'Local LLM router',
    provider: 'llm-router',
    baseUrl: 'http://127.0.0.1:18000/v1',
    apiKey: '',
    createdAt: now,
    updatedAt: now,
  });
  return getProviderPreset(db, 'default-provider')!;
}

function getProviderPreset(db: Database.Database, id: string): LlmProviderPreset | null {
  const row = db.prepare('SELECT * FROM llm_provider_presets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToProviderPreset(row) : null;
}

function getPublicProviderPreset(db: Database.Database, id: string): PublicLlmProviderPreset | null {
  const preset = getProviderPreset(db, id);
  return preset ? publicProviderPreset(preset) : null;
}

function listPublicProviderPresets(db: Database.Database): PublicLlmProviderPreset[] {
  ensureDefaultProviderPreset(db, new Date().toISOString());
  const rows = db
    .prepare('SELECT * FROM llm_provider_presets ORDER BY updatedAt DESC, name ASC')
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => publicProviderPreset(rowToProviderPreset(row)));
}

function upsertProviderPreset(db: Database.Database, preset: LlmProviderPreset): void {
  db.prepare(
    `
      INSERT INTO llm_provider_presets (id, name, provider, baseUrl, apiKey, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        provider = excluded.provider,
        baseUrl = excluded.baseUrl,
        apiKey = excluded.apiKey,
        updatedAt = excluded.updatedAt
    `
  ).run(preset.id, preset.name, preset.provider, preset.baseUrl, preset.apiKey, preset.createdAt, preset.updatedAt);
}

function providerKey(provider: string, baseUrl: string, apiKey: string): string {
  return `${provider}\n${baseUrl}\n${apiKey}`;
}

function rowToLlmPreset(db: Database.Database, row: Record<string, unknown>): LlmPreset {
  const roleRows = db
    .prepare('SELECT * FROM llm_preset_roles WHERE presetId = ?')
    .all(row.id as string) as Array<Record<string, unknown>>;
  const byRole = new Map(roleRows.map((roleRow) => [roleRow.role as LlmRole, rowToResolvedLlmSettings(db, roleRow)]));
  const roles = Object.fromEntries(
    LLM_ROLES.map((role) => [role, byRole.get(role) ?? defaultLlmRoleSettings(role, row.updatedAt as string)])
  ) as Record<LlmRole, LlmSettingsRecord>;
  return {
    id: row.id as string,
    name: row.name as string,
    active: Boolean(row.active),
    roles,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function upsertPresetRole(db: Database.Database, presetId: string, settings: LlmSettingsRecord): void {
  const current = db
    .prepare('SELECT apiKey, providerPresetId FROM llm_preset_roles WHERE presetId = ? AND role = ?')
    .get(presetId, settings.role) as { apiKey: string; providerPresetId: string } | undefined;
  const requestedProviderPresetId = settings.providerPresetId.trim();
  let providerPresetId = requestedProviderPresetId || current?.providerPresetId || '';
  if (!providerPresetId || !getProviderPreset(db, providerPresetId)) {
    providerPresetId = findOrCreateProviderPreset(db, settings);
  }
  let providerPreset = getProviderPreset(db, providerPresetId)!;
  if (!requestedProviderPresetId && settings.apiKey !== KEEP_API_KEY) {
    upsertProviderPreset(db, {
      ...providerPreset,
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      updatedAt: settings.updatedAt,
    });
    providerPreset = getProviderPreset(db, providerPresetId)!;
  }
  const apiKey = providerPreset.apiKey;
  db.prepare(
    `
      INSERT INTO llm_preset_roles (presetId, role, providerPresetId, provider, baseUrl, apiKey, model, enabled, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(presetId, role) DO UPDATE SET
        providerPresetId = excluded.providerPresetId,
        provider = excluded.provider,
        baseUrl = excluded.baseUrl,
        apiKey = excluded.apiKey,
        model = excluded.model,
        enabled = excluded.enabled,
        updatedAt = excluded.updatedAt
    `
  ).run(
    presetId,
    settings.role,
    providerPresetId,
    providerPreset.provider,
    providerPreset.baseUrl,
    apiKey,
    settings.model,
    settings.enabled ? 1 : 0,
    settings.updatedAt
  );
}

function findOrCreateProviderPreset(db: Database.Database, settings: LlmSettingsRecord): string {
  const apiKey = settings.apiKey === KEEP_API_KEY ? '' : settings.apiKey;
  const key = providerKey(settings.provider, settings.baseUrl, apiKey);
  const rows = db.prepare('SELECT * FROM llm_provider_presets').all() as Array<Record<string, unknown>>;
  const existing = rows.find((row) => providerKey(String(row.provider), String(row.baseUrl), String(row.apiKey)) === key);
  if (existing) return existing.id as string;
  const count = rows.length + 1;
  const now = settings.updatedAt;
  const id = count === 1 ? 'default-provider' : `provider-${count}`;
  upsertProviderPreset(db, {
    id,
    name: settings.provider || `Provider ${count}`,
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    apiKey,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function publicPreset(preset: LlmPreset): PublicLlmPreset {
  return {
    id: preset.id,
    name: preset.name,
    active: preset.active,
    roles: Object.fromEntries(LLM_ROLES.map((role) => [role, publicRole(preset.roles[role])])) as PublicLlmPreset['roles'],
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
  };
}

function publicRole(settings: LlmSettingsRecord): PublicLlmSettingsRecord {
  return {
    providerPresetId: settings.providerPresetId,
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    role: settings.role,
    enabled: settings.enabled,
    updatedAt: settings.updatedAt,
    hasApiKey: settings.apiKey.length > 0,
  };
}

function rowToLlmSettings(row: Record<string, unknown>): LlmSettingsRecord {
  const providerPresetId = String(row.providerPresetId ?? '');
  return {
    role: row.role as LlmSettingsRecord['role'],
    providerPresetId,
    provider: row.provider as string,
    baseUrl: row.baseUrl as string,
    apiKey: row.apiKey as string,
    model: row.model as string,
    enabled: Boolean(row.enabled),
    updatedAt: row.updatedAt as string,
  };
}

function rowToProviderPreset(row: Record<string, unknown>): LlmProviderPreset {
  return {
    id: row.id as string,
    name: row.name as string,
    provider: row.provider as string,
    baseUrl: row.baseUrl as string,
    apiKey: row.apiKey as string,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function publicProviderPreset(preset: LlmProviderPreset): PublicLlmProviderPreset {
  return {
    id: preset.id,
    name: preset.name,
    provider: preset.provider,
    baseUrl: preset.baseUrl,
    hasApiKey: preset.apiKey.length > 0,
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
  };
}

function rowToPublicLlmSettings(row: Record<string, unknown>): PublicLlmSettingsRecord {
  const settings = rowToLlmSettings(row);
  return publicRole(settings);
}

function rowToResolvedLlmSettings(db: Database.Database, row: Record<string, unknown>): LlmSettingsRecord {
  const settings = rowToLlmSettings(row);
  const providerPreset = settings.providerPresetId ? getProviderPreset(db, settings.providerPresetId) : null;
  return providerPreset
    ? {
        ...settings,
        provider: providerPreset.provider,
        baseUrl: providerPreset.baseUrl,
        apiKey: providerPreset.apiKey,
      }
    : settings;
}
