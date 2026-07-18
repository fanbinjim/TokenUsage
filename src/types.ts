export type RuntimeScope = "codex" | "claudeCode";

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface DiagnosticItem {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
}

export interface RateWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: string | null;
  remainingPercent: number;
}

export interface AccountInfo {
  type: string;
  planType: string | null;
  emailPresent: boolean;
}

export interface TokenBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface PricedTokenUsage {
  tokens: TokenBreakdown;
  estimatedCostUsd: number | null;
}

export interface DetailedUsage {
  today: PricedTokenUsage;
  sevenDay: PricedTokenUsage;
  month: PricedTokenUsage;
  lifetime: PricedTokenUsage;
  parsedFileCount: number;
  tokenEventCount: number;
}

export interface DailyTokenBucket {
  id: string;
  label: string;
  tokens: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}

export interface UsageTrend {
  days: DailyTokenBucket[];
  sevenDayTokens: number;
  previousSevenDayTokens: number;
  changePercent: number | null;
  isNewActivity: boolean;
}

export interface ProjectUsage {
  name: string;
  tokens: number;
  threadCount: number;
  lastActiveAt: string | null;
}

export interface NamedUsage {
  name: string;
  calls: number;
  estimatedTokens: number | null;
}

export interface LocalThread {
  id: string;
  title: string;
  tokens: number;
  updatedAt: string | null;
  model: string | null;
  cwd: string;
  archived: boolean;
}

export interface LocalUsage {
  lifetimeTokens: number;
  todayTokens: number;
  sevenDayTokens: number;
  threadCount: number;
  lastUpdatedAt: string | null;
  dailyBuckets: DailyTokenBucket[];
  recentThreads: LocalThread[];
  detailedUsage: DetailedUsage | null;
  usageTrend: UsageTrend | null;
  projects: ProjectUsage[];
  skillUsage: NamedUsage[];
  toolUsage: NamedUsage[];
}

export interface UsageSnapshot {
  refreshedAt: string;
  account: AccountInfo | null;
  limitId: string | null;
  limitName: string | null;
  primary: RateWindow | null;
  secondary: RateWindow | null;
  cloudLifetimeTokens: number | null;
  local: LocalUsage | null;
  diagnostics: DiagnosticItem[];
}

export interface RuntimeUsageSnapshot {
  scope: RuntimeScope;
  displayName: string;
  status: "available" | "localOnly" | "snapshotNeeded" | "stale" | "unavailable";
  snapshot: UsageSnapshot;
}

export interface MultiRuntimeUsageSnapshot {
  schemaVersion: number;
  refreshedAt: string;
  runtimes: RuntimeUsageSnapshot[];
}

export interface AppSettings {
  schemaVersion: number;
  language: "auto" | "zh-CN" | "en-US";
  theme: "system" | "light" | "dark";
  selectedRuntime: RuntimeScope;
  visibleRuntimes: RuntimeScope[];
  showUsedQuota: boolean;
  subscriptionStartedOn: string | null;
  quickPanelDensity: "compact" | "detailed";
  keepRunningWhenMainWindowClosed: boolean;
  keepMainWindowOnTop: boolean;
  autostartEnabled: boolean;
  taskbarWidgetEnabled: boolean;
  taskbarWidgetRightOffset: number;
  automaticUpdateChecksEnabled: boolean;
  receivePrereleases: boolean;
  codexExecutablePath: string | null;
  codexDataDirectory: string | null;
  claudeDataDirectory: string | null;
}

export interface BootstrapPayload {
  settings: AppSettings;
  snapshot: MultiRuntimeUsageSnapshot;
}
