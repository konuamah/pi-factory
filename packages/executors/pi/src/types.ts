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
}

export interface PiSessionFactoryInput {
  cwd: string;
  prompt: string;
  model?: AgentExecutionInput["model"];
  tools?: string[];
  metadata?: Record<string, unknown>;
}

export interface PiSessionFactoryResult {
  session: PiSessionLike;
}

export interface PiSessionFactory {
  create(input: PiSessionFactoryInput): Promise<PiSessionFactoryResult>;
}

export interface PiExecutorOptions {
  sessionFactory: PiSessionFactory;
  onEvent?: (executionId: string, event: PiSessionEvent) => Promise<void> | void;
}

export interface PiExecutorState {
  executionId: string;
  events: AgentExecutionResult["events"];
  outputChunks: string[];
}
