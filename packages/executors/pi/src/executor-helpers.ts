// DSML/event helpers for PiAgentExecutor — extracted from executor.ts.

import type { PiSessionEvent } from "./types.js";
import type { AgentExecutionInput } from "@factory/core";

export interface DsmlToolCall {
  name: string;
  args: Record<string, unknown>;
  raw: string;
}

export function parseDsmlToolCalls(text: string): DsmlToolCall[] {
  const calls: DsmlToolCall[] = [];
  const invokePattern = /<｜{1,2}DSML｜{1,2}invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜{1,2}DSML｜{1,2}invoke>/g;
  for (const match of text.matchAll(invokePattern)) {
    const name = match[1]?.trim();
    const body = match[2] ?? "";
    if (!name) {
      continue;
    }
    calls.push({
      name,
      args: parseDsmlParameters(body),
      raw: match[0],
    });
  }
  return calls;
}

export function detectDsmlMarkup(text: string): string | undefined {
  const match = text.match(/<｜{1,2}DSML｜{1,2}(?:tool_calls|invoke|parameter)/);
  return match?.[0];
}

export function parseDsmlParameters(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const parameterPattern = /<｜{1,2}DSML｜{1,2}parameter\s+name="([^"]+)"(?:\s+[^>]*)?>([\s\S]*?)<\/｜{1,2}DSML｜{1,2}parameter>/g;
  for (const match of body.matchAll(parameterPattern)) {
    const name = match[1]?.trim();
    if (!name) {
      continue;
    }
    args[name] = decodeDsmlText(match[2] ?? "");
  }
  return args;
}

export function decodeDsmlText(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

export function normalizeDsmlToolName(name: string): string {
  switch (name) {
    case "shell.execute":
    case "shell_execute":
    case "bash.execute":
    case "bash_execute":
      return "bash";
    default:
      return name;
  }
}

export function buildDsmlToolResultPrompt(results: Array<{ tool: string; args: unknown; result?: unknown; error?: string }>): string {
  return [
    "Factory executed the tool call(s) you emitted as DSML text.",
    "Use the results below to continue. Use native Pi tools for any further tool calls; do not print DSML/XML/tool-call markup as text.",
    JSON.stringify(results, null, 2),
  ].join("\n\n");
}

export function summarizeToolResult(result: unknown): Record<string, unknown> {
  const text = typeof result === "string" ? result : JSON.stringify(result) ?? String(result);
  return {
    preview: text.slice(0, 1000),
    truncated: text.length > 1000,
  };
}

export function formatToolActivityLine(event: { type: string; data?: Record<string, unknown> }): string | undefined {
  if (event.type !== "tool.started" && event.type !== "tool.completed") {
    return undefined;
  }
  const toolName = normalizeToolActivityName(typeof event.data?.toolName === "string" ? event.data.toolName : "tool");
  const preview = typeof event.data?.preview === "string" && event.data.preview ? `: ${event.data.preview}` : "";
  const elapsed = typeof event.data?.elapsedMs === "number" ? ` (${event.data.elapsedMs}ms)` : "";
  const status = event.type === "tool.completed" ? ` done${elapsed}` : "";
  return `${toolName}${preview}${status}`;
}

export function extractToolName(event: PiSessionEvent): string | undefined {
  const data = event.data as Record<string, unknown> | undefined;
  if (typeof data?.toolName === "string") {
    return data.toolName;
  }
  const assistantMessageEvent = data?.assistantMessageEvent as Record<string, unknown> | undefined;
  if (!assistantMessageEvent) {
    return undefined;
  }
  if (assistantMessageEvent.type === "toolCall") {
    const call = (assistantMessageEvent.partial ?? assistantMessageEvent) as Record<string, unknown>;
    return typeof call.name === "string" ? call.name : undefined;
  }
  if (assistantMessageEvent.type === "toolUse" || assistantMessageEvent.type === "tool_call") {
    return typeof assistantMessageEvent.name === "string" ? assistantMessageEvent.name : undefined;
  }
  return undefined;
}

export function extractToolArgs(event: PiSessionEvent): unknown {
  const data = event.data as Record<string, unknown> | undefined;
  if (data && ("args" in data || "arguments" in data || "input" in data || "toolArgs" in data)) {
    return data.args ?? data.arguments ?? data.input ?? data.toolArgs;
  }
  const assistantMessageEvent = data?.assistantMessageEvent as Record<string, unknown> | undefined;
  if (!assistantMessageEvent) {
    return undefined;
  }
  if (assistantMessageEvent.type === "toolCall") {
    const call = (assistantMessageEvent.partial ?? assistantMessageEvent) as Record<string, unknown>;
    return call.arguments ?? call.input;
  }
  return assistantMessageEvent.arguments ?? assistantMessageEvent.input;
}

export function extractToolResult(event: PiSessionEvent): unknown {
  const data = event.data as Record<string, unknown> | undefined;
  if (data && ("result" in data || "output" in data || "error" in data)) {
    return data.result ?? data.output ?? data.error;
  }
  const assistantMessageEvent = data?.assistantMessageEvent as Record<string, unknown> | undefined;
  return assistantMessageEvent?.result ?? assistantMessageEvent?.output ?? assistantMessageEvent?.error;
}

export function extractToolCallId(event: PiSessionEvent): string | undefined {
  const data = event.data as Record<string, unknown> | undefined;
  return typeof data?.toolCallId === "string" ? data.toolCallId : undefined;
}

export function previewToolArgs(args: unknown): string | undefined {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : undefined;
  const value =
    stringField(record, "path")
    ?? stringField(record, "file")
    ?? stringField(record, "targetPath")
    ?? stringField(record, "command")
    ?? stringField(record, "pattern")
    ?? stringField(record, "query")
    ?? (typeof args === "string" ? args : undefined);
  return value ? truncatePreview(value.replace(/\s+/g, " ").trim()) : undefined;
}

export function previewToolResult(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : value === undefined ? undefined : JSON.stringify(value);
  return text ? truncatePreview(text.replace(/\s+/g, " ").trim()) : undefined;
}

export function normalizeToolActivityName(toolName: string): string {
  const lower = toolName.toLowerCase();
  if (lower === "bash" || lower.includes("shell") || lower.includes("terminal")) {
    return "bash";
  }
  if (lower === "grep" || lower.includes("grep") || lower.includes("search")) {
    return "grep";
  }
  if (lower === "find" || lower.includes("find")) {
    return "find";
  }
  if (lower === "ls" || lower.includes("list") || lower.includes("directory")) {
    return "ls";
  }
  if (lower === "write" || lower.includes("write") || lower.includes("create")) {
    return "write";
  }
  if (lower === "edit" || lower.includes("edit") || lower.includes("patch")) {
    return "edit";
  }
  if (lower === "read" || lower.includes("read") || lower.includes("open")) {
    return "read";
  }
  return toolName;
}

export function toolToCapability(toolName: string): string | undefined {
  switch (normalizeToolActivityName(toolName)) {
    case "read":
    case "grep":
    case "find":
    case "ls":
      return "repo.read";
    case "write":
    case "edit":
      return "repo.write";
    case "bash":
      return "shell.execute";
    default:
      return undefined;
  }
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function truncatePreview(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
}

export interface WatchdogDiagnostics {
  startedAt: number;
  lastActivityAt?: number;
  lastActivityType?: string;
  lastProgressAt?: number;
  lastProgressType?: string;
  executionState: "model" | "tool" | "idle" | "completed";
  activeTools: Array<{ name: string; callId?: string; startedAt: number }>;
  activityCounts: Record<string, number>;
  progressCounts: Record<string, number>;
  graceUsed: boolean;
}

export interface TurnTimeoutResult {
  kind: "ok";
  value: unknown;
  diagnostics: WatchdogDiagnostics;
}

export interface TurnTimeoutFailure {
  kind: "timeout";
  message: string;
  timeoutType:
    | "model-idle-timeout"
    | "tool-timeout"
    | "turn-timeout"
    | "run-timeout";
  limitMs: number;
  elapsedMs: number;
  turnElapsedMs: number;
  runElapsedMs: number;
  diagnostics: WatchdogDiagnostics;
}

export type TurnTimeoutOutcome = TurnTimeoutResult | TurnTimeoutFailure;

export interface WatchdogHandle {
  markActivity(type?: string): void;
  markProgress(type?: string): void;
  markToolStart(tool: { name: string; callId?: string }): void;
  markToolEnd(tool: { name: string; callId?: string }): void;
}

/**
 * Activity != Progress != Completion.
 *
 * - `markActivity` (model text / any SDK event) resets the model idle timer but
 *   does not mean the task is advancing.
 * - `markProgress` (tool start / tool result / turn transition) resets progress
 *   accounting and is the meaningful signal.
 * - `markToolStart` pauses the model idle timer and arms the tool timeout.
 * - `markToolEnd` resumes the model idle timer once no tools are active.
 */
export function withAgentTurnTimeouts<T>(
  fn: () => Promise<T>,
  limits: AgentExecutionInput["limits"],
  registerHandle: (handle: WatchdogHandle) => void,
): Promise<TurnTimeoutOutcome> {
  const modelIdleTimeoutMs = limits?.modelIdleTimeoutMs ?? limits?.modelTimeoutMs;
  const toolTimeoutMs = limits?.toolTimeoutMs;
  const turnTimeoutMs = limits?.turnTimeoutMs ?? limits?.totalRunTimeoutMs;
  const runDeadlineAt = limits?.runDeadlineAt;
  const graceDurationMs = limits?.adaptiveGrace?.durationMs;
  const maxExtensions = limits?.adaptiveGrace?.maxExtensionsPerTurn ?? 1;
  const graceEnabled = Boolean(limits?.adaptiveGrace?.enabled && graceDurationMs && graceDurationMs > 0);

  const hasModelIdle = Boolean(modelIdleTimeoutMs && modelIdleTimeoutMs > 0);
  const hasToolTimeout = Boolean(toolTimeoutMs && toolTimeoutMs > 0);
  const hasTurnTimeout = Boolean(turnTimeoutMs && turnTimeoutMs > 0);
  const hasRunDeadline = Boolean(runDeadlineAt && runDeadlineAt > 0);
  if (!hasModelIdle && !hasToolTimeout && !hasTurnTimeout && !hasRunDeadline) {
    registerHandle({
      markActivity: () => {},
      markProgress: () => {},
      markToolStart: () => {},
      markToolEnd: () => {},
    });
    return Promise.resolve(fn()).then((value) => ({ kind: "ok", value, diagnostics: emptyDiagnostics() }));
  }

  const startedAt = Date.now();
  const diagnostics: WatchdogDiagnostics = emptyDiagnostics(startedAt);
  let graceUsed = false;
  let graceExtensions = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let turnTimer: ReturnType<typeof setTimeout> | undefined;
    let runTimer: ReturnType<typeof setTimeout> | undefined;
    const toolTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (turnTimer) clearTimeout(turnTimer);
      if (runTimer) clearTimeout(runTimer);
      for (const timer of toolTimers.values()) clearTimeout(timer);
      toolTimers.clear();
    };

    const settleOk = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimers();
      diagnostics.executionState = "completed";
      resolve({ kind: "ok", value, diagnostics });
    };

    const settleError = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };

    const settleTimeout = (
      timeoutType: TurnTimeoutFailure["timeoutType"],
      limitMs: number,
      message: string,
    ) => {
      if (settled) return;
      settled = true;
      clearTimers();
      // Preserve the real execution state at the moment the watchdog fired
      // ("tool" for tool timeouts, "model" for idle while the model is
      // thinking). Only fall back to "idle" if nothing else is happening.
      if (diagnostics.executionState !== "tool" && diagnostics.executionState !== "model") {
        diagnostics.executionState = "idle";
      }
      const now = Date.now();
      resolve({
        kind: "timeout",
        message,
        timeoutType,
        limitMs,
        elapsedMs: now - startedAt,
        turnElapsedMs: now - startedAt,
        runElapsedMs: runDeadlineAt ? Math.max(0, now - (runDeadlineAt - (limits?.runTimeoutMs ?? 0))) : now - startedAt,
        diagnostics,
      });
    };

    const armIdleTimer = (now: number) => {
      if (!hasModelIdle || !modelIdleTimeoutMs || settled || diagnostics.executionState === "tool") {
        return;
      }
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (diagnostics.executionState === "tool") return;
        // Deterministic bounded grace: at most one extension per turn. The
        // grace window is granted only when the model actually goes quiet past
        // the idle limit, never up-front on arming, so activity cannot
        // "look busy" and repeatedly earn extensions.
        if (graceEnabled && !graceUsed && graceExtensions < maxExtensions && graceDurationMs) {
          graceUsed = true;
          graceExtensions += 1;
          diagnostics.graceUsed = true;
          const now = Date.now();
          const window = graceDurationMs;
          idleTimer = setTimeout(() => {
            if (diagnostics.executionState === "tool") return;
            settleTimeout(
              "model-idle-timeout",
              modelIdleTimeoutMs,
              `No model activity for ${Math.round(modelIdleTimeoutMs / 1000)}s (model-idle-timeout)`,
            );
          }, window);
          return;
        }
        settleTimeout(
          "model-idle-timeout",
          modelIdleTimeoutMs,
          `No model activity for ${Math.round(modelIdleTimeoutMs / 1000)}s (model-idle-timeout)`,
        );
      }, modelIdleTimeoutMs);
    };

    const handle: WatchdogHandle = {
      markActivity(type = "sdk-event") {
        if (settled) return;
        const now = Date.now();
        diagnostics.lastActivityAt = now;
        diagnostics.lastActivityType = type;
        diagnostics.activityCounts[type] = (diagnostics.activityCounts[type] ?? 0) + 1;
        armIdleTimer(now);
      },
      markProgress(type = "progress") {
        if (settled) return;
        const now = Date.now();
        diagnostics.lastProgressAt = now;
        diagnostics.lastProgressType = type;
        diagnostics.progressCounts[type] = (diagnostics.progressCounts[type] ?? 0) + 1;
      },
      markToolStart(tool) {
        if (settled) return;
        const now = Date.now();
        diagnostics.executionState = "tool";
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = undefined;
        const key = tool.callId ?? tool.name;
        diagnostics.activeTools.push({ name: tool.name, callId: tool.callId, startedAt: now });
        this.markProgress("tool-start");
        if (hasToolTimeout && toolTimeoutMs) {
          if (toolTimers.has(key)) clearTimeout(toolTimers.get(key));
          toolTimers.set(key, setTimeout(() => {
            settleTimeout(
              "tool-timeout",
              toolTimeoutMs,
              `Tool '${tool.name}' exceeded ${Math.round(toolTimeoutMs / 1000)}s (tool-timeout)`,
            );
          }, toolTimeoutMs));
        }
      },
      markToolEnd(tool) {
        if (settled) return;
        const key = tool.callId ?? tool.name;
        const timer = toolTimers.get(key);
        if (timer) {
          clearTimeout(timer);
          toolTimers.delete(key);
        }
        diagnostics.activeTools = diagnostics.activeTools.filter((t) => (t.callId ?? t.name) !== key);
        this.markProgress("tool-result");
        if (diagnostics.activeTools.length === 0) {
          diagnostics.executionState = "model";
          armIdleTimer(Date.now());
        }
      },
    };

    registerHandle(handle);
    armIdleTimer(startedAt);

    if (hasTurnTimeout && turnTimeoutMs) {
      turnTimer = setTimeout(() => {
        settleTimeout(
          "turn-timeout",
          turnTimeoutMs,
          `Agent turn exceeded ${Math.round(turnTimeoutMs / 1000)}s (turn-timeout)`,
        );
      }, turnTimeoutMs);
    }

    if (hasRunDeadline && runDeadlineAt) {
      const remaining = Math.max(0, runDeadlineAt - Date.now());
      runTimer = setTimeout(() => {
        settleTimeout(
          "run-timeout",
          remaining,
          `Run deadline exceeded (run-timeout)`,
        );
      }, remaining);
    }

    void fn().then(settleOk, settleError);
  });
}

function emptyDiagnostics(startedAt = Date.now()): WatchdogDiagnostics {
  return {
    startedAt,
    executionState: "model",
    activeTools: [],
    activityCounts: {},
    progressCounts: {},
    graceUsed: false,
  };
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && /abort|cancel/i.test(error.message);
}
