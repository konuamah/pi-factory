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

export function extractToolName(event: PiSessionEvent): string | undefined {
  const data = event.data as Record<string, unknown> | undefined;
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

export function toolToCapability(toolName: string): string | undefined {
  switch (toolName) {
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

export async function withAgentTurnTimeouts<T>(
  fn: () => Promise<T>,
  limits: AgentExecutionInput["limits"],
  registerProgressMarker: (markProgress: () => void) => void,
): Promise<{ kind: "ok"; value: T } | { kind: "timeout"; message: string; timeoutType: string; limitMs: number; elapsedMs: number }> {
  const totalRunTimeoutMs = limits?.totalRunTimeoutMs;
  const modelTimeoutMs = limits?.modelTimeoutMs;
  const hasTotalTimeout = Boolean(totalRunTimeoutMs && totalRunTimeoutMs > 0);
  const hasProgressTimeout = Boolean(modelTimeoutMs && modelTimeoutMs > 0);
  if (!hasTotalTimeout && !hasProgressTimeout) {
    registerProgressMarker(() => {});
    return { kind: "ok", value: await fn() };
  }

  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    let progressTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = () => {
      if (totalTimer) clearTimeout(totalTimer);
      if (progressTimer) clearTimeout(progressTimer);
    };

    const settleOk = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ kind: "ok", value });
    };

    const settleError = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };

    const settleTimeout = (timeoutType: string, limitMs: number, message: string) => {
      if (!settled) {
        settled = true;
        clearTimers();
        resolve({
          kind: "timeout",
          message,
          timeoutType,
          limitMs,
          elapsedMs: Date.now() - startedAt,
        });
      }
    };

    const armProgressTimer = () => {
      if (!hasProgressTimeout || !modelTimeoutMs || settled) {
        return;
      }
      if (progressTimer) clearTimeout(progressTimer);
      progressTimer = setTimeout(() => {
        settleTimeout(
          "model-timeout",
          modelTimeoutMs,
          `Agent execution made no progress for ${Math.round(modelTimeoutMs / 1000)}s (model-timeout)`,
        );
      }, modelTimeoutMs);
    };

    registerProgressMarker(armProgressTimer);
    armProgressTimer();

    if (hasTotalTimeout && totalRunTimeoutMs) {
      totalTimer = setTimeout(() => {
        settleTimeout(
          "total-run-timeout",
          totalRunTimeoutMs,
          `Agent execution timed out after ${Math.round(totalRunTimeoutMs / 1000)}s (total-run-timeout)`,
        );
      }, totalRunTimeoutMs);
    }

    void fn().then(settleOk, settleError);
  });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && /abort|cancel/i.test(error.message);
}

