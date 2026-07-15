#!/usr/bin/env node

import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { spawn } from "node:child_process";

const SEVEN_DAYS_MINUTES = 7 * 24 * 60;
const REQUEST_TIMEOUT_MS = 15_000;

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function findCodexExecutable(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.TOKENUSAGE_CODEX_BIN,
  ];
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat"] : ["codex"];

  for (const directory of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    for (const name of names) candidates.push(join(directory, name));
  }

  if (process.platform === "win32") {
    candidates.push(join(process.env.APPDATA ?? "", "npm", "codex.cmd"));
    candidates.push(join(process.env.LOCALAPPDATA ?? "", "Programs", "Codex", "codex.exe"));
  } else {
    candidates.push("/usr/local/bin/codex", "/usr/bin/codex");
  }

  return unique(candidates).find((candidate) => existsSync(candidate)) ?? "codex";
}

function appServerCommand(executable) {
  const extension = extname(executable).toLowerCase();
  if (process.platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    const commandShell = process.env.ComSpec ?? "cmd.exe";
    const command = `""${executable.replaceAll('"', "")}" app-server"`;
    return { command: commandShell, args: ["/D", "/S", "/C", command] };
  }
  return { command: executable, args: ["app-server"] };
}

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function readAppServer(executable, refreshToken) {
  const { command, args } = appServerCommand(executable);
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

  return new Promise((resolve, reject) => {
    let stdoutBuffer = "";
    let stderr = "";
    let initialized = false;
    let settled = false;
    const results = new Map();
    const responseErrors = new Map();
    let accountUpdated = null;

    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else resolve(result);
    };

    const timeout = setTimeout(() => {
      finish(null, new Error(`Codex app-server did not return account and rate-limit data within ${REQUEST_TIMEOUT_MS / 1000} seconds.${stderr ? ` ${stderr.trim()}` : ""}`));
    }, REQUEST_TIMEOUT_MS);

    child.once("error", (error) => finish(null, error));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2_000);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      while (true) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex < 0) break;
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.method === "account/updated") {
          accountUpdated = message.params ?? null;
          continue;
        }

        if (message.id === 1) {
          if (message.error) {
            finish(null, new Error(`Codex app-server initialization failed: ${message.error.message ?? "unknown error"}`));
            return;
          }
          if (!initialized) {
            initialized = true;
            send(child, { method: "initialized" });
            send(child, { id: 2, method: "account/read", params: { refreshToken } });
            send(child, { id: 3, method: "account/rateLimits/read" });
          }
          continue;
        }

        if (message.id !== 2 && message.id !== 3) continue;
        if (message.error) responseErrors.set(message.id, message.error.message ?? "unknown error");
        else results.set(message.id, message.result ?? null);

        if (results.has(2) || responseErrors.has(2)) {
          if (results.has(3) || responseErrors.has(3)) {
            finish({
              account: results.get(2) ?? null,
              rateLimits: results.get(3) ?? null,
              accountUpdated,
              responseErrors: Object.fromEntries(responseErrors),
            });
          }
        }
      }
    });

    send(child, {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "tokenusage-account-inspector", title: "TokenUsage Account Inspector", version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });
  });
}

function extractSevenDayWindow(rateLimitResult) {
  const namedBuckets = rateLimitResult?.rateLimitsByLimitId;
  const buckets = [];
  if (namedBuckets && typeof namedBuckets === "object") {
    for (const [id, bucket] of Object.entries(namedBuckets)) buckets.push({ id, bucket });
  }
  if (rateLimitResult?.rateLimits) buckets.push({ id: rateLimitResult.rateLimits.limitId ?? "default", bucket: rateLimitResult.rateLimits });

  for (const { id, bucket } of buckets) {
    for (const slot of ["primary", "secondary"]) {
      const window = bucket?.[slot];
      if (window?.windowDurationMins === SEVEN_DAYS_MINUTES) return { bucketId: id, slot, window };
    }
  }
  return null;
}

function toResetIso(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? new Date(seconds * 1_000).toISOString() : null;
}

function toResetLocal(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(seconds * 1_000));
}

function maskEmail(email) {
  if (typeof email !== "string" || email.length === 0) return null;
  const atIndex = email.indexOf("@");
  if (atIndex <= 0 || atIndex === email.length - 1) return "configured";

  const localPart = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  const visibleLength = Math.min(2, localPart.length);
  return `${localPart.slice(0, visibleLength)}***@${domain}`;
}

function extractRateLimitPlanTypes(rateLimitResult) {
  const plans = {};
  const defaultPlan = rateLimitResult?.rateLimits?.planType;
  if (typeof defaultPlan === "string") plans.default = defaultPlan;

  const buckets = rateLimitResult?.rateLimitsByLimitId;
  if (buckets && typeof buckets === "object") {
    for (const [id, bucket] of Object.entries(buckets)) {
      if (typeof bucket?.planType === "string") plans[id] = bucket.planType;
    }
  }
  return plans;
}

function buildReport(data, executable, refreshedAccountToken) {
  const account = data.account?.account ?? null;
  const sevenDay = extractSevenDayWindow(data.rateLimits);
  const rateLimitPlanTypes = extractRateLimitPlanTypes(data.rateLimits);
  const accountPlanType = account?.planType ?? null;
  const notificationPlanType = data.accountUpdated?.planType ?? null;
  const rateLimitPlanType = rateLimitPlanTypes.codex ?? rateLimitPlanTypes.default ?? Object.values(rateLimitPlanTypes)[0] ?? null;
  const planType = rateLimitPlanType ?? accountPlanType ?? notificationPlanType ?? null;
  const usedPercent = Number(sevenDay?.window?.usedPercent);
  const hasUsedPercent = Number.isFinite(usedPercent);

  return {
    inspectedAt: new Date().toISOString(),
    source: "Codex app-server (account/read + account/rateLimits/read)",
    codexExecutable: basename(executable),
    refreshedAccountToken,
    account: {
      type: account?.type ?? null,
      planType,
      emailHint: maskEmail(account?.email),
      planTypeSources: {
        accountRead: accountPlanType,
        accountUpdated: notificationPlanType,
        rateLimits: rateLimitPlanTypes,
        effectiveSource: rateLimitPlanType ? "rateLimits.codex" : accountPlanType ? "account/read" : notificationPlanType ? "account/updated" : null,
      },
    },
    sevenDayQuota: sevenDay && hasUsedPercent ? {
      available: true,
      bucketId: sevenDay.bucketId,
      slot: sevenDay.slot,
      usedPercent: Math.max(0, Math.min(100, usedPercent)),
      remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
      windowDurationMins: sevenDay.window.windowDurationMins,
      resetsAt: toResetIso(sevenDay.window.resetsAt),
      resetsAtLocal: toResetLocal(sevenDay.window.resetsAt),
    } : {
      available: false,
      reason: "The current app-server response does not contain a 10080-minute (7-day) rate-limit window.",
    },
    subscription: {
      subscribedAt: null,
      currentPeriodEndsAt: null,
      available: false,
      reason: "The official app-server account/read and account/rateLimits/read responses expose planType but do not expose subscription start or billing-period end timestamps.",
    },
    responseErrors: data.responseErrors,
  };
}

function printHuman(report) {
  const quota = report.sevenDayQuota;
  console.log("TokenUsage Codex account inspection");
  console.log(`Source: ${report.source}`);
  console.log(`Account: ${report.account.emailHint ?? "unavailable"}`);
  console.log(`Plan: ${report.account.planType ?? "unavailable"}`);
  const sources = report.account.planTypeSources;
  const rateLimitSources = Object.entries(sources.rateLimits).map(([id, plan]) => `${id}=${plan}`).join(", ");
  console.log(`Plan sources: account/read=${sources.accountRead ?? "unavailable"}; account/updated=${sources.accountUpdated ?? "not received"}; rateLimits=${rateLimitSources || "unavailable"}`);
  if (quota.available) {
    console.log(`7d remaining: ${quota.remainingPercent.toFixed(1)}%`);
    console.log(`7d reset: ${quota.resetsAtLocal ?? quota.resetsAt ?? "unavailable"}`);
  } else {
    console.log(`7d quota: unavailable (${quota.reason})`);
  }
  console.log("Subscription started at: unavailable (not exposed by the official app-server)");
  console.log("Current subscription period ends at: unavailable (not exposed by the official app-server)");
}

async function main() {
  const executable = findCodexExecutable(optionValue("--codex-bin"));
  const refreshToken = !process.argv.includes("--no-refresh-token");
  const data = await readAppServer(executable, refreshToken);
  const report = buildReport(data, executable, refreshToken);
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
}

main().catch((error) => {
  console.error(`Account inspection failed: ${error.message}`);
  process.exitCode = 1;
});
