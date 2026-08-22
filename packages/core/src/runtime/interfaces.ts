export interface AgentExecutor {
  execute(input: unknown): Promise<unknown>;
  cancel(executionId: string): Promise<void>;
}

export interface FactoryHarnessAdapter {
  showProgress(event: unknown): Promise<void>;
  requestApproval(gate: unknown): Promise<unknown>;
  notify(message: unknown): Promise<void>;
}
