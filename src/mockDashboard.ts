import type {
  AppSettings,
  DailyTokenBucket,
  MultiRuntimeUsageSnapshot,
  TokenBreakdown,
} from "./types";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function isoAt(now: Date, offsetMs: number): string {
  return new Date(now.getTime() + offsetMs).toISOString();
}

function tokenBreakdown(inputTokens: number, cachedInputTokens: number, outputTokens: number): TokenBreakdown {
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + cachedInputTokens + outputTokens,
  };
}

function pricedUsage(inputTokens: number, cachedInputTokens: number, outputTokens: number, estimatedCostUsd: number) {
  return {
    tokens: tokenBreakdown(inputTokens, cachedInputTokens, outputTokens),
    estimatedCostUsd,
  };
}

function recentBuckets(now: Date): DailyTokenBucket[] {
  const values = [
    [8_400_000, 3_200_000, 1_900_000, 2_400_000, 900_000],
    [10_900_000, 4_100_000, 2_600_000, 3_100_000, 1_100_000],
    [13_500_000, 5_000_000, 3_800_000, 3_500_000, 1_200_000],
    [9_800_000, 3_900_000, 2_100_000, 2_800_000, 1_000_000],
    [15_200_000, 5_700_000, 4_200_000, 4_000_000, 1_300_000],
    [12_100_000, 4_500_000, 3_100_000, 3_500_000, 1_000_000],
    [18_800_000, 7_000_000, 5_200_000, 4_900_000, 1_700_000],
  ];
  return values.map(([tokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens], index) => {
    const date = new Date(now.getTime() - (values.length - 1 - index) * DAY);
    return {
      id: date.toISOString().slice(0, 10),
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      tokens,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
    };
  });
}

function heatmapDays(now: Date): DailyTokenBucket[] {
  const pattern = [2, 8, 0, 11, 4, 15, 9, 6, 12, 3, 0, 14, 10, 7, 18, 5, 13, 9, 16, 4, 11, 20, 8, 15, 6, 18, 12, 19];
  const dayCount = 182;
  return Array.from({ length: dayCount }, (_, index) => {
    const millions = pattern[index % pattern.length];
    const date = new Date(now.getTime() - (dayCount - 1 - index) * DAY);
    return {
      id: date.toISOString().slice(0, 10),
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      tokens: millions * 1_000_000,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
    };
  });
}

export const MOCK_SETTINGS: AppSettings = {
  schemaVersion: 1,
  language: "zh-CN",
  theme: "dark",
  selectedRuntime: "codex",
  visibleRuntimes: ["codex"],
  showUsedQuota: false,
  quickPanelDensity: "detailed",
  keepRunningWhenMainWindowClosed: true,
  keepMainWindowOnTop: false,
  taskbarWidgetEnabled: true,
  taskbarWidgetRightOffset: 1050,
  automaticUpdateChecksEnabled: true,
  receivePrereleases: false,
  codexExecutablePath: null,
  codexDataDirectory: null,
  claudeDataDirectory: null,
};

/**
 * Deterministic-shaped, time-relative data for the browser-only dashboard preview.
 * It deliberately does not contain local paths, account data, or Tauri IPC calls.
 */
export function createMockDashboardSnapshot(now = new Date()): MultiRuntimeUsageSnapshot {
  const dailyBuckets = recentBuckets(now);
  const trendDays = heatmapDays(now);
  const today = pricedUsage(2_850_000, 58_600_000, 245_000, 23.38);
  const sevenDay = pricedUsage(4_000_000, 84_500_000, 245_000, 36.28);
  const month = pricedUsage(7_200_000, 161_300_000, 610_000, 71.54);
  const lifetime = pricedUsage(42_600_000, 765_000_000, 3_210_000, 351.84);

  return {
    schemaVersion: 1,
    refreshedAt: now.toISOString(),
    runtimes: [
      {
        scope: "codex",
        displayName: "Codex",
        status: "available",
        snapshot: {
          refreshedAt: now.toISOString(),
          account: { type: "chatgpt", planType: "Plus", emailPresent: true },
          limitId: "codex.primary",
          limitName: "Codex",
          primary: {
            usedPercent: 42,
            remainingPercent: 58,
            windowDurationMins: 300,
            resetsAt: isoAt(now, 257 * MINUTE),
          },
          secondary: {
            usedPercent: 35,
            remainingPercent: 65,
            windowDurationMins: 10_080,
            resetsAt: isoAt(now, 147 * 60 * MINUTE + 18 * MINUTE),
          },
          cloudLifetimeTokens: 1_105_200_000,
          local: {
            lifetimeTokens: lifetime.tokens.totalTokens,
            todayTokens: today.tokens.totalTokens,
            sevenDayTokens: sevenDay.tokens.totalTokens,
            threadCount: 8,
            lastUpdatedAt: now.toISOString(),
            dailyBuckets,
            recentThreads: [
              {
                id: "thread-codex-9209",
                title: "参考 ref 里的项目，分析项目的技术方案并制定 Windows 移植计划",
                tokens: 98_200_000,
                updatedAt: isoAt(now, -2 * MINUTE),
                model: "gpt-5.6-terra",
                cwd: "TokenUsage",
                archived: false,
              },
              {
                id: "thread-codex-e1d9",
                title: "精调标题栏、底栏与卡片间距，保持视觉基线一致",
                tokens: 67_700_000,
                updatedAt: isoAt(now, -14 * MINUTE),
                model: "gpt-5.6-terra",
                cwd: "TokenUsage",
                archived: false,
              },
              {
                id: "thread-codex-0aa9",
                title: "实现本月 API 等效价值与羊毛进度分段刻度",
                tokens: 45_800_000,
                updatedAt: isoAt(now, -37 * MINUTE),
                model: "gpt-5.6-terra",
                cwd: "TokenUsage",
                archived: false,
              },
              {
                id: "thread-codex-8cd0",
                title: "补齐本地 session 解析与真实 Token 用量统计",
                tokens: 28_600_000,
                updatedAt: isoAt(now, -26 * 60 * MINUTE),
                model: "gpt-5.6-terra",
                cwd: "TokenUsage",
                archived: false,
              },
              {
                id: "thread-codex-5fc2",
                title: "梳理 UI 对比结果并落地 Windows 版设计方案",
                tokens: 16_500_000,
                updatedAt: isoAt(now, -3 * 60 * MINUTE),
                model: "gpt-5.6-terra",
                cwd: "TokenUsage",
                archived: false,
              },
              {
                id: "thread-codex-e66c",
                title: "退出前保存本地运行状态",
                tokens: 0,
                updatedAt: isoAt(now, -20 * 60 * MINUTE),
                model: "gpt-5.6-terra",
                cwd: "TokenUsage",
                archived: true,
              },
            ],
            detailedUsage: {
              today,
              sevenDay,
              month,
              lifetime,
              parsedFileCount: 42,
              tokenEventCount: 1286,
            },
            usageTrend: {
              days: trendDays,
              sevenDayTokens: sevenDay.tokens.totalTokens,
              previousSevenDayTokens: 63_400_000,
              changePercent: 39.9,
              isNewActivity: false,
            },
            projects: [
              { name: "TokenUsage", tokens: 184_500_000, threadCount: 6, lastActiveAt: isoAt(now, -2 * MINUTE) },
              { name: "codexU", tokens: 101_600_000, threadCount: 4, lastActiveAt: isoAt(now, -26 * MINUTE) },
              { name: "migration-lab", tokens: 63_800_000, threadCount: 3, lastActiveAt: isoAt(now, -3 * DAY) },
            ],
            skillUsage: [
              { name: "browser", calls: 18, estimatedTokens: 82_000 },
              { name: "openai-docs", calls: 9, estimatedTokens: 26_000 },
              { name: "visualize", calls: 4, estimatedTokens: 11_000 },
            ],
            toolUsage: [
              { name: "shell_command", calls: 46, estimatedTokens: 105_000 },
              { name: "apply_patch", calls: 21, estimatedTokens: 47_000 },
              { name: "view_image", calls: 13, estimatedTokens: 18_000 },
            ],
          },
          diagnostics: [],
        },
      },
    ],
  };
}
