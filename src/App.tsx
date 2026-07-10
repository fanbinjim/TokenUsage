import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { formatReset, formatTokens } from "./format";
import { useUsageStore } from "./store";
import type { AppSettings, RateWindow, RuntimeUsageSnapshot } from "./types";

function QuotaCard({ title, window }: { title: string; window: RateWindow | null }) {
  const remaining = window?.remainingPercent ?? null;
  return (
    <article className="quota-card">
      <p>{title}</p>
      <strong>{remaining == null ? "--" : `${Math.round(remaining)}%`}</strong>
      <div className="meter" aria-label={`${title} remaining`}>
        <span style={{ width: `${Math.max(0, Math.min(100, remaining ?? 0))}%` }} />
      </div>
      <small>重置：{formatReset(window?.resetsAt ?? null)}</small>
    </article>
  );
}

function RuntimeDashboard({ runtime }: { runtime: RuntimeUsageSnapshot }) {
  const { snapshot } = runtime;
  const local = snapshot.local;
  return (
    <main className="dashboard">
      <section className="hero">
        <div>
          <p className="eyebrow">LOCAL-FIRST USAGE DASHBOARD</p>
          <h1>{runtime.displayName}</h1>
          <p className="subtle">刷新于 {new Date(snapshot.refreshedAt).toLocaleTimeString()}</p>
        </div>
        <span className={`status status-${runtime.status}`}>{runtime.status}</span>
      </section>

      <section className="quota-grid">
        <QuotaCard title="短窗口剩余" window={snapshot.primary} />
        <QuotaCard title="长窗口剩余" window={snapshot.secondary} />
      </section>

      <section className="stats-grid">
        <article className="stat-card"><p>今日 Token</p><strong>{formatTokens(local?.todayTokens)}</strong></article>
        <article className="stat-card"><p>7 日 Token</p><strong>{formatTokens(local?.sevenDayTokens)}</strong></article>
        <article className="stat-card"><p>累计 Token</p><strong>{formatTokens(local?.lifetimeTokens)}</strong></article>
        <article className="stat-card"><p>本地线程</p><strong>{local?.threadCount ?? "--"}</strong></article>
      </section>

      <section className="panel">
        <div className="panel-heading"><h2>最近线程</h2><span>{local?.recentThreads.length ?? 0}</span></div>
        {local?.recentThreads.length ? (
          <ul className="thread-list">
            {local.recentThreads.map((thread) => <li key={thread.id}><span>{thread.title}</span><strong>{formatTokens(thread.tokens)}</strong></li>)}
          </ul>
        ) : <p className="empty">尚未读取到本地线程记录。</p>}
      </section>

      {snapshot.diagnostics.length > 0 && (
        <section className="panel diagnostics">
          <div className="panel-heading"><h2>数据诊断</h2></div>
          <ul>{snapshot.diagnostics.map((item) => <li key={`${item.code}-${item.message}`} className={item.severity}>{item.message}</li>)}</ul>
        </section>
      )}
    </main>
  );
}

export default function App() {
  const { settings, snapshot, isLoading, error, bootstrap, refresh, updateSettings } = useUsageStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => { void bootstrap(); }, [bootstrap]);
  useEffect(() => {
    const unlisten = listen("tokenusage://refresh-requested", () => { void refresh(); });
    return () => { void unlisten.then((dispose) => dispose()); };
  }, [refresh]);
  useEffect(() => {
    const unlisten = listen("tokenusage://open-settings", () => setSettingsOpen(true));
    return () => { void unlisten.then((dispose) => dispose()); };
  }, []);

  const runtime = snapshot?.runtimes.find((item) => item.scope === settings?.selectedRuntime) ?? snapshot?.runtimes[0];
  return (
    <div className="app-shell" data-theme={settings?.theme ?? "system"}>
      <header className="topbar">
        <div className="brand"><span>◒</span> TokenUsage</div>
        <div className="actions">
          <button onClick={() => void refresh()} disabled={isLoading}>{isLoading ? "读取中…" : "刷新"}</button>
          <button className="ghost" onClick={() => setSettingsOpen(true)}>设置</button>
          <button className="ghost" onClick={() => void updateSettings({ theme: settings?.theme === "dark" ? "light" : "dark" })}>切换主题</button>
        </div>
      </header>
      {settingsOpen && settings && (
        <aside className="settings-drawer" aria-label="设置">
          <div className="panel-heading"><h2>设置</h2><button className="ghost" onClick={() => setSettingsOpen(false)}>关闭</button></div>
          <label>外观
            <select value={settings.theme} onChange={(event) => void updateSettings({ theme: event.target.value as AppSettings["theme"] })}>
              <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
            </select>
          </label>
          <label className="toggle-row"><span>关闭窗口后驻留托盘</span><input type="checkbox" checked={settings.keepRunningWhenMainWindowClosed} onChange={(event) => void updateSettings({ keepRunningWhenMainWindowClosed: event.target.checked })} /></label>
          <label className="toggle-row"><span>自动检查更新</span><input type="checkbox" checked={settings.automaticUpdateChecksEnabled} onChange={(event) => void updateSettings({ automaticUpdateChecksEnabled: event.target.checked })} /></label>
          <label>Codex CLI 路径（可选）
            <input defaultValue={settings.codexExecutablePath ?? ""} placeholder="例如 C:\\Tools\\codex.exe" onBlur={(event) => void updateSettings({ codexExecutablePath: event.target.value.trim() || null })} />
          </label>
          <p className="settings-note">配置可运行的 Codex CLI 后，TokenUsage 才能读取官方额度；本地 SQLite 统计不依赖该路径。</p>
        </aside>
      )}
      {error ? <section className="fatal"><h1>无法读取本地数据</h1><p>{error}</p></section> : runtime ? <RuntimeDashboard runtime={runtime} /> : <section className="loading">正在初始化 TokenUsage…</section>}
    </div>
  );
}
