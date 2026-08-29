import { charWidth } from "./types.js";
import type { FactoryPiUi } from "./types.js";

const STREAM_RENDER_GUTTER = 6;

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

    const renderWidth = Math.max(1, width - STREAM_RENDER_GUTTER);
    const header = [
      truncate(this.state.title, renderWidth),
      ...(this.state.goal ? [truncate(`Goal: ${this.state.goal}`, renderWidth)] : []),
      ...(this.state.phase ? [truncate(`Phase: ${this.state.phase}`, renderWidth)] : []),
      ...(this.state.role ? [truncate(`Role: ${this.state.role}`, renderWidth)] : []),
      ...(this.state.status ? [truncate(`Status: ${this.state.status}`, renderWidth)] : []),
      "",
    ];

    const visibleBody = this.state.lines.slice(
      Math.max(0, this.state.lines.length - 16 - this.scrollOffset),
      this.state.lines.length - this.scrollOffset,
    );
    const body = visibleBody.length > 0 ? visibleBody.flatMap((line) => wrap(line, renderWidth)) : ["(waiting for output)"];
    const footer = this.state.footer ? ["", truncate(this.state.footer, renderWidth)] : [];

    this.cachedLines = [...header, ...body, ...footer].map((line) => truncate(line, renderWidth));
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
  const plain = stripAnsi(value);
  if (visibleWidth(plain) <= width) {
    return plain;
  }
  if (width <= 1) {
    return sliceToWidth(plain, width);
  }
  return `${sliceToWidth(plain, width - 1)}…`;
}

function wrap(value: string, width: number): string[] {
  if (width <= 0) {
    return [""];
  }
  const results: string[] = [];
  let remaining = stripAnsi(value);
  while (visibleWidth(remaining) > width) {
    const chunk = sliceToWidth(remaining, width);
    results.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  results.push(remaining);
  return results;
}

function visibleWidth(value: string): number {
  let width = 0;
  for (const char of stripAnsi(value)) {
    width += charWidth(char);
  }
  return width;
}

function sliceToWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }
  let width = 0;
  let result = "";
  for (const char of value) {
    const nextWidth = width + charWidth(char);
    if (nextWidth > maxWidth) {
      break;
    }
    result += char;
    width = nextWidth;
  }
  return result;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

