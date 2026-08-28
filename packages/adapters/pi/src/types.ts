export interface FactoryPiUi {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setWidget(
    id: string,
    widget: string[] | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  setWidget(
    id: string,
    widget: ((tui: { requestRender(): void }, theme: unknown) => {
      render(width: number): string[];
      handleInput?(data: string): void;
      invalidate(): void;
      dispose?(): void;
    }) | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  confirm?(title: string, message: string): Promise<boolean>;
  select?(
    title: string,
    options: string[],
  ): Promise<string | undefined>;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
  custom?<T>(
    factory: (
      tui: { requestRender(): void },
      theme: unknown,
      keybindings: unknown,
      done: (result: T) => void,
    ) => {
      render(width: number): string[];
      handleInput?(data: string): void;
      invalidate(): void;
    },
    options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> },
  ): Promise<T>;
}

export interface FactoryPiCommandContext {
  cwd: string;
  ui: FactoryPiUi;
}

export interface FactoryPiAutocompleteItem {
  value: string;
  label?: string;
  description?: string;
}

export interface FactoryPiExtensionApiLike {
  on(
    event: "input",
    handler: (event: FactoryPiInputEvent, ctx: FactoryPiEventContext) => FactoryPiInputEventResult | void | Promise<FactoryPiInputEventResult | void>,
  ): void;
  on(
    event: "before_agent_start",
    handler: (event: FactoryPiBeforeAgentStartEvent, ctx: FactoryPiEventContext) => FactoryPiBeforeAgentStartEventResult | void | Promise<FactoryPiBeforeAgentStartEventResult | void>,
  ): void;
  on(
    event: "tool_call",
    handler: (event: FactoryPiToolEvent, ctx: FactoryPiEventContext) => void | Promise<void>,
  ): void;
  on(
    event: "tool_result",
    handler: (event: FactoryPiToolEvent, ctx: FactoryPiEventContext) => void | Promise<void>,
  ): void;
  on(
    event: "agent_end",
    handler: (event: unknown, ctx: FactoryPiEventContext) => void | Promise<void>,
  ): void;
  registerCommand(
    name: string,
    command: {
      description?: string;
      getArgumentCompletions?: (prefix: string) => Promise<FactoryPiAutocompleteItem[] | null> | FactoryPiAutocompleteItem[] | null;
      handler: (args: string, ctx: FactoryPiCommandContext & Record<string, unknown>) => Promise<void>;
    },
  ): void;
  setModel(model: unknown): Promise<boolean>;
}

export interface FactoryPiToolEvent {
  name?: string;
  toolName?: string;
  command?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  status?: string;
  isError?: boolean;
  details?: unknown;
  content?: unknown;
}

export interface FactoryPiInputEvent {
  text: string;
  source?: "interactive" | "rpc" | "extension";
  images?: unknown[];
}

export type FactoryPiInputEventResult =
  | { action: "continue" }
  | { action: "transform"; text: string; images?: unknown[] }
  | { action: "handled" };

export interface FactoryPiBeforeAgentStartEvent {
  prompt?: string;
  systemPrompt?: string;
}

export interface FactoryPiBeforeAgentStartEventResult {
  message?: {
    customType: string;
    content: string;
    display?: boolean;
    details?: unknown;
  };
  systemPrompt?: string;
}

export interface FactoryPiModelRegistryLike {
  find(provider: string, model: string): unknown;
}

export interface FactoryPiEventContext extends FactoryPiCommandContext {
  modelRegistry?: FactoryPiModelRegistryLike;
}
