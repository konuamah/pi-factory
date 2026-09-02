import type { DecisionRequest, DecisionResult } from "@factory/core";
import { requestInterviewDecision } from "./interview-dialog.js";
import { truncateStyledLine } from "./text-utils.js";
import type { FactoryPiUi } from "./types.js";

export function buildDecisionPreviewLines(request: DecisionRequest): string[] {
  const lines = [
    "DECISION REQUIRED",
    "",
    `Question: ${request.question}`,
    request.context ? `Context: ${request.context}` : undefined,
    request.evidenceRefs?.length ? `Evidence: ${request.evidenceRefs.join(", ")}` : undefined,
    "",
    "Options:",
    ...request.options.map((option, index) => `  ${String.fromCharCode(65 + index)} — ${option.label}${option.description ? ` (${option.description})` : ""}`),
  ].filter((line): line is string => Boolean(line));
  return lines;
}

export async function requestDecisionInput(
  ui: FactoryPiUi,
  request: DecisionRequest,
): Promise<DecisionResult> {
  if (request.source === "INTERVIEW") {
    return requestInterviewDecision(ui, request);
  }

  // Try the custom dialog first.
  if (ui.custom) {
    const result = await ui.custom<DecisionResult | undefined>((tui, _theme, _keybindings, done) => {
      let selected = 0;
      const letters = "ABCDEFGHIJ";

      const render = (): void => {
        tui.requestRender();
      };

      const component = {
        render(width: number): string[] {
          const contentWidth = Math.max(1, width - 4);
          const lines = buildDecisionPreviewLines(request);
          const optionStart = lines.findIndex((line) => line === "Options:");
          const header = lines.slice(0, optionStart + 1);
          const options = request.options.map((option, index) => {
            const marker = index === selected ? "›" : " ";
            return `  ${marker} ${letters[index] ?? "?"} — ${option.label}${option.description ? ` (${option.description})` : ""}`;
          });
          const footer = ["", "↑/↓ select · Enter choose · Esc cancel"];
          return [...header, ...options, ...footer].map((line) => truncateStyledLine(line, contentWidth));
        },
        invalidate(): void {},
        handleInput(data: string): void {
          if (data === "\u001b[A") {
            selected = Math.max(0, selected - 1);
            render();
          } else if (data === "\u001b[B") {
            selected = Math.min(request.options.length - 1, selected + 1);
            render();
          } else if (data === "\r" || data === "\n") {
            const option = request.options[selected];
            if (option) {
              done({
                requestId: request.id,
                optionId: option.id,
                decidedAt: new Date().toISOString(),
              });
            }
          } else if (data === "\u001b") {
            done(undefined);
          }
        },
      };

      render();
      return component;
    });
    if (result) {
      return result;
    }
  }

  // Fallback: select + input.
  if (ui.select) {
    const choice = await ui.select(request.question, request.options.map((option) => option.label));
    const index = request.options.findIndex((option) => option.label === choice);
    if (index >= 0) {
      const option = request.options[index]!;
      const feedback = ui.input
        ? await ui.input("Decision feedback (optional)", "Optional explanation")
        : undefined;
      return {
        requestId: request.id,
        optionId: option.id,
        ...(feedback?.trim() ? { feedback: feedback.trim() } : {}),
        decidedAt: new Date().toISOString(),
      };
    }
  }

  // Last resort: confirm.
  if (ui.confirm) {
    const approved = await ui.confirm(
      "Factory decision required",
      `${request.question}\nOptions: ${request.options.map((option) => option.label).join(" | ")}`,
    );
    if (approved) {
      const option = request.options[0]!;
      return { requestId: request.id, optionId: option.id, decidedAt: new Date().toISOString() };
    }
  }

  throw new Error(`No decision UI available for decision '${request.id}'.`);
}

