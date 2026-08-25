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
    const unsubscribe = created.session.subscribe((event) => {
      this.captureEvent(state, event);
      this.auditToolCall(input.executionId, state, event, input.metadata);
      void this.options.onEvent?.(input.executionId, event);
    });

    try {
      await created.session.prompt(input.prompt);
      const outputText = state.outputChunks.join("");
      const unexecutedToolMarkup = detectUnexecutedToolMarkup(outputText);
      if (unexecutedToolMarkup) {
        const errorMessage = "Pi executor received tool-call markup as assistant text; no tool was executed. Use native Pi tool calls instead of DSML markup.";
        state.events.push({
          type: "executor.unexecuted_tool_markup",
          data: {
            reason: errorMessage,
            marker: unexecutedToolMarkup,
          },
        });
        return {
          executionId: input.executionId,
          status: "failed",
          outputText,
          events: state.events,
          errorMessage,
        };
      }
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
}

function detectUnexecutedToolMarkup(outputText: string): string | undefined {
  const markers = [
    "<｜｜DSML｜｜tool_calls>",
    "<｜｜DSML｜｜invoke",
    "</｜｜DSML｜｜tool_calls>",
  ];
  return markers.find((marker) => outputText.includes(marker));
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && /abort|cancel/i.test(error.message);
}
