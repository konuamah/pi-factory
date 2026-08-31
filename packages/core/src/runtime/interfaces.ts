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

export interface AgentExecutionResult {
  executionId: string;
  status: "completed" | "failed" | "cancelled";
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
  requestApproval(gate: unknown): Promise<unknown>;
  notify(message: unknown): Promise<void>;
}
