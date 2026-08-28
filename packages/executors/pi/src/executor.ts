import type {
  AgentExecutionInput,
  AgentExecutionResult,
  AgentExecutor,
} from "@factory/core";
import type {
  PiExecutorOptions,
  PiExecutorState,
  PiSessionEvent,
  PiSessionLike,
} from "./types.js";

export class PiAgentExecutor implements AgentExecutor {
  private readonly activeSessions = new Map<string, PiSessionLike>();

  constructor(private readonly options: PiExecutorOptions) {}

  async execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    const gatedTools = this.approvalGateTools(input, this.gateTools(input.tools ?? []));
    const created = await this.options.sessionFactory.create({
      cwd: input.cwd,
      prompt: input.prompt,
      model: input.model,
      tools: gatedTools,
      metadata: input.metadata,
      limits: input.limits,
    });

    const state: PiExecutorState = {
      executionId: input.executionId,
      events: (created.diagnostics ?? []).map((diagnostic) => ({
        type: diagnostic.type,
        data: diagnostic.data,
      })),
      outputChunks: [],
    };

    for (const diagnostic of created.diagnostics ?? []) {
      void this.options.onEvent?.(input.executionId, {
        type: diagnostic.type,
        data: diagnostic.data,
      });
    }

    const maxTurns = input.limits?.maxTurns;
    let turnCount = 0;
    let abortedByLimit: { type: "max-turns"; limit: number; observedTurns: number } | undefined;

    this.activeSessions.set(input.executionId, created.session);
    const unsubscribe = created.session.subscribe((event) => {
      if (maxTurns && event.type === "turn_start") {
        turnCount += 1;
        if (turnCount > maxTurns) {
          abortedByLimit = { type: "max-turns", limit: maxTurns, observedTurns: turnCount };
          void created.session.abort().catch(() => {});
        }
      }
      this.captureEvent(state, event);
      this.auditToolCall(input.executionId, state, event, input.metadata);
      void this.options.onEvent?.(input.executionId, event);
    });

    try {
      const promptResult = await withTimeout(
        () => created.session.prompt(input.prompt),
        input.limits?.totalRunTimeoutMs,
        "total-run-timeout",
      );
      if (abortedByLimit) {
        await created.session.agent?.waitForIdle?.().catch(() => {});
        state.events.push({ type: "executor.aborted", data: abortedByLimit });
        return {
          executionId: input.executionId,
          status: "aborted",
          abortReason: abortedByLimit,
          outputText: state.outputChunks.join(""),
          events: state.events,
          errorMessage: `Aborted by Factory: max turns (${maxTurns}) reached.`,
        };
      }
      if (promptResult.kind === "timeout") {
        await created.session.abort().catch(() => {});
        await created.session.agent?.waitForIdle?.().catch(() => {});
        const abortReason = { type: "total-run-timeout" as const, limitMs: input.limits?.totalRunTimeoutMs ?? 0, elapsedMs: input.limits?.totalRunTimeoutMs ?? 0 };
        state.events.push({ type: "executor.aborted", data: abortReason });
        return {
          executionId: input.executionId,
          status: "aborted",
          abortReason,
          outputText: state.outputChunks.join(""),
          events: state.events,
          errorMessage: promptResult.message,
        };
      }
      const bridged = await this.bridgeDsmlToolMarkup(input.executionId, created.session, state);
      if (!bridged.ok) {
        return {
          executionId: input.executionId,
          status: "failed",
          outputText: state.outputChunks.join(""),
          events: state.events,
          errorMessage: bridged.errorMessage,
        };
      }
      const outputText = state.outputChunks.join("");
      return {
        executionId: input.executionId,
        status: "completed",
        outputText,
        events: state.events,
      };
    } catch (error) {
      return {
        executionId: input.executionId,
        status: isAbortError(error) ? "cancelled" : "failed",
        outputText: state.outputChunks.join(""),
        events: state.events,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      unsubscribe();
      await created.session.dispose?.();
      this.activeSessions.delete(input.executionId);
    }
  }

  async cancel(executionId: string): Promise<void> {
    await this.activeSessions.get(executionId)?.abort();
  }

  private captureEvent(state: PiExecutorState, event: PiSessionEvent): void {
    state.events.push({
      type: event.type,
      data: event.data,
    });

    if (event.text) {
      state.outputChunks.push(event.text);
    }
  }

  private gateTools(tools: string[]): string[] {
    const gate = this.options.capabilityGate;
    if (!gate) {
      return tools;
    }
    if (gate.toolAllowlist?.length) {
      const allowed = new Set(gate.toolAllowlist);
      return tools.filter((tool) => allowed.has(tool));
    }
    return tools;
  }

  private approvalGateTools(input: AgentExecutionInput, tools: string[]): string[] {
    const gate = this.options.capabilityGate;
    const needsApproval = new Set<string>(
      gate?.needsApproval ?? (Array.isArray(input.metadata?.needsApprovalCapabilities) ? input.metadata.needsApprovalCapabilities as string[] : []),
    );
    if (needsApproval.size === 0) {
      return tools;
    }
    const approve = gate?.onApprovalRequired;
    return tools.filter((tool) => {
      const capability = toolToCapability(tool);
      if (!capability || !needsApproval.has(capability)) {
        return true;
      }
      if (!approve) {
        return true;
      }
      const ok = approve({
        executionId: input.executionId,
        capability,
        toolName: tool,
      });
      return Boolean(ok);
    });
  }

  private auditToolCall(executionId: string, state: PiExecutorState, event: PiSessionEvent, metadata?: Record<string, unknown>): void {
    const toolName = extractToolName(event);
    if (!toolName) {
      return;
    }
    const requires = toolToCapability(toolName);
    if (!requires) {
      return;
    }

    // Per-execution capability info can come from metadata (grantedCapabilities/deniedCapabilities).
    const denied = new Set<string>(
      this.options.capabilityGate?.denied ?? (Array.isArray(metadata?.deniedCapabilities) ? metadata.deniedCapabilities as string[] : []),
    );
    const needsApproval = new Set<string>(
      this.options.capabilityGate?.needsApproval ?? [],
    );

    if (denied.has(requires)) {
      state.events.push({
        type: "policy.violation",
        data: {
          toolName,
          capability: requires,
          reason: `Tool '${toolName}' requires '${requires}' which is denied for this node.`,
        },
      });
      return;
    }

    if (needsApproval.has(requires)) {
      const ok = this.options.capabilityGate?.onApprovalRequired?.({
        executionId,
        capability: requires,
        toolName,
        args: extractToolArgs(event),
      });
      state.events.push({
        type: ok ? "policy.approved" : "policy.rejected",
        data: {
          toolName,
          capability: requires,
          approved: ok,
        },
      });
    }
  }

  private async bridgeDsmlToolMarkup(
    executionId: string,
    session: PiSessionLike,
    state: PiExecutorState,
  ): Promise<{ ok: true } | { ok: false; errorMessage: string }> {
    let processedLength = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const outputText = state.outputChunks.join("");
      const nextText = outputText.slice(processedLength);
      const calls = parseDsmlToolCalls(nextText);
      processedLength = outputText.length;
      if (calls.length === 0) {
        const marker = detectDsmlMarkup(nextText);
        if (marker) {
          const errorMessage = "Pi executor received malformed DSML tool-call markup that could not be executed.";
          state.events.push({
            type: "executor.malformed_dsml_tool_markup",
            data: { reason: errorMessage, marker },
          });
          return { ok: false, errorMessage };
        }
        return { ok: true };
      }
      if (!session.executeTool) {
        const errorMessage = "Pi executor received tool-call markup as assistant text; no executable tool bridge is available.";
        state.events.push({
          type: "executor.unexecuted_tool_markup",
          data: { reason: errorMessage, marker: calls[0]?.raw.slice(0, 80) },
        });
        return { ok: false, errorMessage };
      }

      const results: Array<{ tool: string; args: unknown; result?: unknown; error?: string }> = [];
      for (const call of calls) {
        const toolName = normalizeDsmlToolName(call.name);
        state.events.push({
          type: "executor.dsml_tool_started",
          data: {
            executionId,
            toolName,
            originalToolName: call.name,
            args: call.args as Record<string, unknown>,
          },
        });
        try {
          const result = await session.executeTool(toolName, call.args);
          results.push({ tool: toolName, args: call.args, result });
          state.events.push({
            type: "executor.dsml_tool_completed",
            data: {
              executionId,
              toolName,
              originalToolName: call.name,
              result: summarizeToolResult(result),
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({ tool: toolName, args: call.args, error: message });
          state.events.push({
            type: "executor.dsml_tool_failed",
            data: {
              executionId,
              toolName,
              originalToolName: call.name,
              error: message,
            },
          });
        }
      }

      await session.prompt(buildDsmlToolResultPrompt(results));
    }

    const errorMessage = "Pi executor stopped after too many DSML tool-call bridge rounds.";
    state.events.push({
      type: "executor.dsml_tool_bridge_limit",
      data: { reason: errorMessage },
    });
    return { ok: false, errorMessage };
  }
}

interface DsmlToolCall {
  name: string;
  args: Record<string, unknown>;
  raw: string;
}

function parseDsmlToolCalls(text: string): DsmlToolCall[] {
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

function detectDsmlMarkup(text: string): string | undefined {
  const match = text.match(/<｜{1,2}DSML｜{1,2}(?:tool_calls|invoke|parameter)/);
  return match?.[0];
}

function parseDsmlParameters(body: string): Record<string, unknown> {
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

function decodeDsmlText(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function normalizeDsmlToolName(name: string): string {
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

function buildDsmlToolResultPrompt(results: Array<{ tool: string; args: unknown; result?: unknown; error?: string }>): string {
  return [
    "Factory executed the tool call(s) you emitted as DSML text.",
    "Use the results below to continue. Use native Pi tools for any further tool calls; do not print DSML/XML/tool-call markup as text.",
    JSON.stringify(results, null, 2),
  ].join("\n\n");
}

function summarizeToolResult(result: unknown): Record<string, unknown> {
  const text = typeof result === "string" ? result : JSON.stringify(result) ?? String(result);
  return {
    preview: text.slice(0, 1000),
    truncated: text.length > 1000,
  };
}

function extractToolName(event: PiSessionEvent): string | undefined {
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

function extractToolArgs(event: PiSessionEvent): unknown {
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

function toolToCapability(toolName: string): string | undefined {
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

async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number | undefined,
  timeoutType: string,
): Promise<{ kind: "ok"; value: T } | { kind: "timeout"; message: string }> {
  if (!timeoutMs || timeoutMs <= 0) {
    return { kind: "ok", value: await fn() };
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ kind: "timeout", message: `Agent execution timed out after ${Math.round(timeoutMs / 1000)}s (${timeoutType})` });
      }
    }, timeoutMs);
    void fn().then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ kind: "ok", value });
        }
      },
      (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      },
    );
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && /abort|cancel/i.test(error.message);
}
