import type {
  AgentExecutionInput,
  AgentExecutionResult,
  AgentExecutor,
} from "@factory/core";
import { builtInDefaults } from "@factory/core";
import { parseDsmlToolCalls, detectDsmlMarkup, parseDsmlParameters, decodeDsmlText, normalizeDsmlToolName, buildDsmlToolResultPrompt, summarizeToolResult, extractToolName, extractToolArgs, extractToolResult, extractToolCallId, previewToolArgs, previewToolResult, normalizeToolActivityName, toolToCapability, withAgentTurnTimeouts, isAbortError, type WatchdogHandle } from "./executor-helpers.js";
import type {
  PiExecutorOptions,
  PiExecutorState,
  PiSessionEvent,
  PiSessionLike,
} from "./types.js";

// Streaming updates carry a cumulative snapshot of the whole message, so keeping
// every one is quadratic in output size and blew past V8's max string length in
// JSON.stringify ("Invalid string length"). Their text still accumulates in
// outputChunks; the final payloads arrive as message_end / turn_end / tool_execution_end.
const TRANSIENT_EVENT_TYPES = new Set(["message_update", "tool_execution_update"]);

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
    });

    // Timeouts are harness-enforced. Partial or missing caller limits still get
    // Factory's default watchdogs, so a wedged SDK session can never hang a run.
    const defaultLimits = builtInDefaults.runtime.limits ?? {};
    const limits = {
      modelIdleTimeoutMs: input.limits?.modelIdleTimeoutMs ?? input.limits?.modelTimeoutMs ?? defaultLimits.modelIdleTimeoutMs ?? defaultLimits.modelTimeoutMs,
      turnTimeoutMs: input.limits?.turnTimeoutMs ?? input.limits?.totalRunTimeoutMs ?? defaultLimits.turnTimeoutMs ?? defaultLimits.totalRunTimeoutMs,
      toolTimeoutMs: input.limits?.toolTimeoutMs ?? defaultLimits.toolTimeoutMs,
      runTimeoutMs: input.limits?.runTimeoutMs ?? defaultLimits.runTimeoutMs,
      runDeadlineAt: input.limits?.runDeadlineAt,
      adaptiveGrace: input.limits?.adaptiveGrace ?? defaultLimits.adaptiveGrace,
    };

    // True run-level deadline: if the absolute run budget is already spent
    // before this executor even starts, fail fast rather than starting a turn.
    if (limits.runDeadlineAt && limits.runDeadlineAt <= Date.now()) {
      const message = `Run deadline exceeded (run-timeout)`;
      return {
        executionId: input.executionId,
        status: "failed",
        outputText: "",
        events: [{
          type: "executor.timeout",
          data: {
            reason: message,
            timeoutType: "run-timeout",
            limitMs: 0,
            elapsedMs: 0,
            runElapsedMs: Date.now() - (limits.runDeadlineAt - (limits.runTimeoutMs ?? 0)),
            executionState: "idle",
          },
        }],
        errorMessage: message,
      };
    }

    const state: PiExecutorState = {
      executionId: input.executionId,
      events: (created.diagnostics ?? []).map((diagnostic) => ({
        type: diagnostic.type,
        data: diagnostic.data,
      })),
      outputChunks: [],
      toolStarts: new Map(),
    };

    for (const diagnostic of created.diagnostics ?? []) {
      void this.options.onEvent?.(input.executionId, {
        type: diagnostic.type,
        data: diagnostic.data,
      });
    }

    this.activeSessions.set(input.executionId, created.session);
    let watchdog: WatchdogHandle = {
      markActivity: () => {},
      markProgress: () => {},
      markToolStart: () => {},
      markToolEnd: () => {},
    };
    const unsubscribe = created.session.subscribe((event) => {
      // Activity: any SDK event proves the stream is alive and resets the idle
      // watchdog. Meaningful progress is tracked separately (tool starts,
      // tool results, turn transitions) so a talkative-but-idle model cannot
      // reset every watchdog.
      watchdog.markActivity(event.type);
      this.trackToolEvents(watchdog, event);
      this.captureEvent(state, event);
      this.captureToolActivity(input.executionId, state, event, input.metadata);
      this.auditToolCall(input.executionId, state, event, input.metadata);
      void this.options.onEvent?.(input.executionId, event);
    });

    try {
      const promptResult = await withAgentTurnTimeouts(
        () => created.session.prompt(input.prompt),
        limits,
        (handle) => {
          watchdog = handle;
        },
      );
      if (promptResult.kind === "timeout") {
        state.events.push({
          type: "executor.timeout",
          data: {
            reason: promptResult.message,
            timeoutType: promptResult.timeoutType,
            limitMs: promptResult.limitMs,
            elapsedMs: promptResult.elapsedMs,
            turnElapsedMs: promptResult.turnElapsedMs,
            runElapsedMs: promptResult.runElapsedMs,
            lastActivityAt: promptResult.diagnostics.lastActivityAt,
            lastActivityType: promptResult.diagnostics.lastActivityType,
            lastProgressAt: promptResult.diagnostics.lastProgressAt,
            lastProgressType: promptResult.diagnostics.lastProgressType,
            executionState: promptResult.diagnostics.executionState,
            activeTools: promptResult.diagnostics.activeTools,
            activityCounts: promptResult.diagnostics.activityCounts,
            progressCounts: promptResult.diagnostics.progressCounts,
            graceUsed: promptResult.diagnostics.graceUsed,
          },
        });
        await created.session.abort().catch(() => {});
        return {
          executionId: input.executionId,
          status: "failed",
          outputText: state.outputChunks.join(""),
          events: state.events,
          errorMessage: promptResult.message,
        };
      }
      const bridged = await this.bridgeDsmlToolMarkup(input.executionId, created.session, state, watchdog);
      if (!bridged.ok) {
        return {
          executionId: input.executionId,
          status: "failed",
          outputText: state.outputChunks.join(""),
          events: state.events,
          errorMessage: bridged.errorMessage,
        };
      }
      if (state.terminalErrorMessage) {
        return {
          executionId: input.executionId,
          status: "failed",
          outputText: state.outputChunks.join(""),
          events: state.events,
          errorMessage: state.terminalErrorMessage,
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
    if (!TRANSIENT_EVENT_TYPES.has(event.type)) {
      state.events.push({
        type: event.type,
        // Arrival time at the collector. Paired _start/_end events bracket
        // durations (message_start/end = model time, tool_execution_start/end =
        // tool time) for the benchmark's performance report.
        at: Date.now(),
        data: event.data,
      });
    }

    if (event.text) {
      state.outputChunks.push(event.text);
    }
    const terminalError = extractTerminalErrorMessage(event);
    if (terminalError) {
      state.terminalErrorMessage = terminalError;
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

  private trackToolEvents(watchdog: WatchdogHandle, event: PiSessionEvent): void {
    const data = event.data as Record<string, unknown> | undefined;
    const assistantMessageEvent = data?.assistantMessageEvent as Record<string, unknown> | undefined;
    const callId = (typeof data?.toolCallId === "string" ? data.toolCallId : undefined) as string | undefined;
    if (!assistantMessageEvent) return;
    if (event.type === "tool_execution_start") {
      const name = typeof assistantMessageEvent.name === "string" ? assistantMessageEvent.name : "tool";
      watchdog.markToolStart({ name, callId });
    } else if (event.type === "tool_execution_end") {
      const name = typeof assistantMessageEvent.name === "string" ? assistantMessageEvent.name : "tool";
      watchdog.markToolEnd({ name, callId });
    }
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

  private captureToolActivity(executionId: string, state: PiExecutorState, event: PiSessionEvent, metadata?: Record<string, unknown>): void {
    if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") {
      return;
    }
    const rawToolName = extractToolName(event);
    if (!rawToolName) {
      return;
    }
    const toolName = normalizeToolActivityName(rawToolName);
    const callId = extractToolCallId(event) ?? toolName;
    const now = Date.now();
    if (event.type === "tool_execution_start") {
      state.toolStarts?.set(callId, { toolName, at: now });
      this.emitNormalizedToolEvent(executionId, state, {
        type: "tool.started",
        at: now,
        data: {
          role: stringMeta(metadata, "role"),
          taskId: stringMeta(metadata, "taskId"),
          toolName,
          rawToolName: rawToolName === toolName ? undefined : rawToolName,
          capability: toolToCapability(toolName),
          preview: previewToolArgs(extractToolArgs(event)),
        },
      });
      return;
    }

    const started = state.toolStarts?.get(callId);
    state.toolStarts?.delete(callId);
    this.emitNormalizedToolEvent(executionId, state, {
      type: "tool.completed",
      at: now,
      data: {
        role: stringMeta(metadata, "role"),
        taskId: stringMeta(metadata, "taskId"),
        toolName,
        rawToolName: rawToolName === toolName ? undefined : rawToolName,
        capability: toolToCapability(toolName),
        preview: previewToolResult(extractToolResult(event)),
        elapsedMs: started ? Math.max(0, now - started.at) : undefined,
      },
    });
  }

  private emitNormalizedToolEvent(executionId: string, state: PiExecutorState, event: { type: string; at?: number; data: Record<string, unknown> }): void {
    state.events.push(event);
    void this.options.onEvent?.(executionId, event);
  }

  private async bridgeDsmlToolMarkup(
    executionId: string,
    session: PiSessionLike,
    state: PiExecutorState,
    watchdog: WatchdogHandle,
  ): Promise<{ ok: true } | { ok: false; errorMessage: string }> {
    const callIdOf = (index: number) => `${executionId}-dsml-${index}`;
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
      for (let index = 0; index < calls.length; index += 1) {
        const call = calls[index];
        const callId = callIdOf(index);
        const toolName = normalizeDsmlToolName(call.name);
        watchdog.markToolStart({ name: toolName, callId });
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
        } finally {
          watchdog.markToolEnd({ name: toolName, callId });
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

function extractTerminalErrorMessage(event: PiSessionEvent): string | undefined {
  const message = event.data && typeof event.data.message === "object" && event.data.message !== null
    ? event.data.message as Record<string, unknown>
    : undefined;
  if (message?.stopReason !== "error") {
    return undefined;
  }
  const errorMessage = message.errorMessage;
  return typeof errorMessage === "string" && errorMessage.trim()
    ? errorMessage
    : "Pi SDK reported an assistant message error.";
}

function stringMeta(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}
