'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CookieManager } from './cookie-manager';
import { AutoBrowserConsole } from './auto-browser-console';
import { LivePreview } from './flow-workbench';
import type {
  BrowserInstanceCandidate,
  BrowserInstanceRecord,
  CookieJarRecord,
  FlowDefinition,
  FlowRunRecord,
  FlowRunStepRecord,
  LlmRole,
  PublicLlmPreset,
  PublicLlmProviderPreset,
  PublicLlmSettingsRecord,
  RunEventRecord,
} from '../src/workbench/types';

type Tab = 'chat' | 'management' | 'scripts' | 'cookies' | 'auto';

export function WorkbenchHome() {
  const [tab, setTab] = useState<Tab>('chat');
  const [flows, setFlows] = useState<FlowDefinition[]>([]);
  const [instances, setInstances] = useState<BrowserInstanceRecord[]>([]);
  const [detectedInstances, setDetectedInstances] = useState<BrowserInstanceCandidate[]>([]);
  const [jars, setJars] = useState<Array<CookieJarRecord & { cookieCount: number }>>([]);
  const [settings, setSettings] = useState<PublicLlmSettingsRecord[]>([]);
  const [llmPresets, setLlmPresets] = useState<PublicLlmPreset[]>([]);
  const [providerPresets, setProviderPresets] = useState<PublicLlmProviderPreset[]>([]);
  const [activeLlmPresetId, setActiveLlmPresetId] = useState<string | null>(null);
  const [chatMessage, setChatMessage] = useState('');
  const [chatResponse, setChatResponse] = useState('No message sent.');
  const [selectedInstanceId, setSelectedInstanceId] = useState('');
  const [selectedScriptId, setSelectedScriptId] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<FlowRunRecord | null>(null);
  const [runSteps, setRunSteps] = useState<FlowRunStepRecord[]>([]);
  const [runEvents, setRunEvents] = useState<RunEventRecord[]>([]);
  const [statusText, setStatusText] = useState('Idle');

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!selectedScriptId && flows.length > 0) {
      setSelectedScriptId(flows[0].id);
    }
  }, [flows, selectedScriptId]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    async function pollRun() {
      const response = await fetch(`/api/runs/${runId}`, { cache: 'no-store' });
      if (!response.ok || cancelled) return;
      const payload = (await response.json()) as {
        run: FlowRunRecord;
        steps: FlowRunStepRecord[];
        events: RunEventRecord[];
      };
      if (cancelled) return;
      setRun(payload.run);
      setRunSteps(payload.steps);
      setRunEvents(payload.events);
      setStatusText(`Run ${payload.run.status}`);
    }
    void pollRun();
    const timer = setInterval(() => void pollRun(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runId]);

  const instancePreviewUrl = useMemo(() => {
    if (!selectedInstanceId || typeof window === 'undefined') return null;
    const selected = instances.find((instance) => instance.id === selectedInstanceId);
    if (selected?.status !== 'running') return null;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${protocol}://${window.location.host}/ws/instances/${selectedInstanceId}/preview`;
  }, [instances, selectedInstanceId]);

  async function refresh() {
    const [flowsResponse, instancesResponse, detectedResponse, jarsResponse, settingsResponse] = await Promise.all([
      fetch('/api/flows', { cache: 'no-store' }),
      fetch('/api/instances', { cache: 'no-store' }),
      fetch('/api/instances/detected', { cache: 'no-store' }),
      fetch('/api/cookie-jars', { cache: 'no-store' }),
      fetch('/api/settings/llm/presets', { cache: 'no-store' }),
    ]);
    setFlows(((await flowsResponse.json()) as { flows: FlowDefinition[] }).flows);
    setInstances(((await instancesResponse.json()) as { instances: BrowserInstanceRecord[] }).instances);
    setDetectedInstances(((await detectedResponse.json()) as { candidates: BrowserInstanceCandidate[] }).candidates);
    setJars(((await jarsResponse.json()) as { jars: Array<CookieJarRecord & { cookieCount: number }> }).jars);
    const llmPayload = (await settingsResponse.json()) as {
      presets: PublicLlmPreset[];
      providerPresets: PublicLlmProviderPreset[];
      activePresetId: string | null;
    };
    setLlmPresets(llmPayload.presets);
    setProviderPresets(llmPayload.providerPresets);
    setActiveLlmPresetId(llmPayload.activePresetId);
    setSettings(llmPayload.presets.find((preset) => preset.id === llmPayload.activePresetId)
      ? Object.values(llmPayload.presets.find((preset) => preset.id === llmPayload.activePresetId)!.roles)
      : []);
  }

  async function createInstance(formData: FormData) {
    setStatusText('Creating instance');
    await fetch('/api/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: formData.get('name'),
        startUrl: formData.get('startUrl'),
        profilePath: formData.get('profilePath') || null,
        cookieJarId: formData.get('cookieJarId') || null,
        headless: formData.get('headless') === 'on',
      }),
    });
    setStatusText('Instance saved');
    await refresh();
  }

  async function importDetectedInstance(candidate: BrowserInstanceCandidate) {
    setStatusText('Importing detected browser');
    await fetch('/api/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: candidate.name,
        startUrl: candidate.startUrl,
        mode: candidate.mode,
        browserFamily: candidate.browserFamily,
        executablePath: candidate.executablePath,
        profilePath: candidate.profilePath,
        viewport: candidate.viewport,
        headless: candidate.headless,
      }),
    });
    setStatusText('Detected browser imported');
    await refresh();
  }

  async function createCookieJar(formData: FormData) {
    await fetch('/api/cookie-jars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: formData.get('name'),
        site: formData.get('site'),
        account: formData.get('account') || null,
      }),
    });
    await refresh();
  }

  async function instanceAction(instanceId: string, action: 'start' | 'stop' | 'refresh') {
    setStatusText(`${action} ${instanceId}`);
    await fetch(`/api/instances/${instanceId}/${action}`, { method: 'POST' });
    await refresh();
    setStatusText('Idle');
  }

  async function saveLlm(formData: FormData) {
    const presetId = String(formData.get('presetId') ?? '');
    const providerPresetIds = formData.getAll('providerPresetId').map((value) => String(value));
    await Promise.all(
      providerPresetIds.map((id) =>
        fetch(`/api/settings/llm/provider-presets/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: formData.get(`provider.${id}.name`),
            provider: formData.get(`provider.${id}.provider`),
            baseUrl: formData.get(`provider.${id}.baseUrl`),
            apiKey: formData.get(`provider.${id}.apiKey`) || undefined,
          }),
        })
      )
    );
    const roles = Object.fromEntries(
      (['planner', 'executor', 'vision'] as const).map((role) => [
        role,
        {
          role,
          providerPresetId: formData.get(`${role}.providerPresetId`),
          model: formData.get(`${role}.model`),
          enabled: formData.get(`${role}.enabled`) === 'on',
        },
      ])
    );
    await fetch(`/api/settings/llm/presets/${presetId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: formData.get('presetName'),
        roles,
      }),
    });
    await refresh();
  }

  async function createLlmPreset() {
    const activePreset = llmPresets.find((preset) => preset.id === activeLlmPresetId);
    await fetch('/api/settings/llm/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New preset', roles: activePreset?.roles }),
    });
    await refresh();
  }

  async function createProviderPreset() {
    await fetch('/api/settings/llm/provider-presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New provider', provider: 'llm-router', baseUrl: 'http://127.0.0.1:18000/v1' }),
    });
    await refresh();
  }

  async function deleteProviderPreset(id: string) {
    await fetch(`/api/settings/llm/provider-presets/${id}`, { method: 'DELETE' });
    await refresh();
  }

  async function activateLlmPreset(id: string) {
    await fetch(`/api/settings/llm/presets/${id}/activate`, { method: 'POST' });
    await refresh();
  }

  async function deleteLlmPreset(id: string) {
    await fetch(`/api/settings/llm/presets/${id}`, { method: 'DELETE' });
    await refresh();
  }

  async function sendChat() {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: chatMessage, role: 'planner', instanceId: selectedInstanceId || null }),
    });
    const payload = (await response.json()) as { message: string; model: string | null; echo: string };
    setChatResponse(`${payload.message}${payload.echo ? `\n\n${payload.echo}` : ''}`);
  }

  async function startScriptRun() {
    if (!selectedScriptId || !selectedInstanceId) {
      setStatusText('Select a script and running target');
      return;
    }
    const instance = instances.find((entry) => entry.id === selectedInstanceId);
    if (instance?.status !== 'running') {
      setStatusText('Starting target instance');
      await fetch(`/api/instances/${selectedInstanceId}/start`, { method: 'POST' });
      await refresh();
    }
    const response = await fetch(`/api/scripts/${selectedScriptId}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instanceId: selectedInstanceId,
        interactive: true,
        pauseOnFailure: true,
      }),
    });
    const payload = (await response.json()) as { runId?: string; error?: string };
    if (!response.ok || !payload.runId) {
      setStatusText(payload.error ?? 'Unable to start script');
      return;
    }
    setRunId(payload.runId);
    setRun(null);
    setRunSteps([]);
    setRunEvents([]);
    setStatusText('Script running');
  }

  async function controlRun(action: 'pause' | 'resume' | 'cancel') {
    if (!runId) return;
    const response = await fetch(`/api/runs/${runId}/${action}`, { method: 'POST' });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setStatusText(payload.error ?? `Unable to ${action} run`);
      return;
    }
    setStatusText(`${action} requested`);
  }

  return (
    <main className="app-shell">
      <aside className="side-nav" aria-label="Workbench navigation">
        <div>
          <p className="nav-mark">Auto Browser</p>
          <p className="nav-subtitle">Workbench</p>
        </div>
        {(['chat', 'management', 'scripts', 'cookies', 'auto'] as const).map((item) => (
          <button className={tab === item ? 'nav-item active' : 'nav-item'} key={item} onClick={() => setTab(item)}>
            {item === 'chat' ? 'Chat' : item === 'management' ? 'Management' : item === 'scripts' ? 'Scripts' : item === 'cookies' ? 'Cookies' : 'Auto Browser'}
          </button>
        ))}
        <p className="nav-status">{statusText}</p>
      </aside>

      <section className="workspace">
        {tab === 'chat' ? (
          <ChatPanel
            chatMessage={chatMessage}
            chatResponse={chatResponse}
            flows={flows}
            instances={instances}
            instancePreviewUrl={instancePreviewUrl}
            run={run}
            runEvents={runEvents}
            runId={runId}
            runSteps={runSteps}
            selectedInstanceId={selectedInstanceId}
            selectedScriptId={selectedScriptId}
            setChatMessage={setChatMessage}
            setSelectedInstanceId={setSelectedInstanceId}
            setSelectedScriptId={setSelectedScriptId}
            sendChat={sendChat}
            settings={settings}
            llmPresets={llmPresets}
            providerPresets={providerPresets}
            activeLlmPresetId={activeLlmPresetId}
            saveLlm={saveLlm}
            createLlmPreset={createLlmPreset}
            activateLlmPreset={activateLlmPreset}
            deleteLlmPreset={deleteLlmPreset}
            createProviderPreset={createProviderPreset}
            deleteProviderPreset={deleteProviderPreset}
            startScriptRun={startScriptRun}
            controlRun={controlRun}
          />
        ) : null}
        {tab === 'management' ? (
          <ManagementPanel
            createCookieJar={createCookieJar}
            createInstance={createInstance}
            importDetectedInstance={importDetectedInstance}
            detectedInstances={detectedInstances}
            instanceAction={instanceAction}
            instances={instances}
            jars={jars}
          />
        ) : null}
        {tab === 'scripts' ? <ScriptsPanel flows={flows} instances={instances} /> : null}
        {tab === 'cookies' ? <CookieManager /> : null}
        {tab === 'auto' ? <AutoBrowserConsole instances={instances} instancePreviewUrl={instancePreviewUrl} /> : null}
      </section>
    </main>
  );
}

function ChatPanel(props: {
  chatMessage: string;
  chatResponse: string;
  flows: FlowDefinition[];
  instances: BrowserInstanceRecord[];
  instancePreviewUrl: string | null;
  run: FlowRunRecord | null;
  runEvents: RunEventRecord[];
  runId: string | null;
  runSteps: FlowRunStepRecord[];
  selectedInstanceId: string;
  selectedScriptId: string;
  settings: PublicLlmSettingsRecord[];
  llmPresets: PublicLlmPreset[];
  providerPresets: PublicLlmProviderPreset[];
  activeLlmPresetId: string | null;
  controlRun(action: 'pause' | 'resume' | 'cancel'): Promise<void>;
  setChatMessage(value: string): void;
  setSelectedInstanceId(value: string): void;
  setSelectedScriptId(value: string): void;
  sendChat(): Promise<void>;
  saveLlm(formData: FormData): Promise<void>;
  createLlmPreset(): Promise<void>;
  activateLlmPreset(id: string): Promise<void>;
  deleteLlmPreset(id: string): Promise<void>;
  createProviderPreset(): Promise<void>;
  deleteProviderPreset(id: string): Promise<void>;
  startScriptRun(): Promise<void>;
}) {
  const canPause = props.run?.status === 'running';
  const canResume = props.run?.status === 'paused';
  const canCancel = props.run ? ['queued', 'running', 'paused'].includes(props.run.status) : false;
  const [llmSettingsOpen, setLlmSettingsOpen] = useState(false);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function isEditableTarget(target: EventTarget | null) {
      return target instanceof Element && Boolean(target.closest('textarea, input, select, [contenteditable]'));
    }

    function handleShortcut(event: KeyboardEvent) {
      if (event.key === 'Escape' && llmSettingsOpen) {
        event.preventDefault();
        setLlmSettingsOpen(false);
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'l') {
        event.preventDefault();
        setLlmSettingsOpen((open) => !open);
      }
      if (key === 't') {
        event.preventDefault();
        timelineRef.current?.focus();
      }
    }

    document.addEventListener('keydown', handleShortcut);
    return () => document.removeEventListener('keydown', handleShortcut);
  }, [llmSettingsOpen]);

  return (
    <div className="tab-stack">
      <header className="section-head">
        <div>
          <p className="eyebrow">Chat</p>
          <h1>Operator console</h1>
        </div>
        <div className="status-pills">
          <span className={props.run?.status === 'paused' ? 'pill recording' : 'pill'}>
            {props.run?.status ?? 'No run'}
          </span>
          <button
            type="button"
            aria-keyshortcuts="Alt+L"
            aria-expanded={llmSettingsOpen}
            aria-controls="llmSettingsDrawer"
            title="LLM settings (Alt+L)"
            onClick={() => setLlmSettingsOpen(true)}
          >
            LLM settings
          </button>
        </div>
      </header>
      <section className="panel timeline-panel chat-timeline-panel">
        <div className="panel-head">
          <h2>Run timeline</h2>
          <span>{props.run?.currentStepId ?? 'No active step'}</span>
        </div>
        <div
          className="timeline-list horizontal-timeline"
          ref={timelineRef}
          tabIndex={0}
          aria-label="Run timeline"
          aria-keyshortcuts="Alt+T"
          title="Run timeline (Alt+T)"
        >
          {props.runSteps.length === 0 ? (
            <p className="empty-copy">Run a script to populate step status and failure details.</p>
          ) : (
            props.runSteps.map((step) => (
              <article className={`timeline-card ${step.status}`} key={step.stepId}>
                <div className="timeline-card-head">
                  <strong>{step.message ?? step.stepId}</strong>
                  <span>{step.status}</span>
                </div>
                <p>{step.pageUrl}</p>
                <p>{step.durationMs ? `${step.durationMs} ms` : 'Running...'}</p>
                {step.errorDetail ? <pre>{step.errorDetail}</pre> : null}
              </article>
            ))
          )}
        </div>
        {props.runEvents.length > 0 ? (
          <div className="event-strip horizontal-events">
            {props.runEvents.slice(-6).map((event) => (
              <div className="event-chip" key={event.id}>
                <strong>{event.type}</strong>
                <span>{new Date(event.createdAt).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>
      <div className="two-column">
        <section className="panel message-panel">
          <div className="script-console">
            <label>
              Script
              <select value={props.selectedScriptId} onChange={(event) => props.setSelectedScriptId(event.target.value)}>
                <option value="">Select script</option>
                {props.flows.map((flow) => (
                  <option key={flow.id} value={flow.id}>
                    {flow.name} ({flow.steps.length})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Instance
              <select value={props.selectedInstanceId} onChange={(event) => props.setSelectedInstanceId(event.target.value)}>
                <option value="">Select managed instance</option>
                {props.instances.map((instance) => (
                  <option key={instance.id} value={instance.id}>
                    {instance.name} ({instance.status})
                  </option>
                ))}
              </select>
            </label>
            <div className="row-actions">
              <button disabled={!props.selectedScriptId || !props.selectedInstanceId || canCancel} onClick={() => void props.startScriptRun()}>
                Start
              </button>
              <button disabled={!canPause} onClick={() => void props.controlRun('pause')}>
                Pause
              </button>
              <button disabled={!canResume} onClick={() => void props.controlRun('resume')}>
                Resume
              </button>
              <button disabled={!canCancel} onClick={() => void props.controlRun('cancel')}>
                Cancel
              </button>
            </div>
          </div>
          <div className="message-log">
            <pre>{props.chatResponse}</pre>
          </div>
          <div className="composer">
            <textarea value={props.chatMessage} onChange={(event) => props.setChatMessage(event.target.value)} />
            <button onClick={() => void props.sendChat()}>Send</button>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Instance preview</h2>
              <p>{props.run?.status === 'paused' ? 'Run paused. Take over the browser, then resume.' : props.runId ? `Run ${props.runId}` : 'Select an instance to preview.'}</p>
            </div>
          </div>
          <LivePreview wsUrl={props.instancePreviewUrl} />
        </section>
      </div>
      <LlmSettingsPanel
        open={llmSettingsOpen}
        settings={props.settings}
        llmPresets={props.llmPresets}
        providerPresets={props.providerPresets}
        activeLlmPresetId={props.activeLlmPresetId}
        saveLlm={props.saveLlm}
        createLlmPreset={props.createLlmPreset}
        activateLlmPreset={props.activateLlmPreset}
        deleteLlmPreset={props.deleteLlmPreset}
        createProviderPreset={props.createProviderPreset}
        deleteProviderPreset={props.deleteProviderPreset}
        onClose={() => setLlmSettingsOpen(false)}
      />
    </div>
  );
}

function LlmSettingsPanel(props: {
  open: boolean;
  settings: PublicLlmSettingsRecord[];
  llmPresets: PublicLlmPreset[];
  providerPresets: PublicLlmProviderPreset[];
  activeLlmPresetId: string | null;
  saveLlm(formData: FormData): Promise<void>;
  createLlmPreset(): Promise<void>;
  activateLlmPreset(id: string): Promise<void>;
  deleteLlmPreset(id: string): Promise<void>;
  createProviderPreset(): Promise<void>;
  deleteProviderPreset(id: string): Promise<void>;
  onClose(): void;
}) {
  return (
    <>
      <button className="drawer-backdrop" type="button" aria-label="Close LLM settings" hidden={!props.open} onClick={props.onClose} />
      <aside id="llmSettingsDrawer" className={props.open ? 'settings-drawer open' : 'settings-drawer'} aria-hidden={!props.open} aria-labelledby="llmSettingsDrawerTitle">
        <div className="panel-head">
          <div>
            <h2 id="llmSettingsDrawerTitle">LLM settings</h2>
            <p>{props.settings.length} roles</p>
          </div>
          <button type="button" onClick={props.onClose} aria-label="Close LLM settings">
            Close
          </button>
        </div>
        <form className="form-grid" key={props.activeLlmPresetId ?? 'none'} action={(formData) => void props.saveLlm(formData)}>
          <input name="presetId" type="hidden" value={props.activeLlmPresetId ?? ''} />
          <label>
            Preset
            <select value={props.activeLlmPresetId ?? ''} onChange={(event) => void props.activateLlmPreset(event.target.value)}>
              {props.llmPresets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Preset name
            <input name="presetName" defaultValue={props.llmPresets.find((preset) => preset.id === props.activeLlmPresetId)?.name ?? ''} />
          </label>
          <fieldset className="form-grid compact-form">
            <legend>Provider presets</legend>
            {props.providerPresets.map((preset) => {
              const inUse = props.settings.some((setting) => setting.providerPresetId === preset.id);
              return (
                <div className="form-grid compact-form" key={preset.id}>
                  <input name="providerPresetId" type="hidden" value={preset.id} />
                  <label>
                    Name
                    <input name={`provider.${preset.id}.name`} defaultValue={preset.name} />
                  </label>
                  <label>
                    Provider
                    <input name={`provider.${preset.id}.provider`} defaultValue={preset.provider} />
                  </label>
                  <label>
                    Base URL
                    <input name={`provider.${preset.id}.baseUrl`} defaultValue={preset.baseUrl} />
                  </label>
                  <label>
                    API key
                    <input name={`provider.${preset.id}.apiKey`} type="password" placeholder={preset.hasApiKey ? 'Stored; blank keeps existing' : 'Optional'} />
                  </label>
                  <button type="button" disabled={inUse || props.providerPresets.length <= 1} onClick={() => void props.deleteProviderPreset(preset.id)}>
                    Delete provider
                  </button>
                </div>
              );
            })}
            <button type="button" onClick={() => void props.createProviderPreset()}>New provider</button>
          </fieldset>
          {(['planner', 'executor', 'vision'] as const).map((role) => (
            <RoleSettingsFields
              key={role}
              role={role}
              providerPresets={props.providerPresets}
              settings={props.settings.find((setting) => setting.role === role)}
            />
          ))}
          <div className="row-actions">
            <button type="submit" disabled={!props.activeLlmPresetId}>Save preset</button>
            <button type="button" onClick={() => void props.createLlmPreset()}>New</button>
            <button type="button" disabled={props.llmPresets.length <= 1 || !props.activeLlmPresetId} onClick={() => props.activeLlmPresetId && void props.deleteLlmPreset(props.activeLlmPresetId)}>
              Delete
            </button>
          </div>
        </form>
      </aside>
    </>
  );
}

function RoleSettingsFields({
  role,
  providerPresets,
  settings,
}: {
  role: LlmRole;
  providerPresets: PublicLlmProviderPreset[];
  settings?: PublicLlmSettingsRecord;
}) {
  const label = role[0].toUpperCase() + role.slice(1);
  return (
    <fieldset className="form-grid compact-form">
      <legend>{label}</legend>
      <label>
        Provider preset
        <select name={`${role}.providerPresetId`} defaultValue={settings?.providerPresetId ?? providerPresets[0]?.id ?? ''}>
          {providerPresets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Model
        <input name={`${role}.model`} defaultValue={settings?.model ?? (role === 'vision' ? '' : 'openai/gpt-4o')} />
      </label>
      <label className="toggle-row">
        <input name={`${role}.enabled`} type="checkbox" defaultChecked={settings?.enabled ?? role !== 'vision'} />
        Enabled
      </label>
    </fieldset>
  );
}

function ManagementPanel(props: {
  createInstance(formData: FormData): Promise<void>;
  createCookieJar(formData: FormData): Promise<void>;
  importDetectedInstance(candidate: BrowserInstanceCandidate): Promise<void>;
  detectedInstances: BrowserInstanceCandidate[];
  instanceAction(instanceId: string, action: 'start' | 'stop' | 'refresh'): Promise<void>;
  instances: BrowserInstanceRecord[];
  jars: Array<CookieJarRecord & { cookieCount: number }>;
}) {
  return (
    <div className="tab-stack">
      <header className="section-head">
        <div>
          <p className="eyebrow">Management</p>
          <h1>Instances and cookies</h1>
        </div>
        <p className="warning-text">Cookies are stored in local plaintext SQLite. They are not synced.</p>
      </header>
      <div className="two-column wide-left">
        <section className="panel">
          <div className="panel-head">
            <h2>Browser instances</h2>
            <span>{props.instances.length} total</span>
          </div>
          {props.detectedInstances.length > 0 ? (
            <div className="detected-browser-list" aria-label="Detected browser">
              {props.detectedInstances.map((candidate) => (
                <article className="table-row detected-browser-row" key={candidate.id}>
                  <div>
                    <strong>Detected browser</strong>
                    <p>
                      {formatBrowserFamily(candidate.browserFamily)} · {candidate.mode}
                    </p>
                    <p>{candidate.executablePath || 'Managed Chromium'}</p>
                    <p>{candidate.message}</p>
                  </div>
                  <span className={candidate.importedInstanceId ? 'pill active' : 'pill'}>
                    {candidate.importedInstanceId ? 'imported' : candidate.detected ? 'detected' : 'fallback'}
                  </span>
                  <div className="row-actions">
                    <button
                      disabled={Boolean(candidate.importedInstanceId)}
                      onClick={() => void props.importDetectedInstance(candidate)}
                    >
                      Import
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : null}
          <div className="table-list">
            {props.instances.map((instance) => (
              <article className="table-row" key={instance.id}>
                <div>
                  <strong>{instance.name}</strong>
                  <p>{instance.startUrl}</p>
                  <p>
                    {formatBrowserFamily(instance.browserFamily)} · {instance.mode}
                    {instance.executablePath ? ` · ${instance.executablePath}` : ''}
                  </p>
                  <p>{instance.profilePath || 'Ephemeral profile'}</p>
                </div>
                <span className={`pill ${instance.status === 'running' ? 'active' : ''}`}>{instance.status}</span>
                <div className="row-actions">
                  <button onClick={() => void props.instanceAction(instance.id, 'start')}>Start</button>
                  <button onClick={() => void props.instanceAction(instance.id, 'refresh')}>Refresh</button>
                  <button onClick={() => void props.instanceAction(instance.id, 'stop')}>Stop</button>
                </div>
              </article>
            ))}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Create instance</h2>
          </div>
          <form className="form-grid" action={(formData) => void props.createInstance(formData)}>
            <label>
              Name
              <input name="name" placeholder="Gmail research profile" />
            </label>
            <label>
              Start URL
              <input name="startUrl" defaultValue="https://example.com" />
            </label>
            <label>
              Profile path
              <input name="profilePath" placeholder="./browser-profile/account-a" />
            </label>
            <label>
              Cookie jar
              <select name="cookieJarId" defaultValue="">
                <option value="">No cookie jar</option>
                {props.jars.map((jar) => (
                  <option key={jar.id} value={jar.id}>
                    {jar.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="toggle-row">
              <input name="headless" type="checkbox" />
              Headless
            </label>
            <button type="submit">Create instance</button>
          </form>
          <form className="form-grid compact-form" action={(formData) => void props.createCookieJar(formData)}>
            <h3>New cookie jar</h3>
            <input name="name" placeholder="Account cookies" />
            <input name="site" placeholder="https://example.com" />
            <input name="account" placeholder="account label" />
            <button type="submit">Create jar</button>
          </form>
        </section>
      </div>
    </div>
  );
}

function formatBrowserFamily(browserFamily: BrowserInstanceRecord['browserFamily']): string {
  if (browserFamily === 'chrome') return 'Chrome';
  if (browserFamily === 'edge') return 'Edge';
  return 'Chromium';
}

function ScriptsPanel({ flows, instances }: { flows: FlowDefinition[]; instances: BrowserInstanceRecord[] }) {
  return (
    <div className="tab-stack">
      <header className="section-head">
        <div>
          <p className="eyebrow">Scripts</p>
          <h1>Recorded flows</h1>
        </div>
        <form className="inline-create" action="/api/flows" method="post">
          <input name="name" placeholder="Script name" />
          <input name="startUrl" defaultValue="https://example.com" />
          <button type="submit">Create</button>
        </form>
      </header>
      <section className="script-grid">
        {flows.map((flow) => (
          <article className="script-row" key={flow.id}>
            <div>
              <span className="flow-badge">{flow.steps.length} steps</span>
              <h2>{flow.name}</h2>
              <p>{flow.startUrl}</p>
            </div>
            <div className="row-actions">
              <Link className="button-link" href={`/flows/${flow.id}`}>
                Edit
              </Link>
              <a className="button-link" href={`/api/scripts/${flow.id}/export/skill`}>
                Export Skill
              </a>
            </div>
          </article>
        ))}
        {flows.length === 0 ? <p className="empty-copy">No scripts yet. Create one to start recording.</p> : null}
      </section>
      <p className="muted-line">{instances.length} managed instances available for script runs.</p>
    </div>
  );
}
