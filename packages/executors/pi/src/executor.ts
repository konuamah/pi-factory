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
    const created = await this.options.sessionFactory.create({
      cwd: input.cwd,
      prompt: input.prompt,
      model: input.model,
      tools: input.tools,
      metadata: input.metadata,
    });

    const state: PiExecutorState = {
      executionId: input.executionId,
      events: [],
      outputChunks: [],
    };

    this.activeSessions.set(input.executionId, created.session);
    const unsubscribe = created.session.subscribe((event) => {
      this.captureEvent(state, event);
      void this.options.onEvent?.(input.executionId, event);
    });

    try {
      await created.session.prompt(input.prompt);
      return {
        executionId: input.executionId,
        status: "completed",
        outputText: state.outputChunks.join(""),
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
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && /abort|cancel/i.test(error.message);
}
