import type {
  AgentExecutionInput,
  AgentExecutionResult,
  AgentExecutor,
} from "@factory/core";
import { parseDsmlToolCalls, detectDsmlMarkup, parseDsmlParameters, decodeDsmlText, normalizeDsmlToolName, buildDsmlToolResultPrompt, summarizeToolResult, extractToolName, extractToolArgs, toolToCapability, withAgentTurnTimeouts, isAbortError } from "./executor-helpers.js";
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

    this.activeSessions.set(input.executionId, created.session);
    let markProgress = () => {};
    const unsubscribe = created.session.subscribe((event) => {
      markProgress();
      this.captureEvent(state, event);
      this.auditToolCall(input.executionId, state, event, input.metadata);
      void this.options.onEvent?.(input.executionId, event);
    });

    try {
      const promptResult = await withAgentTurnTimeouts(
        () => created.session.prompt(input.prompt),
        input.limits,
        (mark) => {
          markProgress = mark;
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
