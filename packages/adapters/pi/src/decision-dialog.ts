import type { DecisionRequest, DecisionResult } from "@factory/core";
import type { FactoryPiUi } from "./types.js";

const INTERVIEW_OVERLAY_HEIGHT = 22;

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

async function requestInterviewDecision(
  ui: FactoryPiUi,
  request: DecisionRequest,
): Promise<DecisionResult> {
  const option = request.options[0];
  if (!option) {
    throw new Error(`Interview decision '${request.id}' has no continuation option.`);
  }

  if (!ui.custom) {
    throw new Error(`Interview decision '${request.id}' requires Pi custom UI; no fallback is allowed.`);
  }

  const result = await ui.custom<DecisionResult | undefined>((tui, _theme, _keybindings, done) => {
    const questions = splitInterviewQuestions(request.question);
    const answers = questions.map(() => "");
    let index = 0;
    let scrollOffset = 0;

    const component = {
      render(width: number): string[] {
        const contentWidth = Math.max(24, width - 4);
        const current = questions[index] ?? request.question;
        const answer = answers[index] ?? "";
        const hasCurrentAnswer = answer.trim().length > 0;
        const header = [
          request.title,
          `Question ${index + 1} of ${questions.length}`,
          "",
        ];
        const body = current.split(/\r?\n/).flatMap((line) => wrapStyledLine(line, contentWidth));
        const answerLines = wrapStyledLine(`> ${answer || ""}`, contentWidth);
        const footer = [
          "",
          "Answer",
          ...answerLines,
          "",
          index === questions.length - 1
            ? hasCurrentAnswer
              ? "← previous · ↑/↓ scroll · enter submit all · escape cancel"
              : "answer required before submit · ↑/↓ scroll · escape cancel"
            : hasCurrentAnswer
              ? "→ next · ← previous · ↑/↓ scroll · escape cancel"
              : "answer required before next · ↑/↓ scroll · escape cancel",
        ];
        const availableRows = Math.max(3, INTERVIEW_OVERLAY_HEIGHT - header.length - footer.length);
        const maxOffset = Math.max(0, body.length - availableRows);
        scrollOffset = Math.min(scrollOffset, maxOffset);
        const visible = body.slice(scrollOffset, scrollOffset + availableRows);
        const position = body.length > availableRows
          ? [`Showing ${scrollOffset + 1}-${Math.min(body.length, scrollOffset + availableRows)} of ${body.length}`, ""]
          : [];
        return fixedHeightLines([...header, ...position, ...visible, ...footer], contentWidth, INTERVIEW_OVERLAY_HEIGHT);
      },
      invalidate(): void {},
      handleInput(data: string): void {
        if (data === "\u001b") {
          done(undefined);
          return;
        }
        if (data === "\r" || data === "\n") {
          if (answers.every((value) => value.trim())) {
            done({
              requestId: request.id,
              optionId: option.id,
              feedback: formatInterviewAnswers(questions, answers),
              decidedAt: new Date().toISOString(),
            });
          } else if ((answers[index] ?? "").trim() && index < questions.length - 1) {
            index += 1;
            scrollOffset = 0;
            tui.requestRender();
          }
          return;
        }
        if (data === "\u001b[C") {
          if ((answers[index] ?? "").trim()) {
            index = Math.min(questions.length - 1, index + 1);
            scrollOffset = 0;
            tui.requestRender();
          }
          return;
        }
        if (data === "\u001b[D") {
          index = Math.max(0, index - 1);
          scrollOffset = 0;
          tui.requestRender();
          return;
        }
        if (data === "\u001b[A") {
          scrollOffset = Math.max(0, scrollOffset - 1);
          tui.requestRender();
          return;
        }
        if (data === "\u001b[B") {
          scrollOffset += 1;
          tui.requestRender();
          return;
        }
        if (data === "\u007f" || data === "\b") {
          answers[index] = (answers[index] ?? "").slice(0, -1);
          tui.requestRender();
          return;
        }
        if (isPrintableInput(data)) {
          answers[index] = `${answers[index] ?? ""}${data}`;
          tui.requestRender();
        }
      },
    };

    tui.requestRender();
    return component;
  }, {
    overlay: true,
    overlayOptions: {
      width: "95%",
      maxHeight: INTERVIEW_OVERLAY_HEIGHT,
      anchor: "top-center",
      margin: { top: 1, right: 1, bottom: 1, left: 1 },
    },
  });

  if (result) {
    return result;
  }

  throw new Error(`Interview decision '${request.id}' was cancelled or left blank.`);
}

function splitInterviewQuestions(value: string): string[] {
  const blocks = value
    .split(/\n\s*---+\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);
  return blocks.length > 0 ? blocks : [value.trim()].filter(Boolean);
}

function fixedHeightLines(lines: string[], width: number, height: number): string[] {
  const rendered = lines.slice(0, height).map((line) => truncateStyledLine(line, width));
  while (rendered.length < height) {
    rendered.push("");
  }
  return rendered;
}

function formatInterviewAnswers(questions: string[], answers: string[]): string {
  return questions.map((question, index) => {
    const title = firstNonEmptyLine(question) ?? `Question ${index + 1}`;
    return `Q${index + 1}: ${stripMarkdown(title)}\nA${index + 1}: ${(answers[index] ?? "").trim()}`;
  }).join("\n\n");
}

function firstNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function stripMarkdown(value: string): string {
  return value.replace(/\*\*/g, "").replace(/^[-*]\s+/, "").trim();
}

function isPrintableInput(value: string): boolean {
  return value.length > 0 && !value.startsWith("\u001b") && [...value].every((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint >= 32 && codePoint !== 127;
  });
}

function truncateStyledLine(value: string, width: number): string {
  if (visibleWidth(value) <= width) {
    return value;
  }
  if (width <= 1) {
    return sliceStyledLine(value, width).text;
  }
  return `${sliceStyledLine(value, width - 1).text}…${resetAnsi(value)}`;
}

function wrapStyledLine(value: string, width: number): string[] {
  if (width <= 0) {
    return [""];
  }
  const results: string[] = [];
  let remaining = value;
  while (visibleWidth(remaining) > width) {
    const sliced = sliceStyledLine(remaining, width);
    results.push(`${sliced.text}${resetAnsi(remaining)}`);
    remaining = sliced.remaining;
  }
  results.push(remaining);
  return results;
}

function sliceStyledLine(value: string, maxWidth: number): { text: string; remaining: string } {
  let width = 0;
  let index = 0;
  for (const part of ansiAwareParts(value)) {
    if (part.ansi) {
      index += part.text.length;
      continue;
    }
    for (const char of part.text) {
      const nextWidth = width + charWidth(char);
      if (nextWidth > maxWidth) {
        return { text: value.slice(0, index), remaining: value.slice(index) };
      }
      width = nextWidth;
      index += char.length;
    }
  }
  return { text: value, remaining: "" };
}

function visibleWidth(value: string): number {
  let width = 0;
  for (const part of ansiAwareParts(value)) {
    if (part.ansi) {
      continue;
    }
    for (const char of part.text) {
      width += charWidth(char);
    }
  }
  return width;
}

function ansiAwareParts(value: string): Array<{ text: string; ansi: boolean }> {
  const parts: Array<{ text: string; ansi: boolean }> = [];
  const ansiPattern = /\u001b\[[0-?]*[ -/]*[@-~]/g;
  let lastIndex = 0;
  for (const match of value.matchAll(ansiPattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push({ text: value.slice(lastIndex, index), ansi: false });
    }
    parts.push({ text: match[0], ansi: true });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < value.length) {
    parts.push({ text: value.slice(lastIndex), ansi: false });
  }
  return parts;
}

function resetAnsi(value: string): string {
  return /\u001b\[[0-?]*[ -/]*m/.test(value) ? "\u001b[0m" : "";
}

function charWidth(char: string): number {
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
