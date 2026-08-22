export interface FactoryPiUi {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setWidget(
    id: string,
    widget:
      | string[]
      | ((...args: unknown[]) => unknown)
      | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  confirm?(title: string, message: string): Promise<boolean>;
}

export interface FactoryPiCommandContext {
  cwd: string;
  ui: FactoryPiUi;
}

export interface FactoryPiExtensionApiLike {
  registerCommand(
    name: string,
    command: {
      description?: string;
      handler: (args: string, ctx: FactoryPiCommandContext & Record<string, unknown>) => Promise<void>;
    },
  ): void;
}
