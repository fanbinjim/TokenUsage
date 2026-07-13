import React, { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { formatTokens, formatReset } from "./format";
import { createMockDashboardSnapshot, MOCK_SETTINGS } from "./mockDashboard";
import { useUsageStore } from "./store";
import type {
  AppSettings,
  DailyTokenBucket,
  LocalThread,
  MultiRuntimeUsageSnapshot,
  NamedUsage,
  ProjectUsage,
  RateWindow,
  RuntimeScope,
  RuntimeUsageSnapshot,
  TokenBreakdown,
} from "./types";

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

const appIconUrl = new URL("../src-tauri/icons/icon.png", import.meta.url).href;

/* ========================================================
   Helpers
   ======================================================== */

export function safeThreadLabel(thread: LocalThread): string {
  const title = thread.title.trim().replace(/\s+/g, " ");
  if (title) return title;
  const suffix = thread.id.replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase();
  return `会话 ${suffix || "----"}`;
}

export function taskCardId(id: string): string {
  const suffix = id.replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase();
  return `COD-${suffix || "----"}`;
}

function threadModelInitial(model: string | null): string {
  const match = model?.trim().match(/[a-z0-9]+(?=[^a-z0-9]*$)/i);
  return match?.[0]?.charAt(0).toUpperCase() || "C";
}

export function shortCwd(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1]?.slice(0, 32) || "本地项目";
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

const WOOL_MONTHLY_TOKEN_CAP = 200_000_000 * 30;
const WOOL_REFERENCE_USD_PER_MILLION = 7.75;
export const WOOL_MONTHLY_VALUE_CAP = (WOOL_MONTHLY_TOKEN_CAP / 1_000_000) * WOOL_REFERENCE_USD_PER_MILLION;

export const WOOL_MILESTONES = [
  { label: "Plus", value: 20, position: 6, color: "#0A84FF" },
  { label: "Pro100", value: 100, position: 16, color: "#9B7BFF" },
  { label: "Pro200", value: 200, position: 30, color: "#7BA0FF" },
] as const;

export function woolProgressPercent(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;

  const [plus, pro100, pro200] = WOOL_MILESTONES;
  if (value <= plus.value) return (value / plus.value) * plus.position;
  if (value <= pro100.value) {
    return plus.position + ((value - plus.value) / (pro100.value - plus.value)) * (pro100.position - plus.position);
  }
  if (value <= pro200.value) {
    return pro100.position + ((value - pro100.value) / (pro200.value - pro100.value)) * (pro200.position - pro100.position);
  }

  const logarithmicProgress = Math.log(Math.min(value, WOOL_MONTHLY_VALUE_CAP) / pro200.value)
    / Math.log(WOOL_MONTHLY_VALUE_CAP / pro200.value);
  return pro200.position + logarithmicProgress * (100 - pro200.position);
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

function getUsageLevel(tokens: number): "high" | "normal" | "low" {
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

export function dashboardQuotaPercent(window: RateWindow | null | undefined): number {
  const percent = window?.remainingPercent;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    return 100;
  }
  return Math.round(percent);
}

function DualQuotaRing({ primary, secondary }: { primary: RateWindow | null; secondary: RateWindow | null }) {
  const size = 160;
  const cx = size / 2;
  const cy = size / 2;
  const outerR = 65;
  const innerR = 46;
  const strokeW = 14;

  const outerPct = dashboardQuotaPercent(primary);
  const innerPct = dashboardQuotaPercent(secondary);
  const outerFrac = outerPct / 100;
  const innerFrac = innerPct / 100;
  const outerCirc = 2 * Math.PI * outerR;
  const innerCirc = 2 * Math.PI * innerR;

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
            <stop offset="0%" stopColor="#9DDCFF" />
            <stop offset="50%" stopColor="#32ADE6" />
            <stop offset="100%" stopColor="#7FE7DC" />
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
        <div className="ring-label primary" aria-label={`5 hours ${outerPct}% remaining`}>
          <span className="tag">5h</span>
          <span className="pct">{outerPct}%</span>
        </div>
        <div className="ring-label secondary" aria-label={`7 days ${innerPct}% remaining`}>
          <span className="tag">7d</span>
          <span className="pct">{innerPct}%</span>
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

function WoolProgressCard({ usage }: { usage: { estimatedCostUsd: number | null } | null | undefined }) {
  const estimate = usage?.estimatedCostUsd ?? null;
  const progress = woolProgressPercent(estimate);

  return (
    <div className="wool-progress">
      <div className="wool-progress-header">
        <span className="wool-progress-icon">
          <IconChart />
        </span>
        <span className="wool-progress-title">羊毛进度</span>
        <span className="wool-progress-amount">{formatUSD(estimate)}</span>
        <span className="wool-progress-max">/ {formatCompactUSD(WOOL_MONTHLY_VALUE_CAP)}</span>
      </div>
      <div
        className="wool-progress-bar"
        role="progressbar"
        aria-label="本月 API 等效价值进度"
        aria-valuemin={0}
        aria-valuemax={WOOL_MONTHLY_VALUE_CAP}
        aria-valuenow={Math.min(Math.max(estimate ?? 0, 0), WOOL_MONTHLY_VALUE_CAP)}
        aria-valuetext={`${formatUSD(estimate)} / ${formatCompactUSD(WOOL_MONTHLY_VALUE_CAP)}`}
      >
        <div className="wool-progress-fill" style={{ width: `${progress}%` }} />
        {WOOL_MILESTONES.map((milestone) => (
          <span
            key={milestone.label}
            className="wool-progress-marker"
            style={{ left: `${milestone.position}%`, backgroundColor: milestone.color }}
            title={`${milestone.label} ${formatUSD(milestone.value)}`}
          />
        ))}
      </div>
      <div className="wool-progress-milestones">
        {WOOL_MILESTONES.map((milestone) => (
          <span key={milestone.label} className="milestone">
            <span className="dot" style={{ backgroundColor: milestone.color }} />
            {milestone.label}
          </span>
        ))}
        <span className="wool-progress-cap">满额 {formatCompactUSD(WOOL_MONTHLY_VALUE_CAP)}</span>
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
          <img className="titlebar-brand-icon" src={appIconUrl} alt="" />
          <span>TokenUsage</span>
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
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const active = sorted.filter((t) => !t.archived && (t.updatedAt ? new Date(t.updatedAt).getTime() >= cutoff : false));
    const older = sorted.filter((t) => !t.archived && !active.includes(t));
    const done = sorted.filter((t) => t.archived).slice(0, 8);
    return [
      { id: "active", title: "进行中", items: active.slice(0, 8), color: "active" },
      { id: "pending", title: "待处理", items: older.slice(0, 8), color: "pending" },
      { id: "scheduled", title: "定时", items: [] as LocalThread[], color: "scheduled" },
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
      {columns.map((col) => (
        <div key={col.id} className="kanban-column">
          <div className="kanban-column-header">
            <span className={`kanban-column-dot ${col.color}`} />
            <span className="kanban-column-title">{col.title}</span>
            <span className="kanban-column-count">{col.items.length}</span>
            <span className="kanban-column-more">...</span>
          </div>
          {col.items.length > 0 ? (
            <div className="kanban-items">
              {col.items.map((thread) => {
                const usageLevel = getUsageLevel(thread.tokens || 0);
                const projectName = shortCwd(thread.cwd || "");
                const activity = col.id === "active"
                  ? { label: "活跃", tone: "active" }
                  : col.id === "done"
                  ? { label: "完成", tone: "done" }
                  : { label: "待处理", tone: "pending" };
                return (
                  <div key={thread.id} className="kanban-item">
                    <div className="kanban-item-identity">
                      <span className="kanban-item-id">{taskCardId(thread.id)}</span>
                      <span className="kanban-item-time">{formatRelativeTime(thread.updatedAt)}</span>
                    </div>
                    <span className="kanban-item-title" title={safeThreadLabel(thread)}>{safeThreadLabel(thread)}</span>
                    <div className="kanban-item-project-line">
                      <span className="kanban-item-project" title={projectName}>{projectName}</span>
                      <span className="kanban-item-separator">·</span>
                      <span className="kanban-item-tokens">{formatTokens(thread.tokens)}</span>
                    </div>
                    <div className="kanban-item-footer">
                      <span className={`kanban-item-activity ${activity.tone}`}>
                        <span className="kanban-item-activity-dot" />
                        {activity.label}
                      </span>
                      <span className={`kanban-item-badge ${usageLevel}`}>
                        {usageLevel === "high" ? "高用量" : usageLevel === "normal" ? "中用量" : "低用量"}
                      </span>
                      <span className="kanban-item-model" title={thread.model || "Codex 会话"}>{threadModelInitial(thread.model)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="kanban-empty">
              <IconClock />
              <span>{col.id === "scheduled" ? "暂无可读取定时任务" : "暂无"}</span>
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

interface HeatmapWeek {
  monthLabel: string | null;
  days: (DailyTokenBucket | null)[];
  futurePlaceholderCount: number;
}

const HEATMAP_WEEK_COUNT = 27;

export interface MonthlyUsageBucket {
  id: string;
  label: string;
  tokens: number;
}

function calendarDateId(parts: { year: number; month: number; day: number }): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function offsetCalendarDate(parts: { year: number; month: number; day: number }, offset: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function compareCalendarDates(left: { year: number; month: number; day: number }, right: { year: number; month: number; day: number }): number {
  return calendarDateId(left).localeCompare(calendarDateId(right));
}

export function buildHeatmapCalendar(days: DailyTokenBucket[], now = new Date()): HeatmapWeek[] {
  const today = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  const todayWeekday = (new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay() + 6) % 7;
  const currentMonday = offsetCalendarDate(today, -todayWeekday);
  const firstMonday = offsetCalendarDate(currentMonday, -(HEATMAP_WEEK_COUNT - 1) * 7);
  const bucketsByDate = new Map(days.map((day) => [day.id, day]));

  let visibleMonth: string | null = null;
  return Array.from({ length: HEATMAP_WEEK_COUNT }, (_, index) => {
    const calendarDays = Array.from({ length: 7 }, (_, dayIndex) => offsetCalendarDate(firstMonday, index * 7 + dayIndex));
    const weekDays = calendarDays.map((date) => (
      compareCalendarDates(date, today) > 0 ? null : bucketsByDate.get(calendarDateId(date)) ?? null
    ));
    const nextMonth = calendarDays.find((date) => `${date.year}-${date.month}` !== visibleMonth);
    const monthLabel = nextMonth ? `${nextMonth.month}月` : null;
    const lastDate = calendarDays[calendarDays.length - 1];
    visibleMonth = `${lastDate.year}-${lastDate.month}`;
    return {
      monthLabel,
      days: weekDays,
      futurePlaceholderCount: index === HEATMAP_WEEK_COUNT - 1 ? 6 - todayWeekday : 0,
    };
  });
}

export function buildHalfYearMonthlyUsage(days: DailyTokenBucket[]): MonthlyUsageBucket[] {
  const totals = new Map<string, number>();
  for (const day of days) {
    const key = day.id.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(key)) continue;
    totals.set(key, (totals.get(key) ?? 0) + Math.max(0, day.tokens));
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, tokens]) => ({ id, label: `${Number(id.slice(5, 7))}月`, tokens }));
}

function TrendsTab({ local }: { local: NonNullable<RuntimeUsageSnapshot["snapshot"]["local"]> }) {
  const [halfYearMode, setHalfYearMode] = useState<"day" | "month">("day");
  const buckets = local.dailyBuckets ?? [];
  const detailed = local.detailedUsage;
  const trend = local.usageTrend;
  const heatmapWeeks = useMemo(() => buildHeatmapCalendar(trend?.days ?? []), [trend]);
  const monthlyUsage = useMemo(() => buildHalfYearMonthlyUsage(trend?.days ?? []), [trend]);
  const heatmapThresholds = useMemo(() => {
    const values = (trend?.days ?? []).map((day) => day.tokens).filter((tokens) => tokens > 0).sort((a, b) => a - b);
    if (!values.length) return [0, 0, 0, 0];
    return [0.25, 0.5, 0.75, 1].map((quantile) => values[Math.min(values.length - 1, Math.floor((values.length - 1) * quantile))]);
  }, [trend]);
  const sevenDaySummary = trend
    ? { tokens: trend.sevenDayTokens, change: trend.changePercent, isNew: trend.isNewActivity }
    : detailed ? { tokens: detailed.sevenDay.tokens.totalTokens, change: null, isNew: false } : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div className="trends-overview-grid">
        <div className="trend-card half-year-trend-card">
          <div className="trend-card-header">
            <span className="trend-card-title">最近半年用量</span>
            <div className="half-year-granularity" role="group" aria-label="半年用量统计口径">
              <button type="button" className={halfYearMode === "day" ? "active" : ""} onClick={() => setHalfYearMode("day")} title="按日显示">日</button>
              <button type="button" className={halfYearMode === "month" ? "active" : ""} onClick={() => setHalfYearMode("month")} title="按月汇总">月</button>
            </div>
          </div>
          <div className="heatmap-container">
            {halfYearMode === "day" && heatmapWeeks.length > 0 ? (
              <>
                <div className="heatmap-calendar">
                  <div className="heatmap-month-spacer" />
                  <div className="heatmap-months" aria-hidden="true">
                    {heatmapWeeks.map((week, index) => (
                      <span key={index}>{week.monthLabel}</span>
                    ))}
                  </div>
                  <div className="heatmap-weekdays" aria-hidden="true">
                    {['一', '二', '三', '四', '五', '六', '日'].map((label) => <span key={label}>{label}</span>)}
                  </div>
                  <div className="heatmap-weeks">
                    {heatmapWeeks.map((week, wi) => (
                      <div key={wi} className="heatmap-week">
                        {week.days.map((day, di) => {
                          if (!day) {
                            const isFuture = di >= 7 - week.futurePlaceholderCount;
                            return <div key={di} className={`heatmap-cell${isFuture ? " is-future-placeholder" : ""}`} aria-hidden="true" />;
                          }
                          const tokens = day.tokens || 0;
                          let level = 0;
                          if (tokens > 0) {
                            if (tokens >= heatmapThresholds[3]) level = 4;
                            else if (tokens >= heatmapThresholds[2]) level = 3;
                            else if (tokens >= heatmapThresholds[1]) level = 2;
                            else if (tokens >= heatmapThresholds[0]) level = 1;
                          }
                          return (
                            <div
                              key={di}
                              className={`heatmap-cell${level > 0 ? ` level-${level}` : ""}`}
                              title={`${day.id} · ${formatTokens(tokens)}`}
                            />
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="heatmap-legend" aria-label="用量强度：从少到多">
                  <span>少</span>
                  {[0, 1, 2, 3, 4].map((level) => (
                    <span key={level} className={`heatmap-cell heatmap-legend-cell${level ? ` level-${level}` : ""}`} />
                  ))}
                  <span>多</span>
                </div>
              </>
            ) : halfYearMode === "month" && monthlyUsage.length > 0 ? (
              <HalfYearMonthChart buckets={monthlyUsage} />
            ) : (
              <div className="heatmap-empty">暂无热力图数据</div>
            )}
          </div>
        </div>

        <div className="trend-card">
          <div className="trend-card-header">
            <span className="trend-card-title">最近 7 日用量趋势</span>
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

    </div>
  );
}

interface TrendChartTheme {
  text: string;
  muted: string;
  grid: string;
  tooltipBackground: string;
  tooltipBorder: string;
}

function readTrendChartTheme(container: HTMLElement): TrendChartTheme {
  const styles = getComputedStyle(container);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    text: read("--text-primary", "#f5f5f7"),
    muted: read("--text-tertiary", "#98989d"),
    grid: read("--surface-card-border", "rgba(142, 142, 147, 0.22)"),
    tooltipBackground: read("--surface-section-bg", "rgba(32, 32, 35, 0.94)"),
    tooltipBorder: read("--surface-section-border", "rgba(255, 255, 255, 0.16)"),
  };
}

function tokenAxisLabel(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(Math.round(value));
}

export function buildHalfYearMonthlyChartOption(
  buckets: MonthlyUsageBucket[],
  theme: TrendChartTheme,
): echarts.EChartsCoreOption {
  return {
    animationDuration: 350,
    color: ["#5B8FF9"],
    grid: { top: 8, right: 8, bottom: 20, left: 36, containLabel: false },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: theme.tooltipBackground,
      borderColor: theme.tooltipBorder,
      borderWidth: 1,
      textStyle: { color: theme.text, fontSize: 11 },
      axisPointer: { type: "line", lineStyle: { color: theme.grid, type: "dashed" } },
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: buckets.map((bucket) => bucket.label),
      axisLine: { lineStyle: { color: theme.grid } },
      axisTick: { show: false },
      axisLabel: { color: theme.muted, fontSize: 9, interval: 0 },
    },
    yAxis: {
      type: "value",
      min: 0,
      splitNumber: 2,
      axisLabel: { color: theme.muted, fontSize: 9, formatter: tokenAxisLabel },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: theme.grid, type: "dashed" } },
    },
    series: [{
      name: "总用量",
      type: "line",
      data: buckets.map((bucket) => bucket.tokens),
      smooth: 0.35,
      symbol: "circle",
      symbolSize: 5,
      showSymbol: false,
      lineStyle: { color: "#5B8FF9", width: 2.2 },
      itemStyle: { color: "#5B8FF9" },
      emphasis: { showSymbol: true },
      tooltip: { valueFormatter: (value: unknown) => formatTokens(Number(value)) },
    }],
  };
}

function HalfYearMonthChart({ buckets }: { buckets: MonthlyUsageBucket[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = echarts.init(container, undefined, { renderer: "canvas" });
    const update = () => chart.setOption(buildHalfYearMonthlyChartOption(buckets, readTrendChartTheme(container)), true);
    update();
    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(container);
    const themeObserver = new MutationObserver(update);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
      chart.dispose();
    };
  }, [buckets]);

  return <div ref={containerRef} className="half-year-month-chart" role="img" aria-label="最近半年总用量月度趋势" />;
}

export function buildSevenDayChartOption(
  buckets: DailyTokenBucket[],
  theme: TrendChartTheme,
): echarts.EChartsCoreOption {
  const hasBreakdown = buckets.some((bucket) => bucket.inputTokens != null);
  const makeTokenSeries = (name: string, color: string, data: (number | null)[]) => ({
    name,
    type: "line" as const,
    data,
    smooth: 0.35,
    symbol: "circle",
    symbolSize: 5,
    showSymbol: false,
    connectNulls: false,
    lineStyle: { color, width: 2 },
    itemStyle: { color },
    emphasis: { focus: "series" as const, showSymbol: true },
    tooltip: { valueFormatter: (value: unknown) => formatTokens(Number(value)) },
  });
  const series = hasBreakdown
    ? [
        makeTokenSeries("输入", "#5B8FF9", buckets.map((bucket) => bucket.inputTokens == null
          ? null
          : Math.max(0, bucket.inputTokens - (bucket.cachedInputTokens ?? 0)))),
        makeTokenSeries("输出", "#5AD8A6", buckets.map((bucket) => bucket.outputTokens)),
        makeTokenSeries("缓存读取", "#F6BD16", buckets.map((bucket) => bucket.cachedInputTokens)),
        ...(buckets.some((bucket) => (bucket.reasoningOutputTokens ?? 0) > 0)
          ? [makeTokenSeries("推理输出", "#E8684A", buckets.map((bucket) => bucket.reasoningOutputTokens))]
          : []),
        {
          name: "缓存命中率",
          type: "line" as const,
          yAxisIndex: 1,
          data: buckets.map((bucket) => {
            if (bucket.inputTokens == null || bucket.inputTokens <= 0) return null;
            return Math.min(100, Math.max(0, ((bucket.cachedInputTokens ?? 0) / bucket.inputTokens) * 100));
          }),
          smooth: 0.35,
          symbol: "circle",
          symbolSize: 5,
          showSymbol: false,
          connectNulls: false,
          lineStyle: { color: "#8B95A7", width: 1.8, type: "dashed" as const },
          itemStyle: { color: "#8B95A7" },
          emphasis: { focus: "series" as const, showSymbol: true },
          tooltip: { valueFormatter: (value: unknown) => `${Number(value).toFixed(1)}%` },
        },
      ]
    : [makeTokenSeries("总用量", "#5B8FF9", buckets.map((bucket) => bucket.tokens))];

  return {
    animationDuration: 350,
    color: series.map((item) => item.itemStyle.color),
    grid: { top: 30, right: hasBreakdown ? 34 : 8, bottom: 18, left: 38, containLabel: false },
    legend: {
      top: 0,
      left: 0,
      right: 0,
      type: "scroll",
      itemWidth: 14,
      itemHeight: 6,
      itemGap: 10,
      textStyle: { color: theme.muted, fontSize: 9 },
      pageTextStyle: { color: theme.muted, fontSize: 9 },
      pageIconColor: theme.text,
      pageIconInactiveColor: theme.grid,
    },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: theme.tooltipBackground,
      borderColor: theme.tooltipBorder,
      borderWidth: 1,
      textStyle: { color: theme.text, fontSize: 11 },
      axisPointer: { type: "line", lineStyle: { color: theme.grid, type: "dashed" } },
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: buckets.map((bucket) => bucket.label),
      axisLine: { lineStyle: { color: theme.grid } },
      axisTick: { show: false },
      axisLabel: { color: theme.muted, fontSize: 9, interval: 0 },
    },
    yAxis: [
      {
        type: "value",
        min: 0,
        splitNumber: 2,
        axisLabel: { color: theme.muted, fontSize: 9, formatter: tokenAxisLabel },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: theme.grid, type: "dashed" } },
      },
      {
        type: "value",
        min: 0,
        max: 100,
        interval: 50,
        show: hasBreakdown,
        axisLabel: { color: theme.muted, fontSize: 9, formatter: "{value}%" },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
      },
    ],
    series,
  };
}

function SevenDayLineChart({ buckets }: { buckets: DailyTokenBucket[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = echarts.init(container, undefined, { renderer: "canvas" });
    const update = () => {
      const styles = getComputedStyle(container);
      const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
      chart.setOption(buildSevenDayChartOption(buckets, {
        text: read("--text-primary", "#f5f5f7"),
        muted: read("--text-tertiary", "#98989d"),
        grid: read("--surface-card-border", "rgba(142, 142, 147, 0.22)"),
        tooltipBackground: read("--surface-section-bg", "rgba(32, 32, 35, 0.94)"),
        tooltipBorder: read("--surface-section-border", "rgba(255, 255, 255, 0.16)"),
      }), true);
    };
    update();
    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(container);
    const themeObserver = new MutationObserver(update);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
      chart.dispose();
    };
  }, [buckets]);

  return <div ref={containerRef} className="line-chart-container" role="img" aria-label="最近 7 日 Token 类型与缓存命中率趋势" />;
}

/* ========================================================
   Projects Tab
   ======================================================== */

function ProjectsTab({ projects }: { projects: ProjectUsage[] }) {
  const activeCount = projects.filter((project) => project.lastActiveAt && new Date(project.lastActiveAt).getTime() >= Date.now() - 7 * 24 * 60 * 60 * 1000).length;

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
    <div className="workspace-two-column">
      <section className="workspace-panel">
        <div className="workspace-panel-header"><span>项目用量排行</span><span>全部</span></div>
        <div className="project-list">
        {projects.map((proj, idx) => (
          <div key={proj.name} className="project-item">
            <span className="project-rank">{idx + 1}</span>
            <span className="project-name">{shortCwd(proj.name)}</span>
            <div className="project-bar-wrap">
              <div className="project-bar" style={{ width: `${(proj.tokens / maxTokens) * 100}%` }} />
            </div>
            <span className="project-tokens">{formatTokens(proj.tokens)}</span>
          </div>
        ))}
        </div>
      </section>
      <section className="workspace-panel">
        <div className="workspace-panel-header"><span>项目活动概览</span><span>近 7 天</span></div>
        <div className="project-overview">
          <div className="project-overview-card"><h4>活跃项目</h4><div className="project-overview-value">{activeCount}</div></div>
          <div className="project-overview-card"><h4>全部项目</h4><div className="project-overview-value">{projects.length}</div></div>
        </div>
        <div className="project-activity-list">
          {projects.slice(0, 6).map((project) => (
            <div key={project.name} className="project-activity-item"><span>{shortCwd(project.name)}</span><span>{project.threadCount} 线程 · {formatRelativeTime(project.lastActiveAt)}</span></div>
          ))}
        </div>
      </section>
    </div>
  );
}

function UsageRankList({ items, emptyText }: { items: NamedUsage[]; emptyText: string }) {
  if (!items.length) return <div className="empty-state compact"><div className="empty-state-title">{emptyText}</div></div>;
  const maxCalls = Math.max(...items.map((item) => item.calls), 1);
  return <div className="usage-rank-list">{items.map((item) => (
    <div key={item.name} className="usage-rank-item">
      <div className="usage-rank-row"><span>{item.name}</span><strong>{item.calls} 次</strong></div>
      <div className="project-bar-wrap"><div className="project-bar" style={{ width: `${(item.calls / maxCalls) * 100}%` }} /></div>
      <span className="usage-rank-estimate">{item.estimatedTokens == null ? "--" : `估算 ${formatTokens(item.estimatedTokens)}`}</span>
    </div>
  ))}</div>;
}

function SkillsTab({ skills, tools }: { skills: NamedUsage[]; tools: NamedUsage[] }) {
  if (!skills.length && !tools.length) {
    return <div className="empty-state"><div className="empty-state-icon">&#9889;</div><div className="empty-state-title">暂无可读取的 Skill 或工具事件</div></div>;
  }
  return (
    <div className="workspace-two-column">
      <section className="workspace-panel"><div className="workspace-panel-header"><span>Skill 使用排行</span><span>{skills.length} 项</span></div><UsageRankList items={skills} emptyText="暂无 Skill 事件" /></section>
      <section className="workspace-panel"><div className="workspace-panel-header"><span>工具使用排行</span><span>{tools.length} 项</span></div><UsageRankList items={tools} emptyText="暂无工具事件" /></section>
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
            <span>任务栏常驻用量条</span>
            <input type="checkbox" checked={settings.taskbarWidgetEnabled} onChange={(e) => onUpdate({ taskbarWidgetEnabled: e.target.checked })} />
          </div>
          <div className="settings-field">
            <label>距隐藏图标按钮左侧偏移（像素）</label>
            <input
              type="number"
              min="0"
              max="3000"
              value={settings.taskbarWidgetRightOffset}
              onChange={(e) => onUpdate({ taskbarWidgetRightOffset: Number(e.target.value) || 0 })}
            />
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

export default function App({ mockMode = false }: { mockMode?: boolean }) {
  const {
    settings: liveSettings,
    snapshot: liveSnapshot,
    isInitializing: liveIsInitializing,
    isRefreshing: liveIsRefreshing,
    error: liveError,
    bootstrap,
    refresh,
    updateSettings,
    setSnapshot,
    setSettings,
  } = useUsageStore();
  const [mockSettings, setMockSettings] = useState<AppSettings>(MOCK_SETTINGS);
  const [mockSnapshot, setMockSnapshot] = useState<MultiRuntimeUsageSnapshot>(() => createMockDashboardSnapshot());
  const [mockIsRefreshing, setMockIsRefreshing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("tasks");
  const [uiTheme, setUiTheme] = useState<"light" | "dark">("dark");

  const settings = mockMode ? mockSettings : liveSettings;
  const snapshot = mockMode ? mockSnapshot : liveSnapshot;
  const isInitializing = mockMode ? false : liveIsInitializing;
  const isRefreshing = mockMode ? mockIsRefreshing : liveIsRefreshing;
  const error = mockMode ? null : liveError;

  useEffect(() => {
    if (!mockMode) void bootstrap();
  }, [bootstrap, mockMode]);
  useEffect(() => {
    if (mockMode) return;
    const unlisten = listen("tokenusage://refresh-requested", () => { void refresh(); });
    return () => { unlisten.then((d: () => void) => d()); };
  }, [mockMode, refresh]);
  useEffect(() => {
    if (mockMode) return;
    const unlisten = listen("tokenusage://open-settings", () => setSettingsOpen(true));
    return () => { unlisten.then((d: () => void) => d()); };
  }, [mockMode]);
  useEffect(() => {
    if (mockMode) return;
    const unlisten = listen<MultiRuntimeUsageSnapshot>("tokenusage://snapshot", ({ payload }) => setSnapshot(payload));
    return () => { unlisten.then((d: () => void) => d()); };
  }, [mockMode, setSnapshot]);
  useEffect(() => {
    if (mockMode) return;
    const unlisten = listen<AppSettings>("tokenusage://settings-updated", ({ payload }) => setSettings(payload));
    return () => { unlisten.then((d: () => void) => d()); };
  }, [mockMode, setSettings]);
  useEffect(() => {
    if (!settings) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      setUiTheme(settings.theme === "system" ? (media.matches ? "dark" : "light") : settings.theme);
    };
    applyTheme();
    if (settings.theme !== "system") return;
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [settings]);

  const handleRefresh = useCallback(() => {
    if (mockMode) {
      setMockIsRefreshing(true);
      window.setTimeout(() => {
        setMockSnapshot(createMockDashboardSnapshot());
        setMockIsRefreshing(false);
      }, 350);
      return;
    }
    void refresh();
  }, [mockMode, refresh]);
  const handleUpdateSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      if (mockMode) {
        setMockSettings((current) => ({ ...current, ...patch }));
        return;
      }
      void updateSettings(patch);
    },
    [mockMode, updateSettings],
  );

  const handleToggleTheme = useCallback(() => {
    const nextTheme = uiTheme === "dark" ? "light" : "dark";
    setUiTheme(nextTheme);
    void updateSettings({ theme: nextTheme });
  }, [uiTheme, updateSettings]);

  const handleClose = useCallback(() => {
    if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        void getCurrentWindow().hide();
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
        return local?.usageTrend ? `${local.usageTrend.days.filter((day) => day.tokens > 0).length} 活跃日` : "暂无趋势";
      case "projects":
        return `${local?.projects.length ?? 0} 个项目`;
      case "skills":
        return `${local?.skillUsage.length ?? 0} Skill · ${local?.toolUsage.length ?? 0} 工具`;
    }
  }, [activeTab, runtime]);

  if (error && !runtime) {
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

  if (!runtime || isInitializing) {
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
        isRefreshing={isRefreshing}
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
                  data-tab={tab.id}
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
            {activeTab === "projects" && <ProjectsTab projects={runtime.snapshot.local?.projects ?? []} />}
            {activeTab === "skills" && <SkillsTab skills={runtime.snapshot.local?.skillUsage ?? []} tools={runtime.snapshot.local?.toolUsage ?? []} />}
          </div>
        </section>
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
