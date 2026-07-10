import React, { useEffect, useState, useMemo, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { formatTokens, formatReset } from "./format";
import { useUsageStore } from "./store";
import type {
  AppSettings,
  LocalThread,
  RateWindow,
  RuntimeScope,
  RuntimeUsageSnapshot,
  TokenBreakdown,
} from "./types";

/* ========================================================
   Helpers
   ======================================================== */

function sanitizeThreadTitle(thread: LocalThread): string {
  const raw = thread.title || "Untitled";
  if (raw.includes("\\") || raw.includes("/")) {
    const parts = raw.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || raw;
  }
  if (raw.length > 60) return raw.slice(0, 57) + "...";
  return raw;
}

function shortCwd(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || cwd;
}

function formatShortTime(iso: string | null): string {
  if (!iso) return "--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "--";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "刚刚";
  if (diffMins < 60) return `${diffMins} 分钟前`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays} 天前`;
  return d.toLocaleDateString();
}

function formatUSD(v: number | null | undefined): string {
  if (v == null) return "--";
  return `$${v.toFixed(2)}`;
}

function formatCompactUSD(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function statusText(status: string): string {
  switch (status) {
    case "available": return "在线";
    case "localOnly": return "本地";
    case "snapshotNeeded": return "待快照";
    case "stale": return "过期";
    default: return "离线";
  }
}

function generateThreadId(index: number, prefix: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor((index * (i + 1) * 7) % chars.length)];
  }
  return `${prefix}-${id}`;
}

function getPriorityFromTokens(tokens: number): "high" | "normal" | "low" {
  if (tokens > 50000) return "high";
  if (tokens > 10000) return "normal";
  return "low";
}

/* ========================================================
   SVG Icons
   ======================================================== */

const IconRefresh = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
  </svg>
);

const IconSettings = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const IconSun = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="5" />
    <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </svg>
);

const IconMoon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const IconAuto = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3v18M3 12h18" />
  </svg>
);

const IconCalendar = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);

const IconSum = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 7v10M6 7v10M6 12h12" />
  </svg>
);

const IconList = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
  </svg>
);

const IconChart = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
  </svg>
);

const IconBarChart = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="13" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" />
  </svg>
);

const IconStar = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

const IconTarget = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />
  </svg>
);

const IconPin = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
  </svg>
);

const IconClose = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const IconSparkle = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z" />
  </svg>
);

const IconClock = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
  </svg>
);

/* ========================================================
   DualQuotaRing
   ======================================================== */

function DualQuotaRing({ primary, secondary }: { primary: RateWindow | null; secondary: RateWindow | null }) {
  const size = 160;
  const cx = size / 2;
  const cy = size / 2;
  const outerR = 62;
  const innerR = 42;
  const strokeW = 14;

  const outerFrac = primary ? Math.max(0, Math.min(1, primary.remainingPercent / 100)) : 0;
  const innerFrac = secondary ? Math.max(0, Math.min(1, secondary.remainingPercent / 100)) : 0;
  const outerCirc = 2 * Math.PI * outerR;
  const innerCirc = 2 * Math.PI * innerR;

  const outerPct = primary ? Math.round(primary.remainingPercent) : null;
  const innerPct = secondary ? Math.round(secondary.remainingPercent) : null;

  return (
    <div className="quota-rings">
      <svg viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <linearGradient id="outerGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#7BA0FF" />
            <stop offset="50%" stopColor="#2866F7" />
            <stop offset="100%" stopColor="#A8C8FF" />
          </linearGradient>
          <linearGradient id="innerGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#DAA3FA" />
            <stop offset="50%" stopColor="#8B6DFF" />
            <stop offset="100%" stopColor="#E0C0FF" />
          </linearGradient>
        </defs>
        <circle className="ring-track" cx={cx} cy={cy} r={outerR} strokeWidth={strokeW} />
        {outerFrac > 0.001 && (
          <circle
            className="ring-fill ring-outer-fill"
            cx={cx} cy={cy} r={outerR}
            strokeWidth={strokeW}
            strokeDasharray={`${outerCirc} ${outerCirc}`}
            strokeDashoffset={outerCirc * (1 - outerFrac)}
          />
        )}
        <circle className="ring-track" cx={cx} cy={cy} r={innerR} strokeWidth={strokeW} />
        {innerFrac > 0.001 && (
          <circle
            className="ring-fill ring-inner-fill"
            cx={cx} cy={cy} r={innerR}
            strokeWidth={strokeW}
            strokeDasharray={`${innerCirc} ${innerCirc}`}
            strokeDashoffset={innerCirc * (1 - innerFrac)}
          />
        )}
      </svg>
      <div className="quota-rings-center">
        <div className="ring-label primary">
          <span className="tag">5h</span>
          <span className="pct">{outerPct != null ? `${outerPct}%` : "--"}</span>
        </div>
        <div className="ring-label secondary">
          <span className="tag">7d</span>
          <span className="pct">{innerPct != null ? `${innerPct}%` : "--"}</span>
        </div>
        <div className="remaining-label">剩余</div>
      </div>
    </div>
  );
}

/* ========================================================
   QuotaResetSummary
   ======================================================== */

function QuotaResetSummary({ primary, secondary }: { primary: RateWindow | null; secondary: RateWindow | null }) {
  return (
    <div className="quota-reset-summary">
      <div className="quota-reset-line">
        <span className="dot primary" />
        <span className="title primary">5h</span>
        <span className="label">重置</span>
        <span className="time">{formatReset(primary?.resetsAt ?? null)}</span>
      </div>
      <div className="quota-reset-line">
        <span className="dot secondary" />
        <span className="title secondary">7d</span>
        <span className="label">重置</span>
        <span className="time">{formatReset(secondary?.resetsAt ?? null)}</span>
      </div>
    </div>
  );
}

/* ========================================================
   TokenSplitBar
   ======================================================== */

function TokenSplitBar({ tokens }: { tokens: TokenBreakdown | null | undefined }) {
  if (!tokens) return <div className="token-split-bar" />;
  const total = tokens.inputTokens + tokens.cachedInputTokens + tokens.outputTokens;
  if (total === 0) return <div className="token-split-bar" />;
  return (
    <div className="token-split-bar">
      <div style={{ width: `${(tokens.inputTokens / total) * 100}%`, background: "var(--data-input)" }} />
      <div style={{ width: `${(tokens.cachedInputTokens / total) * 100}%`, background: "var(--data-cached)" }} />
      <div style={{ width: `${(tokens.outputTokens / total) * 100}%`, background: "var(--data-output)" }} />
    </div>
  );
}

/* ========================================================
   TokenSplitLegend
   ======================================================== */

function TokenSplitLegend({ tokens }: { tokens: TokenBreakdown | null | undefined }) {
  const rows = [
    { label: "未缓存", value: tokens?.inputTokens, color: "var(--data-input)" },
    { label: "缓存", value: tokens?.cachedInputTokens, color: "var(--data-cached)" },
    { label: "输出", value: tokens?.outputTokens, color: "var(--data-output)" },
  ];
  return (
    <div className="token-split-legend">
      {rows.map((r) => (
        <div key={r.label} className="legend-row">
          <span className="dot" style={{ background: r.color }} />
          <span className="label">{r.label}</span>
          <span className="value">{formatTokens(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

/* ========================================================
   DetailedTokenMetricCard
   ======================================================== */

function DetailedTokenMetricCard({
  title, icon, usage, fallbackTokens,
}: {
  title: string;
  icon: React.ReactNode;
  usage: { tokens: TokenBreakdown; estimatedCostUsd: number | null } | null | undefined;
  fallbackTokens: number | null | undefined;
}) {
  const displayTokens = usage?.tokens.totalTokens ?? fallbackTokens;
  return (
    <div className="token-card">
      <div className="token-card-header">
        <span className="token-card-icon">{icon}</span>
        <span className="token-card-title">{title}</span>
        <span className="token-card-cost">{formatUSD(usage?.estimatedCostUsd)}</span>
      </div>
      <div className="token-card-value">{formatTokens(displayTokens)}</div>
      <TokenSplitBar tokens={usage?.tokens} />
      <TokenSplitLegend tokens={usage?.tokens} />
    </div>
  );
}

/* ========================================================
   WoolProgressCard
   ======================================================== */

const MILESTONES = [
  { id: "plus", title: "Plus", amount: 20, color: "var(--status-info)" },
  { id: "pro100", title: "Pro100", amount: 100, color: "var(--brand-secondary)" },
  { id: "pro200", title: "Pro200", amount: 200, color: "var(--brand-primary-light)" },
];

function WoolProgressCard({ usage }: { usage: { estimatedCostUsd: number | null } | null | undefined }) {
  const cost = usage?.estimatedCostUsd ?? 0;
  const maxValue = 500;
  const fillPct = Math.min(100, (cost / maxValue) * 100);

  return (
    <div className="wool-progress">
      <div className="wool-progress-header">
        <span className="wool-progress-icon">
          <IconSparkle />
        </span>
        <span className="wool-progress-title">羊毛进度</span>
        <span className="wool-progress-amount">{formatUSD(usage?.estimatedCostUsd)}</span>
        <span className="wool-progress-max">/ {formatCompactUSD(maxValue)}</span>
      </div>
      <div className="wool-progress-bar">
        {cost > 0 && (
          <div className="wool-progress-fill" style={{ width: `${Math.max(2, fillPct)}%` }} />
        )}
        {MILESTONES.map((m) => {
          const leftPct = (m.amount / maxValue) * 100;
          return (
            <div
              key={m.id}
              title={`${m.title} ${formatUSD(m.amount)}`}
              style={{
                position: "absolute",
                left: `${leftPct}%`,
                top: "50%",
                transform: "translate(-50%, -50%)",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: m.color,
                border: "1.5px solid rgba(255,255,255,0.8)",
              }}
            />
          );
        })}
      </div>
      <div className="wool-progress-milestones">
        {MILESTONES.map((m) => (
          <div key={m.id} className="milestone">
            <span className="dot" style={{ background: m.color }} />
            {m.title}
          </div>
        ))}
        <span className="wool-progress-cap">满额 {formatCompactUSD(maxValue)}</span>
      </div>
    </div>
  );
}

/* ========================================================
   TitleBar
   ======================================================== */

function TitleBar({
  runtimes, selectedScope, onSelectRuntime,
  isPinned, onTogglePin, isRefreshing, onRefresh, onOpenSettings, onClose,
  theme, onToggleTheme,
}: {
  runtimes: RuntimeUsageSnapshot[];
  selectedScope: RuntimeScope;
  onSelectRuntime: (s: RuntimeScope) => void;
  isPinned: boolean;
  onTogglePin: () => void;
  isRefreshing: boolean;
  onRefresh: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
  theme: string;
  onToggleTheme: () => void;
}) {
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left" data-tauri-drag-region="false">
        <div className="titlebar-brand">
          <div className="titlebar-brand-icon">U</div>
          <span>codexU</span>
        </div>
      </div>

      <div className="titlebar-center" data-tauri-drag-region="false">
        {runtimes.length > 1 && (
          <div className="runtime-selector">
            {runtimes.map((rt) => (
              <button
                key={rt.scope}
                className={`runtime-btn${selectedScope === rt.scope ? " active" : ""}`}
                onClick={() => onSelectRuntime(rt.scope)}
              >
                {rt.scope === "codex" ? "Codex" : "Claude Code"}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="titlebar-controls" data-tauri-drag-region="false">
        <div className="theme-switch">
          <button
            className={`theme-btn${theme === "dark" ? " active" : ""}`}
            onClick={onToggleTheme}
            title="深色模式"
          >
            <IconMoon />
          </button>
          <button
            className={`theme-btn${theme === "light" ? " active" : ""}`}
            onClick={onToggleTheme}
            title="浅色模式"
          >
            <IconSun />
          </button>
        </div>

        <div className="lang-switch">
          <button className="lang-btn active">中</button>
          <button className="lang-btn">EN</button>
        </div>

        <div className="pro-badge">PRO</div>

        <div className="titlebar-divider" />

        <div className="titlebar-btn-group">
          <button
            className={`titlebar-btn${isPinned ? " active" : ""}`}
            onClick={onTogglePin}
            title="置顶"
          >
            <IconPin />
          </button>
          <button className="titlebar-btn" onClick={onRefresh} title="刷新" disabled={isRefreshing}>
            <IconRefresh />
          </button>
          <button className="titlebar-btn" onClick={onOpenSettings} title="设置">
            <IconSettings />
          </button>
          <button className="titlebar-btn" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </div>
      </div>
    </header>
  );
}

/* ========================================================
   Overview Section
   ======================================================== */

function OverviewSection({ runtime }: { runtime: RuntimeUsageSnapshot }) {
  const { snapshot } = runtime;
  const local = snapshot.local;
  const detailed = local?.detailedUsage;

  return (
    <section className="glass-section overview">
      <div className="overview-left">
        <DualQuotaRing primary={snapshot.primary} secondary={snapshot.secondary} />
        <QuotaResetSummary primary={snapshot.primary} secondary={snapshot.secondary} />
      </div>
      <div className="overview-right">
        <div className="token-cards">
          <DetailedTokenMetricCard
            title="今日"
            icon={<IconSun />}
            usage={detailed?.today}
            fallbackTokens={local?.todayTokens}
          />
          <DetailedTokenMetricCard
            title="近 7 天"
            icon={<IconCalendar />}
            usage={detailed?.sevenDay}
            fallbackTokens={local?.sevenDayTokens}
          />
          <DetailedTokenMetricCard
            title="累计"
            icon={<IconSum />}
            usage={detailed?.lifetime}
            fallbackTokens={local?.lifetimeTokens}
          />
        </div>
        <WoolProgressCard usage={detailed?.month} />
      </div>
    </section>
  );
}

/* ========================================================
   Tasks Tab — Kanban-style board (4 columns)
   ======================================================== */

function TasksTab({ threads }: { threads: LocalThread[] }) {
  const columns = useMemo(() => {
    const sorted = [...threads].sort((a, b) => {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return tb - ta;
    });
    const active = sorted.filter((t) => !t.archived);
    const done = sorted.filter((t) => t.archived).slice(0, 8);
    return [
      { id: "active", title: "进行中", items: active.slice(0, 4), color: "active" },
      { id: "pending", title: "待处理", items: active.slice(4, 6), color: "pending" },
      { id: "scheduled", title: "定时", items: active.slice(6, 8), color: "scheduled" },
      { id: "done", title: "完成", items: done, color: "done" },
    ];
  }, [threads]);

  if (!threads.length) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">&#128196;</div>
        <div className="empty-state-title">暂无本地线程记录</div>
        <div>使用 Codex 后，线程数据将自动出现</div>
      </div>
    );
  }

  return (
    <div className="kanban-board">
      {columns.map((col, colIdx) => (
        <div key={col.id} className="kanban-column">
          <div className="kanban-column-header">
            <span className={`kanban-column-dot ${col.color}`} />
            <span className="kanban-column-title">{col.title}</span>
            <span className="kanban-column-count">{col.items.length}</span>
            <span className="kanban-column-more">...</span>
          </div>
          {col.items.length > 0 ? (
            <div className="kanban-items">
              {col.items.map((thread, idx) => {
                const priority = getPriorityFromTokens(thread.tokens || 0);
                const threadId = generateThreadId(colIdx * 10 + idx, col.id === "active" ? "COD" : col.id === "scheduled" ? "AUTO" : "COD");
                const projectName = shortCwd(thread.cwd || "");
                return (
                  <div key={thread.id} className="kanban-item">
                    <div className="kanban-item-header">
                      <span className="kanban-item-id">{threadId}</span>
                      <span className="kanban-item-time">{formatRelativeTime(thread.updatedAt)}</span>
                    </div>
                    <span className="kanban-item-name" title={thread.title}>
                      {sanitizeThreadTitle(thread)}
                    </span>
                    <div className="kanban-item-meta">
                      <span className="kanban-item-project">{projectName}</span>
                      <span className="kanban-item-tokens">{formatTokens(thread.tokens)}</span>
                      <span className={`kanban-item-badge ${priority}`}>
                        {priority === "high" ? "High" : priority === "normal" ? "Normal" : "Low"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="kanban-empty">
              <IconClock />
              <span>暂无</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ========================================================
   Trends Tab
   ======================================================== */

function TrendsTab({ local }: { local: NonNullable<RuntimeUsageSnapshot["snapshot"]["local"]> }) {
  const buckets = local.dailyBuckets ?? [];
  const detailed = local.detailedUsage;
  const trend = local.usageTrend;

  const heatmapWeeks = useMemo(() => {
    if (!trend?.heatmapWeeks) return [];
    return trend.heatmapWeeks;
  }, [trend]);

  const sevenDaySummary = useMemo(() => {
    if (!trend?.summary) return null;
    return {
      tokens: trend.summary.sevenDay.tokens.visibleTotalTokens,
      change: trend.summary.changePercent,
      isNew: trend.summary.isNewActivity,
    };
  }, [trend]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
        <div className="trend-card">
          <div className="trend-card-header">
            <span className="trend-card-title">最近半年用量</span>
          </div>
          <div className="heatmap-container">
            <div className="heatmap-weeks">
              {heatmapWeeks.length > 0 ? (
                heatmapWeeks.slice(0, 26).map((week: any, wi: number) => (
                  <div key={wi} className="heatmap-week">
                    {week.map((day: any, di: number) => {
                      const tokens = day.tokens || 0;
                      let level = 0;
                      if (tokens > 0) {
                        const thresholds = trend?.heatmapThresholds || [1000, 5000, 20000, 80000];
                        if (tokens >= thresholds[3]) level = 4;
                        else if (tokens >= thresholds[2]) level = 3;
                        else if (tokens >= thresholds[1]) level = 2;
                        else if (tokens >= thresholds[0]) level = 1;
                      }
                      return (
                        <div
                          key={di}
                          className={`heatmap-cell${level > 0 ? ` level-${level}` : ""}`}
                          title={day.date ? new Date(day.date).toLocaleDateString() : ""}
                        />
                      );
                    })}
                  </div>
                ))
              ) : (
                <div style={{ opacity: 0.3, fontSize: 11, color: "var(--text-tertiary)" }}>
                  暂无热力图数据
                </div>
              )}
            </div>
            <div className="heatmap-labels">
              <span>少</span>
              <span>多</span>
            </div>
          </div>
        </div>

        <div className="trend-card">
          <div className="trend-card-header">
            <span className="trend-card-title">最近 7 日</span>
            {sevenDaySummary && (
              <span className="trend-card-sub">
                {sevenDaySummary.isNew
                  ? "新增活跃"
                  : sevenDaySummary.change != null
                  ? `${sevenDaySummary.change >= 0 ? "+" : ""}${sevenDaySummary.change.toFixed(0)}%`
                  : ""}
              </span>
            )}
          </div>
          {buckets.length > 0 ? (
            <SevenDayLineChart buckets={buckets} />
          ) : (
            <div className="empty-state" style={{ padding: "20px" }}>暂无趋势数据</div>
          )}
          <div style={{ marginTop: "8px", fontSize: "12px", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
            {formatTokens(sevenDaySummary?.tokens)}
            <span style={{ fontSize: "11px", color: "var(--text-tertiary)", marginLeft: "4px", fontWeight: 500 }}>总量</span>
          </div>
        </div>
      </div>

      {detailed && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
          <div className="trend-card">
            <div className="trend-card-header">
              <span className="trend-card-title">Token 拆分（今日）</span>
            </div>
            <TokenSplitBar tokens={detailed.today.tokens} />
            <div style={{ marginTop: "8px" }}>
              <TokenSplitLegend tokens={detailed.today.tokens} />
            </div>
          </div>
          <div className="trend-card">
            <div className="trend-card-header">
              <span className="trend-card-title">Token 拆分（近 7 天）</span>
            </div>
            <TokenSplitBar tokens={detailed.sevenDay.tokens} />
            <div style={{ marginTop: "8px" }}>
              <TokenSplitLegend tokens={detailed.sevenDay.tokens} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SevenDayLineChart({ buckets }: { buckets: { id: string; label: string; tokens: number }[] }) {
  const values = buckets.map((b) => b.tokens);
  const max = Math.max(...values, 1);
  const width = 280;
  const height = 100;
  const padding = { top: 10, right: 4, bottom: 20, left: 4 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const points = values.map((v, i) => {
    const x = padding.left + (i / Math.max(values.length - 1, 1)) * chartW;
    const y = padding.top + chartH - (v / max) * chartH;
    return `${x},${y}`;
  });

  const areaPath = `
    M ${padding.left},${padding.top + chartH}
    L ${points.join(" L ")}
    L ${padding.left + chartW},${padding.top + chartH}
    Z
  `;

  return (
    <div className="line-chart-container">
      <svg className="line-chart-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="areaGradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#7BA0FF" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#7BA0FF" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#areaGradient)" />
        <polyline
          points={points.join(" ")}
          fill="none"
          stroke="#7BA0FF"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {values.map((v, i) => {
          const x = padding.left + (i / Math.max(values.length - 1, 1)) * chartW;
          const y = padding.top + chartH - (v / max) * chartH;
          return (
            <circle key={i} cx={x} cy={y} r="3.5" fill="#2866F7" stroke="white" strokeWidth="1.5" />
          );
        })}
        {buckets.map((b, i) => {
          const x = padding.left + (i / Math.max(values.length - 1, 1)) * chartW;
          return (
            <text
              key={i}
              x={x}
              y={height - 4}
              textAnchor="middle"
              fontSize="9"
              fill="var(--text-tertiary)"
            >
              {b.label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

/* ========================================================
   Projects Tab
   ======================================================== */

function ProjectsTab({ threads }: { threads: LocalThread[] }) {
  const projects = useMemo(() => {
    const map = new Map<string, { cwd: string; tokens: number; count: number; lastActive: string | null }>();
    for (const t of threads) {
      const dir = shortCwd(t.cwd);
      const entry = map.get(dir) || { cwd: dir, tokens: 0, count: 0, lastActive: null };
      entry.tokens += t.tokens;
      entry.count += 1;
      if (!entry.lastActive || (t.updatedAt && t.updatedAt > entry.lastActive)) {
        entry.lastActive = t.updatedAt;
      }
      map.set(dir, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.tokens - a.tokens).slice(0, 24);
  }, [threads]);

  const activeCount = projects.filter((p) => p.count > 0).length;

  if (!projects.length) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">&#128193;</div>
        <div className="empty-state-title">暂无项目数据</div>
      </div>
    );
  }

  const maxTokens = projects[0]?.tokens ?? 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div className="project-overview">
        <div className="project-overview-card">
          <h4>活跃项目排行</h4>
          <div className="project-overview-value">{activeCount}</div>
          <div className="project-overview-sub">近 7 天活跃</div>
        </div>
        <div className="project-overview-card">
          <h4>项目活动概览</h4>
          <div className="project-overview-value">{projects.length}</div>
          <div className="project-overview-sub">全部项目</div>
        </div>
      </div>

      <div className="project-list">
        {projects.map((proj, idx) => (
          <div key={proj.cwd} className="project-item">
            <span className="project-rank">{idx + 1}</span>
            <span className="project-name" title={proj.cwd}>{proj.cwd}</span>
            <div className="project-bar-wrap">
              <div className="project-bar" style={{ width: `${(proj.tokens / maxTokens) * 100}%` }} />
            </div>
            <span className="project-tokens">{formatTokens(proj.tokens)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ========================================================
   Skills Tab
   ======================================================== */

function SkillsTab() {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">&#9889;</div>
      <div className="empty-state-title">Skill 分析即将推出</div>
      <div>此功能将在后续版本中提供</div>
    </div>
  );
}

/* ========================================================
   Settings Modal
   ======================================================== */

function SettingsModal({
  settings, onClose, onUpdate,
}: {
  settings: AppSettings;
  onClose: () => void;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <h2>设置</h2>
        <div className="settings-group">
          <div className="settings-field">
            <label>外观主题</label>
            <select value={settings.theme} onChange={(e) => onUpdate({ theme: e.target.value as AppSettings["theme"] })}>
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </div>
          <div className="settings-field">
            <label>语言</label>
            <select value={settings.language} onChange={(e) => onUpdate({ language: e.target.value as AppSettings["language"] })}>
              <option value="auto">自动</option>
              <option value="zh-CN">中文</option>
              <option value="en-US">English</option>
            </select>
          </div>
          <div className="settings-field">
            <label>默认 Runtime</label>
            <select value={settings.selectedRuntime} onChange={(e) => onUpdate({ selectedRuntime: e.target.value as RuntimeScope })}>
              <option value="codex">Codex</option>
              <option value="claudeCode">Claude Code</option>
            </select>
          </div>
          <div className="settings-field">
            <label>额度显示</label>
            <select value={settings.showUsedQuota ? "used" : "remaining"} onChange={(e) => onUpdate({ showUsedQuota: e.target.value === "used" })}>
              <option value="remaining">显示剩余</option>
              <option value="used">显示已用</option>
            </select>
          </div>
          <div className="settings-toggle">
            <span>关闭窗口后驻留托盘</span>
            <input type="checkbox" checked={settings.keepRunningWhenMainWindowClosed} onChange={(e) => onUpdate({ keepRunningWhenMainWindowClosed: e.target.checked })} />
          </div>
          <div className="settings-toggle">
            <span>主窗口置顶</span>
            <input type="checkbox" checked={settings.keepMainWindowOnTop} onChange={(e) => onUpdate({ keepMainWindowOnTop: e.target.checked })} />
          </div>
          <div className="settings-toggle">
            <span>自动检查更新</span>
            <input type="checkbox" checked={settings.automaticUpdateChecksEnabled} onChange={(e) => onUpdate({ automaticUpdateChecksEnabled: e.target.checked })} />
          </div>
          <div className="settings-field">
            <label>Codex CLI 路径（可选）</label>
            <input defaultValue={settings.codexExecutablePath ?? ""} placeholder="例如 C:\Tools\codex.exe" onBlur={(e) => onUpdate({ codexExecutablePath: e.target.value.trim() || null })} />
          </div>
        </div>
        <div className="settings-actions">
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}

/* ========================================================
   Main App
   ======================================================== */

type TabId = "tasks" | "trends" | "projects" | "skills";

const TABS: { id: TabId; label: string; icon: () => React.ReactNode }[] = [
  { id: "tasks", label: "今日任务", icon: IconList },
  { id: "trends", label: "用量趋势", icon: IconChart },
  { id: "projects", label: "项目排行", icon: IconBarChart },
  { id: "skills", label: "Skill", icon: IconStar },
];

export default function App() {
  const { settings, snapshot, isLoading, error, bootstrap, refresh, updateSettings } = useUsageStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("tasks");
  const [uiTheme, setUiTheme] = useState<"light" | "dark">("dark");

  useEffect(() => { void bootstrap(); }, [bootstrap]);
  useEffect(() => {
    const unlisten = listen("tokenusage://refresh-requested", () => { void refresh(); });
    return () => { unlisten.then((d: () => void) => d()); };
  }, [refresh]);
  useEffect(() => {
    const unlisten = listen("tokenusage://open-settings", () => setSettingsOpen(true));
    return () => { unlisten.then((d: () => void) => d()); };
  }, []);

  const handleRefresh = useCallback(() => { void refresh(); }, [refresh]);
  const handleUpdateSettings = useCallback(
    (patch: Partial<AppSettings>) => { void updateSettings(patch); },
    [updateSettings],
  );

  const handleToggleTheme = useCallback(() => {
    setUiTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  const handleClose = useCallback(() => {
    if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        getCurrentWindow().hide();
      });
    }
  }, []);

  const runtime = snapshot?.runtimes.find((r) => r.scope === settings?.selectedRuntime) ?? snapshot?.runtimes[0];

  const dashboardSummary = useMemo(() => {
    if (!runtime) return "读取中";
    const local = runtime.snapshot.local;
    switch (activeTab) {
      case "tasks": {
        const count = local?.recentThreads?.length ?? 0;
        return `${count} 事项`;
      }
      case "trends":
        return local?.dailyBuckets ? `${local.dailyBuckets.length} 活跃日` : "读取中";
      case "projects": {
        const set = new Set(local?.recentThreads?.map((t) => shortCwd(t.cwd)) ?? []);
        return `${set.size} 活跃项目 · ${set.size} 全部`;
      }
      case "skills":
        return "0 Skill · 0 工具";
    }
  }, [activeTab, runtime]);

  if (error) {
    return (
      <div className="app-shell">
        <div className="fatal-error">
          <h1>无法读取本地数据</h1>
          <p>{error}</p>
          <button className="btn-primary" style={{ marginTop: 4, padding: "7px 16px", borderRadius: 6, background: "var(--brand-primary)", color: "white", fontSize: 12 }} onClick={() => void bootstrap()}>
            重试
          </button>
        </div>
      </div>
    );
  }

  if (!runtime || isLoading) {
    return (
      <div className="app-shell">
        <div className="loading-state">正在初始化 TokenUsage…</div>
      </div>
    );
  }

  return (
    <div className="app-shell" data-theme={uiTheme}>
      <TitleBar
        runtimes={snapshot?.runtimes ?? []}
        selectedScope={runtime.scope}
        onSelectRuntime={(scope) => handleUpdateSettings({ selectedRuntime: scope })}
        isPinned={settings?.keepMainWindowOnTop ?? false}
        onTogglePin={() => handleUpdateSettings({ keepMainWindowOnTop: !settings?.keepMainWindowOnTop })}
        isRefreshing={isLoading}
        onRefresh={handleRefresh}
        onOpenSettings={() => setSettingsOpen(true)}
        onClose={handleClose}
        theme={uiTheme}
        onToggleTheme={handleToggleTheme}
      />

      {settingsOpen && settings && (
        <SettingsModal settings={settings} onClose={() => setSettingsOpen(false)} onUpdate={handleUpdateSettings} />
      )}

      <div className="main-content">
        <OverviewSection runtime={runtime} />

        <section className="glass-section workspace">
          <div className="tab-bar">
            <div className="tab-switch">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  className={`tab-btn${activeTab === tab.id ? " active" : ""}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span className="tab-icon"><tab.icon /></span>
                  {tab.label}
                </button>
              ))}
            </div>
            <span className="tab-summary">{dashboardSummary}</span>
          </div>
          <div className="tab-content">
            {activeTab === "tasks" && <TasksTab threads={runtime.snapshot.local?.recentThreads ?? []} />}
            {activeTab === "trends" && runtime.snapshot.local && <TrendsTab local={runtime.snapshot.local} />}
            {activeTab === "trends" && !runtime.snapshot.local && (
              <div className="empty-state">
                <div className="empty-state-icon">&#128200;</div>
                <div className="empty-state-title">暂无本地统计数据</div>
              </div>
            )}
            {activeTab === "projects" && <ProjectsTab threads={runtime.snapshot.local?.recentThreads ?? []} />}
            {activeTab === "skills" && <SkillsTab />}
          </div>
        </section>

        {runtime.snapshot.diagnostics.length > 0 && (
          <div className="glass-section diagnostics-panel">
            <h3>数据诊断</h3>
            <div className="diagnostics-list">
              {runtime.snapshot.diagnostics.map((item) => (
                <div key={`${item.code}-${item.message}`} className={`diagnostics-item severity-${item.severity}`}>
                  <span className="icon">!</span>
                  <div className="content">
                    <div className="title">{item.code}</div>
                    <div className="detail">{item.message}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <footer className="footer">
        <div className="footer-left">
          <span className={`status-dot ${runtime.status === "available" ? "ok" : runtime.status === "unavailable" ? "err" : "warn"}`} />
          <span className="footer-refreshed">
            {runtime.displayName} · {statusText(runtime.status)}
          </span>
        </div>
        <span className="footer-refreshed">
          刷新 {new Date(runtime.snapshot.refreshedAt).toLocaleTimeString()}
        </span>
        <span className="footer-shortcut">Alt + U</span>
      </footer>
    </div>
  );
}
