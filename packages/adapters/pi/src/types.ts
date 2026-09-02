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
  editor?(title: string, prefill?: string): Promise<string | undefined>;
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

/**
 * Display width of a single character (0 for control/zero-width, 2 for East
 * Asian wide, 1 otherwise). Shared by the approval, decision-dialog, and
 * streaming-panel renderers.
 */
export function charWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0) {
    return 0;
  }
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }
  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    )
  ) {
    return 2;
  }
  return 1;
}
