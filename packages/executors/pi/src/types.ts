import type {
  AgentExecutionInput,
  AgentExecutionResult,
} from "@factory/core";

export interface PiSessionEvent {
  type: string;
  text?: string;
  data?: Record<string, unknown>;
}

export interface PiSessionLike {
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: PiSessionEvent) => void): () => void;
  abort(): Promise<void>;
  agent?: {
    waitForIdle?: () => Promise<void>;
  };
  executeTool?(name: string, args: unknown): Promise<unknown>;
  dispose?(): Promise<void> | void;
}

export interface PiSessionFactoryInput {
  cwd: string;
  prompt: string;
  model?: AgentExecutionInput["model"];
  tools?: string[];
  metadata?: Record<string, unknown>;
}

export interface PiSessionFactoryDiagnostic {
  type: "model.selection_warning";
  data: {
    requestedProvider?: string;
    requestedModel: string;
    reason: string;
    fallback: "sdk-default";
  };
}

export interface PiSessionFactoryResult {
  session: PiSessionLike;
  diagnostics?: PiSessionFactoryDiagnostic[];
}

export interface PiSessionFactory {
  create(input: PiSessionFactoryInput): Promise<PiSessionFactoryResult>;
}

export interface PiCapabilityGate {
  granted: string[];
  denied: string[];
  needsApproval: string[];
  toolAllowlist?: string[];
  onApprovalRequired?: (input: {
    executionId: string;
    capability: string;
    toolName: string;
    args?: unknown;
  }) => Promise<boolean> | boolean;
}

export interface PiExecutorOptions {
  sessionFactory: PiSessionFactory;
  onEvent?: (executionId: string, event: PiSessionEvent) => Promise<void> | void;
  capabilityGate?: PiCapabilityGate;
}

export interface PiExecutorState {
  executionId: string;
  events: AgentExecutionResult["events"];
  outputChunks: string[];
}
