'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { LivePreview } from './flow-workbench';

interface CookieJar {
  id: string;
  name: string;
  site: string;
  account: string | null;
  cookieCount: number;
  createdAt: string;
  updatedAt: string;
}

interface CookieRecord {
  id: string;
  jarId: string;
  name: string;
  value: string;
  domain: string | null;
  path: string | null;
  expires: number | null;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string | null;
  url: string | null;
}

interface JarDetail extends CookieJar {
  cookies: CookieRecord[];
}

interface BrowserInstance {
  id: string;
  name: string;
  status: string;
  startUrl: string;
  cookieJarId: string | null;
}

const CHINESE_SITES = [
  { label: '知乎', url: 'https://www.zhihu.com' },
  { label: 'B站', url: 'https://www.bilibili.com' },
  { label: '微博', url: 'https://weibo.com' },
  { label: '百度', url: 'https://www.baidu.com' },
  { label: '抖音', url: 'https://www.douyin.com' },
  { label: '小红书', url: 'https://www.xiaohongshu.com' },
  { label: '豆瓣', url: 'https://www.douban.com' },
  { label: '京东', url: 'https://www.jd.com' },
  { label: '淘宝', url: 'https://www.taobao.com' },
];

export function CookieManager() {
  const [jars, setJars] = useState<CookieJar[]>([]);
  const [activeJarId, setActiveJarId] = useState<string | null>(null);
  const [activeCookies, setActiveCookies] = useState<CookieRecord[]>([]);
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [instanceStatus, setInstanceStatus] = useState<string>('stopped');
  const [url, setUrl] = useState(CHINESE_SITES[0].url);
  const [jarName, setJarName] = useState(CHINESE_SITES[0].label);
  const [accountName, setAccountName] = useState('');
  const [statusText, setStatusText] = useState('Idle');
  const [expandedJarId, setExpandedJarId] = useState<string | null>(null);
  const [jarCookiesCache, setJarCookiesCache] = useState<Record<string, CookieRecord[]>>({});
  const [capturedCookieCount, setCapturedCookieCount] = useState<number | null>(null);
  const [exportMessage, setExportMessage] = useState('');
  const [selectedSite, setSelectedSite] = useState(CHINESE_SITES[0].label);

  useEffect(() => {
    void fetchJars();
  }, []);

  const previewWsUrl = useMemo(() => {
    if (!instanceId || typeof window === 'undefined') return null;
    const selected = instanceStatus !== 'running' ? null : instanceId;
    if (!selected) return null;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${protocol}://${window.location.host}/ws/instances/${instanceId}/preview`;
  }, [instanceId, instanceStatus]);

  async function fetchJars() {
    try {
      const response = await fetch('/api/cookie-jars', { cache: 'no-store' });
      const payload = (await response.json()) as { jars: CookieJar[] };
      setJars(payload.jars);
    } catch {
      setStatusText('Failed to load cookie jars');
    }
  }

  function handleSiteSelect(label: string, siteUrl: string) {
    setSelectedSite(label);
    setUrl(siteUrl);
    setJarName(label);
  }

  async function startCapture() {
    if (!url) {
      setStatusText('Please enter a URL');
      return;
    }
    setStatusText('Creating cookie jar...');
    setCapturedCookieCount(null);
    setExportMessage('');

    try {
      // 1. Create cookie jar
      const jarResponse = await fetch('/api/cookie-jars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: jarName || url.replace(/https?:\/\//, '').split('/')[0],
          site: url,
          account: accountName || null,
        }),
      });
      const jarPayload = (await jarResponse.json()) as { jar: CookieJar };
      const newJarId = jarPayload.jar.id;
      setActiveJarId(newJarId);

      // 2. Create browser instance (headed)
      setStatusText('Creating browser instance...');
      const instanceResponse = await fetch('/api/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Cookie capture - ${jarName || url}`,
          startUrl: url,
          cookieJarId: newJarId,
          headless: false,
        }),
      });
      const instancePayload = (await instanceResponse.json()) as { instance: BrowserInstance };
      const newInstanceId = instancePayload.instance.id;
      setInstanceId(newInstanceId);

      // 3. Start the browser
      setStatusText('Starting browser...');
      const startResponse = await fetch(`/api/instances/${newInstanceId}/start`, { method: 'POST' });
      if (!startResponse.ok) {
        const errPayload = (await startResponse.json()) as { error?: string };
        setStatusText(`Failed: ${errPayload.error ?? 'start failed'}`);
        return;
      }

      setInstanceStatus('running');
      setStatusText('Browser open — please log in, then click "Capture cookies"');

      await fetchJars();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusText(`Error: ${message}`);
    }
  }

  async function captureNow() {
    if (!instanceId || !activeJarId) {
      setStatusText('No active browser session');
      return;
    }
    setStatusText('Capturing cookies...');
    try {
      const response = await fetch(`/api/instances/${instanceId}/cookies/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jarId: activeJarId }),
      });
      if (!response.ok) {
        const errPayload = (await response.json()) as { error?: string };
        setStatusText(`Capture failed: ${errPayload.error ?? 'unknown'}`);
        return;
      }
      const payload = (await response.json()) as { cookieCount: number };
      setCapturedCookieCount(payload.cookieCount);
      setStatusText(`Captured ${payload.cookieCount} cookies!`);
      await fetchJars();
      await loadJarCookies(activeJarId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusText(`Error: ${message}`);
    }
  }

  async function exportToFile(jarId: string) {
    setExportMessage('');
    try {
      const response = await fetch(`/api/cookie-jars/${jarId}/export`, { method: 'POST' });
      if (!response.ok) {
        const errPayload = (await response.json()) as { error?: string };
        setExportMessage(`Export failed: ${errPayload.error ?? 'unknown'}`);
        return;
      }
      const payload = (await response.json()) as { path: string; cookieCount: number };
      setExportMessage(`Exported ${payload.cookieCount} cookies → ${payload.path}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setExportMessage(`Export error: ${message}`);
    }
  }

  async function downloadJar(jarId: string) {
    try {
      const response = await fetch(`/api/cookie-jars/${jarId}/download`, { method: 'POST' });
      if (!response.ok) return;
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const jar = jars.find((j) => j.id === jarId);
      a.download = `${slugify(jar?.name ?? 'cookies')}-cookies.json`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      setStatusText('Download failed');
    }
  }

  async function deleteJar(jarId: string) {
    try {
      await fetch(`/api/cookie-jars/${jarId}`, { method: 'DELETE' });
      if (activeJarId === jarId) {
        setActiveJarId(null);
        setActiveCookies([]);
      }
      if (expandedJarId === jarId) {
        setExpandedJarId(null);
      }
      await fetchJars();
    } catch {
      setStatusText('Delete failed');
    }
  }

  async function stopBrowser() {
    if (!instanceId) return;
    setStatusText('Stopping browser...');
    try {
      await fetch(`/api/instances/${instanceId}/stop`, { method: 'POST' });
      setInstanceStatus('stopped');
      setInstanceId(null);
      setStatusText('Browser closed');
    } catch {
      setStatusText('Failed to stop browser');
    }
  }

  async function loadJarCookies(jarId: string) {
    if (jarCookiesCache[jarId]) {
      setActiveCookies(jarCookiesCache[jarId]);
      return;
    }
    try {
      const response = await fetch(`/api/cookie-jars/${jarId}`, { cache: 'no-store' });
      if (!response.ok) return;
      const payload = (await response.json()) as { jar: JarDetail };
      setJarCookiesCache((prev) => ({ ...prev, [jarId]: payload.jar.cookies }));
      setActiveCookies(payload.jar.cookies);
    } catch {
      // ignore
    }
  }

  function toggleExpandJar(jarId: string) {
    if (expandedJarId === jarId) {
      setExpandedJarId(null);
      setActiveCookies([]);
      return;
    }
    setExpandedJarId(jarId);
    void loadJarCookies(jarId);
  }

  return (
    <div className="tab-stack">
      <header className="section-head">
        <div>
          <p className="eyebrow">Cookies</p>
          <h1>Cookie manager</h1>
        </div>
        <p className="warning-text">
          Cookies are stored in local SQLite and exported to <code>cookies.json</code>. They are not synced.
        </p>
      </header>

      <div className="two-column">
        {/* Left: Capture form + preview */}
        <section className="panel">
          <div className="panel-head">
            <h2>Capture cookies</h2>
            <span>{instanceStatus === 'running' ? 'Browser running' : 'Idle'}</span>
          </div>

          {/* Quick site selector */}
          <div className="site-quick-list" aria-label="Quick site selection">
            {CHINESE_SITES.map((site) => (
              <button
                key={site.label}
                type="button"
                className={`site-chip ${selectedSite === site.label ? 'active' : ''}`}
                onClick={() => handleSiteSelect(site.label, site.url)}
              >
                {site.label}
              </button>
            ))}
          </div>

          <form
            className="form-grid compact-form"
            onSubmit={(e) => {
              e.preventDefault();
              void startCapture();
            }}
          >
            <label>
              URL
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" />
            </label>
            <label>
              Cookie jar name
              <input
                value={jarName}
                onChange={(e) => setJarName(e.target.value)}
                placeholder="Site name"
              />
            </label>
            <label>
              Account label (optional)
              <input
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                placeholder="user@example.com"
              />
            </label>
            <div className="row-actions">
              <button type="submit" disabled={instanceStatus === 'running' || !url}>
                Open browser
              </button>
              {instanceStatus === 'running' ? (
                <>
                  <button type="button" className="capture-btn" onClick={() => void captureNow()}>
                    Capture cookies
                  </button>
                  <button type="button" onClick={() => void stopBrowser()}>
                    Close browser
                  </button>
                </>
              ) : null}
            </div>
          </form>

          {capturedCookieCount !== null ? (
            <div className="capture-result">
              <strong>Captured {capturedCookieCount} cookies</strong>
              {activeJarId ? (
                <div className="row-actions">
                  <button onClick={() => void exportToFile(activeJarId!)}>Export to cookies.json</button>
                  <button onClick={() => void downloadJar(activeJarId)}>Download JSON</button>
                </div>
              ) : null}
              {exportMessage ? <p className="export-msg">{exportMessage}</p> : null}
            </div>
          ) : null}

          {/* Browser preview */}
          {instanceStatus === 'running' && previewWsUrl ? (
            <div className="capture-preview">
              <LivePreview wsUrl={previewWsUrl} />
            </div>
          ) : null}

          {/* Cookie list */}
          {activeCookies.length > 0 ? (
            <div className="capture-preview">
              <h3>Cookies ({activeCookies.length})</h3>
              <div className="cookie-table-wrap">
                <table className="cookie-table">
                  <thead>
                    <tr>
                      <th>Domain</th>
                      <th>Name</th>
                      <th>Value</th>
                      <th>Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeCookies.map((c) => (
                      <tr key={c.id}>
                        <td className="cookie-cell-domain">{c.domain}</td>
                        <td className="cookie-cell-name">{c.name}</td>
                        <td className="cookie-cell-value" title={c.value}>
                          {c.value.length > 40 ? `${c.value.slice(0, 40)}...` : c.value}
                        </td>
                        <td className="cookie-cell-flags">
                          {c.httpOnly ? <span className="pill cookie-flag">H</span> : null}
                          {c.secure ? <span className="pill cookie-flag">S</span> : null}
                          {c.sameSite && c.sameSite !== 'None' ? (
                            <span className="pill cookie-flag">{c.sameSite}</span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <p className="nav-status">{statusText}</p>
        </section>

        {/* Right: existing cookie jars */}
        <section className="panel">
          <div className="panel-head">
            <h2>Saved cookie jars</h2>
            <span>{jars.length} total</span>
          </div>
          {jars.length === 0 ? (
            <p className="empty-copy">No cookie jars yet. Open a browser to capture cookies.</p>
          ) : (
            <div className="jar-list">
              {jars.map((jar) => (
                <article className={`jar-card ${expandedJarId === jar.id ? 'expanded' : ''}`} key={jar.id}>
                  <div className="jar-card-head" onClick={() => toggleExpandJar(jar.id)}>
                    <div>
                      <strong>{jar.name}</strong>
                      <p>{jar.site}</p>
                      <p className="jar-meta">
                        {jar.account ? `${jar.account} · ` : ''}
                        {jar.cookieCount} cookies
                      </p>
                    </div>
                    <span className="pill">{jar.cookieCount}</span>
                  </div>

                  {expandedJarId === jar.id ? (
                    <div className="jar-card-detail">
                      {activeCookies.length > 0 ? (
                        <div className="cookie-table-wrap">
                          <table className="cookie-table compact-cookie-table">
                            <thead>
                              <tr>
                                <th>Domain</th>
                                <th>Name</th>
                                <th>Value</th>
                              </tr>
                            </thead>
                            <tbody>
                              {activeCookies.map((c) => (
                                <tr key={c.id}>
                                  <td className="cookie-cell-domain">{c.domain}</td>
                                  <td className="cookie-cell-name">{c.name}</td>
                                  <td className="cookie-cell-value" title={c.value}>
                                    {c.value.length > 40 ? `${c.value.slice(0, 40)}...` : c.value}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="empty-copy">No cookies in this jar</p>
                      )}
                      <div className="row-actions jar-actions">
                        <button onClick={() => void exportToFile(jar.id)}>Export</button>
                        <button onClick={() => void downloadJar(jar.id)}>Download</button>
                        <button className="delete-btn" onClick={() => void deleteJar(jar.id)}>
                          Delete
                        </button>
                      </div>
                      {exportMessage && expandedJarId === jar.id ? (
                        <p className="export-msg">{exportMessage}</p>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'cookies';
}
