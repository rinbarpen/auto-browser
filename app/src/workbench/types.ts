export type LocatorKind = 'css' | 'role' | 'text' | 'label' | 'placeholder' | 'testid';

export interface StepLocator {
  kind: LocatorKind;
  value: string;
  name?: string;
  exact?: boolean;
}

export interface StepTarget {
  refHint?: string | null;
  locator: StepLocator;
  descriptor?: string | null;
}

export type FlowStepType =
  | 'open'
  | 'click'
  | 'fill'
  | 'press'
  | 'wait'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'assertText'
  | 'assertVisible';

export interface FlowStepDefinition {
  id: string;
  type: FlowStepType;
  label: string;
  target: StepTarget | null;
  input: Record<string, unknown>;
  timeoutMs: number;
  enabled: boolean;
}

export interface SessionConfig {
  sessionName: string;
  viewport: { width: number; height: number };
  headless: boolean;
  profile: string | null;
  cookieJarId?: string | null;
}

export interface FlowDefinition {
  id: string;
  name: string;
  startUrl: string;
  sessionConfig: SessionConfig;
  steps: FlowStepDefinition[];
  createdAt: string;
  updatedAt: string;
}

export type FlowRunStatus = 'queued' | 'running' | 'paused' | 'success' | 'failed' | 'canceled';

export interface FlowRunRecord {
  id: string;
  flowId: string;
  sessionId: string;
  status: FlowRunStatus;
  startedAt: string;
  finishedAt: string | null;
  currentStepId: string | null;
  errorSummary: string | null;
}

export type FlowRunStepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface FlowRunStepRecord {
  runId: string;
  stepId: string;
  status: FlowRunStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  pageUrl: string | null;
  screenshotPath: string | null;
  inputSnapshot: Record<string, unknown> | null;
  message: string | null;
  errorDetail: string | null;
}

export type RunEventType =
  | 'run_started'
  | 'run_pause_requested'
  | 'run_paused'
  | 'run_resumed'
  | 'run_canceled'
  | 'step_started'
  | 'step_succeeded'
  | 'step_failed'
  | 'screenshot_updated'
  | 'browser_status'
  | 'run_finished';

export interface RunEventRecord {
  id: string;
  runId: string;
  type: RunEventType;
  createdAt: string;
  payload: Record<string, unknown>;
}

export type RawRecordedEventType =
  | 'navigate'
  | 'click'
  | 'input'
  | 'press'
  | 'wait_for'
  | 'select'
  | 'check'
  | 'uncheck';

export interface RawRecordedEvent {
  id: string;
  sessionId: string;
  recordingId: string;
  type: RawRecordedEventType;
  timestamp: number;
  pageUrl: string;
  target?: StepTarget | null;
  value?: string;
  key?: string;
  meta?: Record<string, unknown>;
}

export interface RecordingDebugSnapshot {
  sessionId: string;
  pageUrl: string | null;
  recording: {
    id: string;
    events: RawRecordedEvent[];
    pendingInputTarget: StepTarget | null;
    hasPendingInputTimer: boolean;
    lastInputCaptureAt: number | null;
    lastInputCaptureError: string | null;
    lastCapturedInputValue: string | null;
  } | null;
  activeInput: {
    target: StepTarget;
    value: string;
  } | null;
}

export type BrowserInstanceStatus = 'stopped' | 'starting' | 'running' | 'failed';
export type BrowserInstanceMode = 'managed' | 'system';
export type BrowserInstanceFamily = 'chromium' | 'chrome' | 'edge';

export interface BrowserInstanceRecord {
  id: string;
  name: string;
  status: BrowserInstanceStatus;
  startUrl: string;
  mode: BrowserInstanceMode;
  browserFamily: BrowserInstanceFamily;
  executablePath: string;
  profilePath: string | null;
  cookieJarId: string | null;
  viewport: { width: number; height: number };
  headless: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserInstanceCandidate {
  id: string;
  name: string;
  startUrl: string;
  mode: BrowserInstanceMode;
  browserFamily: BrowserInstanceFamily;
  executablePath: string;
  profilePath: string | null;
  viewport: { width: number; height: number };
  headless: boolean;
  detected: boolean;
  message: string;
  importedInstanceId?: string;
}

export interface CookieJarRecord {
  id: string;
  name: string;
  site: string;
  account: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CookieRecord {
  id: string;
  jarId: string;
  name: string;
  value: string;
  domain: string | null;
  path: string | null;
  expires: number | null;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None' | null;
  url: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LlmRole = 'planner' | 'executor' | 'vision';

export interface LlmSettingsRecord {
  providerPresetId: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  role: LlmRole;
  enabled: boolean;
  updatedAt: string;
}

export type PublicLlmSettingsRecord = Omit<LlmSettingsRecord, 'apiKey'> & {
  hasApiKey: boolean;
};

export type LlmRoleSettings = LlmSettingsRecord;

export type PublicLlmRoleSettings = PublicLlmSettingsRecord;

export interface LlmProviderPreset {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  createdAt: string;
  updatedAt: string;
}

export type PublicLlmProviderPreset = Omit<LlmProviderPreset, 'apiKey'> & {
  hasApiKey: boolean;
};

export interface LlmPreset {
  id: string;
  name: string;
  active: boolean;
  roles: Record<LlmRole, LlmRoleSettings>;
  createdAt: string;
  updatedAt: string;
}

export interface PublicLlmPreset {
  id: string;
  name: string;
  active: boolean;
  roles: Record<LlmRole, PublicLlmRoleSettings>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkbenchStore {
  saveFlow(flow: FlowDefinition): void;
  listFlows(): FlowDefinition[];
  getFlow(id: string): FlowDefinition | null;
  createRun(run: FlowRunRecord): void;
  updateRun(runId: string, patch: Partial<Omit<FlowRunRecord, 'id' | 'flowId'>>): void;
  upsertRunStep(step: FlowRunStepRecord): void;
  appendRunEvent(event: RunEventRecord): void;
  getRunWithDetails(
    runId: string
  ): { run: FlowRunRecord; steps: FlowRunStepRecord[]; events: RunEventRecord[] } | null;
  listBrowserInstances(): BrowserInstanceRecord[];
  getBrowserInstance(id: string): BrowserInstanceRecord | null;
  saveBrowserInstance(instance: BrowserInstanceRecord): void;
  updateBrowserInstance(id: string, patch: Partial<Omit<BrowserInstanceRecord, 'id' | 'createdAt'>>): void;
  deleteBrowserInstance(id: string): void;
  listCookieJars(): Array<CookieJarRecord & { cookieCount: number }>;
  getCookieJar(id: string): (CookieJarRecord & { cookies: CookieRecord[] }) | null;
  saveCookieJar(jar: CookieJarRecord): void;
  replaceCookies(jarId: string, cookies: CookieRecord[]): void;
  deleteCookieJar(id: string): boolean;
  listLlmSettings(): PublicLlmSettingsRecord[];
  getLlmSettings(role: LlmRole): LlmSettingsRecord | null;
  upsertLlmSettings(settings: LlmSettingsRecord): void;
  listLlmProviderPresets(): PublicLlmProviderPreset[];
  createLlmProviderPreset(input: LlmProviderPreset): PublicLlmProviderPreset;
  updateLlmProviderPreset(id: string, patch: Partial<Omit<LlmProviderPreset, 'id' | 'createdAt'>> & { updatedAt: string }): PublicLlmProviderPreset | null;
  deleteLlmProviderPreset(id: string): boolean;
  listLlmPresets(): { presets: PublicLlmPreset[]; activePresetId: string | null };
  createLlmPreset(input: { id: string; name: string; roles: Record<LlmRole, LlmSettingsRecord>; createdAt: string; updatedAt: string }): PublicLlmPreset;
  updateLlmPreset(id: string, patch: { name?: string; roles?: Partial<Record<LlmRole, LlmSettingsRecord>>; updatedAt: string }): PublicLlmPreset | null;
  activateLlmPreset(id: string, updatedAt: string): PublicLlmPreset | null;
  deleteLlmPreset(id: string): boolean;
}
