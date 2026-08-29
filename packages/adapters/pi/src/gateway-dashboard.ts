// Dashboard command handlers — extracted from gateway-prototype.ts.

import { renderLines } from "./gateway-render.js";
import { loadEffectiveConfig, detectPiModelConfiguration } from "@factory/core";
import * as piExecutors from "@factory/executor-pi";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentExecutor } from "@factory/core";

const execFileAsync = promisify(execFile);
import type { FactoryPiCommandContext } from "./types.js";

export async function handleDashboard(rest: string[], ctx: FactoryPiCommandContext): Promise<void> {
  const action = (rest[0] ?? "status").toLowerCase();
  // parse --port/--host flags from rest
  let port: number | undefined;
  let host: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--port" && rest[i + 1]) port = Number.parseInt(rest[i + 1]!, 10);
    else if (rest[i]?.startsWith("--port=")) port = Number.parseInt(rest[i]!.slice("--port=".length), 10);
    else if (rest[i] === "--host" && rest[i + 1]) host = rest[i + 1];
    else if (rest[i]?.startsWith("--host=")) host = rest[i]!.slice("--host=".length);
  }
  const loaded = await loadEffectiveConfig({ cwd: ctx.cwd }).catch(() => undefined);
  const effectivePort = port ?? loaded?.effectiveConfig.dashboard.port;
  const effectiveHost = host ?? loaded?.effectiveConfig.dashboard.host ?? "127.0.0.1";
  const web = await loadDashboardWeb().catch(() => undefined);
  if (!web) {
    renderLines(ctx, ["Factory dashboard", "Dashboard adapter not available. Run npm run build."]);
    ctx.ui.notify("Dashboard not available", "warning");
    return;
  }
  const { getDashboardUrl, getDashboardServer, ensureDashboardServer, stopDashboardServer, resolveDashboardDist } = web as unknown as {
    getDashboardUrl: () => string | undefined;
    getDashboardServer: () => { port: number } | undefined;
    ensureDashboardServer: (o: { cwd: string; port?: number; host?: string; staticDir?: string }) => Promise<{ url: string; reused: boolean }>;
    stopDashboardServer: () => Promise<boolean>;
    resolveDashboardDist: (cwd: string) => string | undefined;
  };
  const dist = resolveDashboardDist(ctx.cwd);
  if (action === "start" || action === "up" || action === "" || action === "status") {
    if (action === "start" || action === "up") {
      try {
        const { url, reused } = await ensureDashboardServer({ cwd: ctx.cwd, port: effectivePort, host: effectiveHost, staticDir: dist });
        renderLines(ctx, [
          "Factory dashboard",
          `${reused ? "reused" : "started"}: ${url}`,
          `host: ${effectiveHost}`,
          `port: ${String(effectivePort ?? getDashboardServer()?.port ?? "?")}`,
          `static: ${dist ?? "(not built — run npm run dashboard:build)"}`,
          `config enabled: ${loaded?.effectiveConfig.dashboard.enabled ? "yes" : "no"} (set dashboard.enabled: true to auto-start on next pi)`,
        ]);
        ctx.ui.notify(`Dashboard ${reused ? "running" : "started"} at ${url}`, "info");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/EADDRINUSE/.test(msg)) {
          const existing = getDashboardUrl();
          renderLines(ctx, ["Factory dashboard", `port in use: ${effectivePort}`, existing ? `existing: ${existing}` : "try /factory dashboard stop then start"]);
          ctx.ui.notify("Dashboard port in use", "warning");
        } else throw e;
      }
      return;
    }
    const url = getDashboardUrl();
    const server = getDashboardServer();
    renderLines(ctx, [
      "Factory dashboard",
      url ? `running: ${url}` : "not running (use /factory dashboard start)",
      `configured: ${effectiveHost}:${String(effectivePort ?? 4199)}`,
      `auto-start: ${loaded?.effectiveConfig.dashboard.enabled ? "enabled" : "disabled"} (dashboard.enabled)` + (loaded?.effectiveConfig.dashboard.autoOpen ? " + autoOpen" : ""),
      `static: ${dist ?? "not built — run npm run dashboard:build"}`,
      "",
      "Commands: /factory dashboard start [--port N] [--host H] | stop | status | open",
    ]);
    ctx.ui.notify(url ? `Dashboard at ${url}` : "Dashboard not running", url ? "info" : "warning");
    return;
  }
  if (action === "stop" || action === "down") {
    const stopped = await stopDashboardServer();
    renderLines(ctx, ["Factory dashboard", stopped ? "stopped" : "not running"]);
    ctx.ui.notify(stopped ? "Dashboard stopped" : "Dashboard not running", stopped ? "info" : "warning");
    return;
  }
  if (action === "open") {
    let url = getDashboardUrl();
    if (!url) {
      const started = await ensureDashboardServer({ cwd: ctx.cwd, port: effectivePort, host: effectiveHost, staticDir: dist });
      url = started.url;
    }
    renderLines(ctx, ["Factory dashboard", `open: ${url}`]);
    // Try to open browser; do not fail if unavailable (headless)
    try {
      const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const args = process.platform === "win32" ? ["/c", "start", url] : [url];
      await execFileAsync(openCmd, args, { windowsHide: true }).catch(() => undefined);
    } catch {}
    ctx.ui.notify(`Dashboard: ${url}`, "info");
    return;
  }
  renderLines(ctx, ["Factory dashboard", "Usage: /factory dashboard [status|start|stop|open] [--port N] [--host H]"]);
  ctx.ui.notify("Unknown dashboard action", "warning");
}

export async function loadDashboardWeb(): Promise<unknown> {
  try {
    return await import("@factory/adapter-web");
  } catch {}
  return undefined;
}


export function parseGoalRequest(raw: string): {
  goal: string;
  executorMode?: "fake" | "sdk" | "off";
  workflowId?: string;
  taskType?: string;
} {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const remaining: string[] = [];
  let executorMode: "fake" | "sdk" | "off" | undefined;
  let workflowId: string | undefined;
  let taskType: string | undefined;

  for (const part of parts) {
    if (part === "--executor=fake") {
      executorMode = "fake";
      continue;
    }
    if (part === "--executor=sdk") {
      executorMode = "sdk";
      continue;
    }
    if (part === "--executor=off") {
      executorMode = "off";
      continue;
    }
    if (part.startsWith("--workflow=")) {
      workflowId = part.slice("--workflow=".length);
      continue;
    }
    if (part.startsWith("--task-type=")) {
      taskType = part.slice("--task-type=".length);
      continue;
    }
    remaining.push(part);
  }

  if (!executorMode) {
    const envMode = process.env.FACTORY_PI_EXECUTOR_MODE;
    if (envMode === "fake" || envMode === "sdk" || envMode === "off") {
      executorMode = envMode;
    }
  }

  return {
    goal: remaining.join(" "),
    executorMode,
    workflowId,
    taskType,
  };
}

export async function createRequiredConstitutionExecutor(
  onEvent?: (executionId: string, event: { type: string; text?: string; data?: Record<string, unknown> }) => void,
): Promise<AgentExecutor> {
  const sessionFactory = piExecutors.createPiSdkSessionFactory({
    packageName: process.env.FACTORY_PI_SDK_PACKAGE,
  });
  return new piExecutors.PiAgentExecutor({ sessionFactory, onEvent });
}

export async function createOptionalExecutorBundle(
  mode: "fake" | "sdk" | "off" | undefined,
  onEvent?: (executionId: string, event: { type: string; text?: string; data?: Record<string, unknown> }) => void,
  ctx?: FactoryPiCommandContext,
): Promise<
  | {
      discoveryExecutor: AgentExecutor;
      plannerExecutor: AgentExecutor;
      builderExecutor: AgentExecutor;
      repairExecutor: AgentExecutor;
      reviewerExecutor: AgentExecutor;
      verificationPlannerExecutor: AgentExecutor;
    }
  | undefined
> {
  if (!mode || mode === "off") {
    return undefined;
  }

  const sessionFactory =
    mode === "sdk"
      ? piExecutors.createPiSdkSessionFactory({
          packageName: process.env.FACTORY_PI_SDK_PACKAGE,
          toolGate: {
            onApprovalRequired: async ({ capability, toolName }) => {
              if (!ctx?.ui.confirm) {
                return false;
              }
              return ctx.ui.confirm(
                "Factory capability approval",
                `Allow tool '${toolName}' to use capability '${capability}' for this node?`,
              );
            },
          },
        })
      : piExecutors.createFakePiSessionFactory();

  return {
    discoveryExecutor: new piExecutors.PiAgentExecutor({ sessionFactory, onEvent }),
    plannerExecutor: new piExecutors.PiAgentExecutor({ sessionFactory, onEvent }),
    builderExecutor: new piExecutors.PiAgentExecutor({ sessionFactory, onEvent }),
    repairExecutor: new piExecutors.PiAgentExecutor({ sessionFactory, onEvent }),
    reviewerExecutor: new piExecutors.PiAgentExecutor({ sessionFactory, onEvent }),
    verificationPlannerExecutor: new piExecutors.PiAgentExecutor({ sessionFactory, onEvent }),
  };
}

export async function resolveExecutorMode(
  requested: "fake" | "sdk" | "off" | undefined,
  cwd: string,
): Promise<"fake" | "sdk" | "off" | undefined> {
  if (requested) {
    return requested;
  }

  const pi = await detectPiModelConfiguration(cwd).catch(() => undefined);
  if (pi?.hasAuth) {
    return "sdk";
  }

  return undefined;
}


