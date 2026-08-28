import type { FactoryPiExtensionApiLike } from "./types.js";
import { getFactoryCommandCompletions, handleFactoryCommand } from "./gateway.js";
import { registerSupervisoryPiHooks } from "./supervisor.js";

export function registerFactoryPiExtension(pi: FactoryPiExtensionApiLike): void {
  pi.registerCommand("factory", {
    description: "Run Factory setup and status commands",
    getArgumentCompletions: (prefix) => getFactoryCommandCompletions(prefix),
    handler: async (args, ctx) => {
      await handleFactoryCommand(args, ctx);
    },
  });
  registerSupervisoryPiHooks(pi);

  // Opt-in auto-start: dashboard.enabled in effective config (global < project < built-ins).
  // Non-blocking, pi-scoped singleton; dies with pi process (no orphan daemon).
  // Silent — surfaced via /factory dashboard status and console.
  void autoStartDashboardIfEnabled().catch(() => {});
}

async function autoStartDashboardIfEnabled(): Promise<void> {
  try {
    const cwd = process.cwd();
    const core = (await import("@factory/core")) as unknown as { loadEffectiveConfig: (o: { cwd: string }) => Promise<{ effectiveConfig: { dashboard: { enabled: boolean; port: number; host: string; autoOpen: boolean } } }> };
    const loaded = await core.loadEffectiveConfig({ cwd });
    if (!loaded.effectiveConfig.dashboard?.enabled) return;
    const web = await loadWebAdapter();
    if (!web?.ensureDashboardServer) return;
    const ensure = web.ensureDashboardServer as (o: { cwd: string; port: number; host: string }) => Promise<{ url: string; reused: boolean }>;
    const { url } = await ensure({
      cwd,
      port: loaded.effectiveConfig.dashboard.port,
      host: loaded.effectiveConfig.dashboard.host,
    });
    console.log(`Factory dashboard at ${url} (auto-started via dashboard.enabled)`);
    if (loaded.effectiveConfig.dashboard.autoOpen) {
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
        const args = process.platform === "win32" ? ["/c", "start", url] : [url];
        await execFileAsync(cmd, args, { windowsHide: true }).catch(() => undefined);
      } catch {}
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/EADDRINUSE/.test(msg)) console.log("Factory dashboard auto-start skipped: port in use");
  }
}

async function loadWebAdapter(): Promise<{ ensureDashboardServer?: (o: unknown) => Promise<unknown> } | undefined> {
  try {
    // Dynamic so installations that do not include the web adapter can still use Pi.
    const m = await import("@factory/adapter-web");
    return m as { ensureDashboardServer?: (o: unknown) => Promise<unknown> };
  } catch {}
  return undefined;
}
