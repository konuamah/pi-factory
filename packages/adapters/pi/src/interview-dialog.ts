// Interview decision UI, extracted from decision-dialog.ts.
//
// Factory interviews are controller-native workflow stages (type: "interview").
// They surface as a single DecisionRequest whose question text may carry
// several sub-questions separated by "---". This module renders those as
// sequential one-question-at-a-time prompts, collects the answers, and folds
// them back into a single structured interview decision (feedback string).

import type { DecisionRequest, DecisionResult } from "@factory/core";
import { truncateStyledLine, wrapStyledLine } from "./text-utils.js";
import type { FactoryPiUi } from "./types.js";

const INTERVIEW_OVERLAY_HEIGHT = 22;

export async function requestInterviewDecision(
  ui: FactoryPiUi,
  request: DecisionRequest,
): Promise<DecisionResult> {
  const option = request.options[0];
  if (!option) {
    throw new Error(`Interview decision '${request.id}' has no continuation option.`);
  }

  const questions = splitInterviewQuestions(request.question);
  const answers: string[] = [];
  for (let index = 0; index < questions.length; index++) {
    const answer = await askOneQuestion(ui, request, questions[index]!, index + 1, questions.length);
    if (!answer || !answer.trim()) {
      throw new Error(`Interview decision '${request.id}' was cancelled or left blank.`);
    }
    answers.push(answer.trim());
  }

  return {
    requestId: request.id,
    optionId: option.id,
    feedback: formatInterviewAnswers(questions, answers),
    decidedAt: new Date().toISOString(),
  };
}

async function askOneQuestion(
  ui: FactoryPiUi,
  request: DecisionRequest,
  question: string,
  index: number,
  total: number,
): Promise<string | undefined> {
  const title = `${request.title} — Question ${index} of ${total}`;

  // Prefer Pi's full editor when the host exposes it (interactive TUI/RPC).
  if (ui.editor) {
    return ui.editor(title, "");
  }

  // Fall back to a custom overlay for hosts without an editor (tests, stubs).
  if (ui.custom) {
    return askWithOverlay(ui.custom, request, title, question);
  }

  throw new Error(`Interview decision '${request.id}' requires Pi custom UI; no fallback is allowed.`);
}

type CustomOverlay = NonNullable<FactoryPiUi["custom"]>;

async function askWithOverlay(
  custom: CustomOverlay,
  request: DecisionRequest,
  title: string,
  question: string,
): Promise<string | undefined> {
  let answer = "";
  let scrollOffset = 0;

  const result = await custom<string | undefined>((tui, _theme, _keybindings, done) => {
    const component = {
      render(width: number): string[] {
        const contentWidth = Math.max(24, width - 4);
        const hasAnswer = answer.trim().length > 0;
        const header = [
          title,
          "",
          ...question.split(/\r?\n/).flatMap((line) => wrapStyledLine(line, contentWidth)),
        ];
        const answerLines = wrapStyledLine(`> ${answer || ""}`, contentWidth);
        const footer = [
          "",
          "Answer",
          ...answerLines,
          "",
          hasAnswer
            ? "enter submit · ↑/↓ scroll · escape cancel"
            : "answer required before submit · ↑/↓ scroll · escape cancel",
        ];
        const availableRows = Math.max(3, INTERVIEW_OVERLAY_HEIGHT - header.length - footer.length);
        const maxOffset = Math.max(0, header.length - availableRows);
        scrollOffset = Math.min(scrollOffset, maxOffset);
        const visible = header.slice(scrollOffset, scrollOffset + availableRows);
        const position = header.length > availableRows
          ? [`Showing ${scrollOffset + 1}-${Math.min(header.length, scrollOffset + availableRows)} of ${header.length}`, ""]
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
          if (answer.trim()) {
            done(answer.trim());
          }
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
          answer = answer.slice(0, -1);
          tui.requestRender();
          return;
        }
        if (isPrintableInput(data)) {
          answer = `${answer}${data}`;
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

  return result;
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

