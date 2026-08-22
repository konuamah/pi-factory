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
  select?(
    title: string,
    options: Array<{ label: string; value: string; description?: string }>,
  ): Promise<string | undefined>;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
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
  registerCommand(
    name: string,
    command: {
      description?: string;
      getArgumentCompletions?: (prefix: string) => Promise<FactoryPiAutocompleteItem[] | null> | FactoryPiAutocompleteItem[] | null;
      handler: (args: string, ctx: FactoryPiCommandContext & Record<string, unknown>) => Promise<void>;
    },
  ): void;
}
