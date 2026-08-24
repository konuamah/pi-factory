import type { FactoryPiUi } from "./types.js";

export interface FactoryStreamingPanelState {
  title: string;
  goal?: string;
  phase?: string;
  role?: string;
  status?: string;
  lines: string[];
  footer?: string;
}

export interface FactoryStreamingPanelController {
  setPhase(value: string): void;
  setRole(value: string | undefined): void;
  setStatus(value: string): void;
  append(text: string): void;
  appendStream(text: string): void;
  setLines(lines: string[]): void;
  setFooter(value: string | undefined): void;
  setKeyHandler(handler: ((data: string) => boolean | void) | undefined): void;
}

export function mountFactoryStreamingWidget(
  ui: FactoryPiUi,
  widgetId: string,
  initial: FactoryStreamingPanelState,
): FactoryStreamingPanelController {
  const component = new FactoryStreamingPanelComponent(initial);
  ui.setWidget(widgetId, (tui: { requestRender(): void }) => {
    component.setRequestRender(() => tui.requestRender());
    return component;
  });
  return component.controller;
}

class FactoryStreamingPanelComponent {
  private state: FactoryStreamingPanelState;
  private requestRender?: () => void;
  private scrollOffset = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private keyHandler?: (data: string) => boolean | void;
  private streamLineActive = false;

  readonly controller: FactoryStreamingPanelController;

  constructor(initial: FactoryStreamingPanelState) {
    this.state = { ...initial, lines: [...initial.lines] };
    this.controller = {
      setPhase: (value) => {
        this.state.phase = value;
        this.invalidateAndRender();
      },
      setRole: (value) => {
        this.state.role = value;
        this.invalidateAndRender();
      },
      setStatus: (value) => {
        this.state.status = value;
        this.invalidateAndRender();
      },
      append: (text) => {
        const chunks = text.split(/\r?\n/).filter(Boolean);
        this.state.lines.push(...chunks);
        if (this.state.lines.length > 200) {
          this.state.lines = this.state.lines.slice(-200);
        }
        this.streamLineActive = false;
        this.scrollOffset = 0;
        this.invalidateAndRender();
      },
      appendStream: (text) => {
        this.appendStreamText(text);
        this.scrollOffset = 0;
        this.invalidateAndRender();
      },
      setLines: (lines) => {
        this.state.lines = [...lines];
        this.streamLineActive = false;
        this.scrollOffset = 0;
        this.invalidateAndRender();
      },
      setFooter: (value) => {
        this.state.footer = value;
        this.invalidateAndRender();
      },
      setKeyHandler: (handler) => {
        this.keyHandler = handler;
      },
    };
  }

  setRequestRender(requestRender: () => void): void {
    this.requestRender = requestRender;
  }

  handleInput(data: string): void {
    if (this.keyHandler?.(data)) {
      return;
    }
    if (data === "\u001b[A") {
      this.scrollOffset = Math.min(this.scrollOffset + 1, Math.max(0, this.state.lines.length - 1));
      this.invalidateAndRender();
    } else if (data === "\u001b[B") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.invalidateAndRender();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const header = [
      this.state.title,
      ...(this.state.goal ? [truncate(`Goal: ${this.state.goal}`, width)] : []),
      ...(this.state.phase ? [truncate(`Phase: ${this.state.phase}`, width)] : []),
      ...(this.state.role ? [truncate(`Role: ${this.state.role}`, width)] : []),
      ...(this.state.status ? [truncate(`Status: ${this.state.status}`, width)] : []),
      "",
    ];

    const visibleBody = this.state.lines.slice(
      Math.max(0, this.state.lines.length - 16 - this.scrollOffset),
      this.state.lines.length - this.scrollOffset,
    );
    const body = visibleBody.length > 0 ? visibleBody.flatMap((line) => wrap(line, width)) : ["(waiting for output)"];
    const footer = this.state.footer ? ["", truncate(this.state.footer, width)] : [];

    this.cachedLines = [...header, ...body, ...footer].map((line) => truncate(line, width));
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private invalidateAndRender(): void {
    this.invalidate();
    this.requestRender?.();
  }

  private appendStreamText(text: string): void {
    if (!text) {
      return;
    }
    if (!this.streamLineActive || this.state.lines.length === 0) {
      this.state.lines.push("");
      this.streamLineActive = true;
    }

    const parts = text.split(/\r?\n/);
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      this.state.lines[this.state.lines.length - 1] = `${this.state.lines[this.state.lines.length - 1] ?? ""}${part}`;
      if (index < parts.length - 1) {
        this.state.lines.push("");
      }
    }

    if (this.state.lines.at(-1) === "") {
      this.streamLineActive = false;
      this.state.lines.pop();
    }
    if (this.state.lines.length > 200) {
      this.state.lines = this.state.lines.slice(-200);
    }
  }
}

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  if (width <= 1) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 1)}…`;
}

function wrap(value: string, width: number): string[] {
  if (width <= 0) {
    return [""];
  }
  const results: string[] = [];
  let remaining = value;
  while (remaining.length > width) {
    results.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }
  results.push(remaining);
  return results;
}
