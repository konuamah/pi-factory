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
  registerCommand(
    name: string,
    command: {
      description?: string;
      getArgumentCompletions?: (prefix: string) => Promise<FactoryPiAutocompleteItem[] | null> | FactoryPiAutocompleteItem[] | null;
      handler: (args: string, ctx: FactoryPiCommandContext & Record<string, unknown>) => Promise<void>;
    },
  ): void;
}
