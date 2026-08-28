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
    totalRunTimeoutMs?: number;
    modelTimeoutMs?: number;
    toolTimeoutMs?: number;
    maxTurns?: number;
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
