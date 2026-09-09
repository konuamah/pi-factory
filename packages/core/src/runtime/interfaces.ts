export interface AgentExecutionInput {
  executionId: string;
  cwd: string;
  prompt: string;
  model?: {
    provider?: string;
    model: string;
  };
  tools?: string[];
  metadata?: Record<string, unknown>;
  limits?: {
    turnTimeoutMs?: number;
    modelIdleTimeoutMs?: number;
    toolTimeoutMs?: number;
    runTimeoutMs?: number;
    adaptiveGrace?: {
      enabled?: boolean;
      durationMs?: number;
      maxExtensionsPerTurn?: number;
    };
    maxTurns?: number;
    /**
     * Absolute wall-clock deadline (ms epoch) for the whole run, established by
     * the controller when the run starts. Shared across all agent turns so a
     * new prompt never resets the run budget.
     */
    runDeadlineAt?: number;
    /** @deprecated Alias for `modelIdleTimeoutMs`. */
    modelTimeoutMs?: number;
    /** @deprecated Alias for `turnTimeoutMs`. */
    totalRunTimeoutMs?: number;
  };
}

export type AbortReason =
  | { type: "total-run-timeout"; limitMs: number; elapsedMs: number }
  | { type: "tool-timeout"; limitMs: number; toolName?: string }
  | { type: "max-turns"; limit: number; observedTurns: number; };

export type AbortDecision =
  | { action: "retry"; reason: string }
  | { action: "resume"; reason: string }
  | { action: "change-strategy"; reason: string; instructions: string }
  | { action: "stop"; reason: string };

export interface AgentExecutionResult {
  executionId: string;
  status: "completed" | "failed" | "cancelled" | "aborted";
  abortReason?: AbortReason;
  outputText: string;
  events: Array<{
    type: string;
    // Arrival time at the executor collector, when recorded. Used by the
    // benchmark performance report to bracket model/tool durations.
    at?: number;
    data?: Record<string, unknown>;
  }>;
  errorMessage?: string;
}

export interface AgentExecutor {
  execute(input: AgentExecutionInput): Promise<AgentExecutionResult>;
  cancel(executionId: string): Promise<void>;
}

export interface FactoryHarnessAdapter {
  showProgress(event: unknown): Promise<void>;
  requestAcceptance(gate: unknown): Promise<unknown>;
  notify(message: unknown): Promise<void>;
}
