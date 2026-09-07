// Interview decision UI, extracted from decision-dialog.ts.
//
// Factory interviews are controller-native workflow stages (type: "interview").
// They surface as a single DecisionRequest whose question text may carry
// several sub-questions separated by "---". This module renders those as
// sequential one-question-at-a-time prompts, collects the answers, and folds
// them back into a single structured interview decision (feedback string).

import type { DecisionRequest, DecisionResult, DecisionOption, ParsedInterviewQuestion, InterviewQuestionDecision } from "@factory/core";
import { parseInterviewQuestions } from "@factory/core";
import { truncateStyledLine, wrapStyledLine } from "./text-utils.js";
import type { FactoryPiUi } from "./types.js";

const INTERVIEW_OVERLAY_HEIGHT = 22;

interface InterviewAnswer {
  answer: string;
  selectedOptionId?: string;
  selectedOptionLabel?: string;
  custom: boolean;
}

export async function requestInterviewDecision(
  ui: FactoryPiUi,
  request: DecisionRequest,
): Promise<DecisionResult> {
  const option = request.options[0];
  if (!option) {
    throw new Error(`Interview decision '${request.id}' has no continuation option.`);
  }

  const questions = parseInterviewQuestions(request.question);
  const answers: InterviewAnswer[] = [];
  for (let index = 0; index < questions.length; index++) {
    const answer = await askOneQuestion(ui, request, questions[index]!, index + 1, questions.length);
    if (!answer.answer.trim()) {
      throw new Error(`Interview decision '${request.id}' was cancelled or left blank.`);
    }
    answers.push({ ...answer, answer: answer.answer.trim() });
  }

  return {
    requestId: request.id,
    optionId: option.id,
    feedback: formatInterviewAnswers(questions, answers),
    interviewQuestions: buildInterviewQuestionDecisions(questions, answers),
    decidedAt: new Date().toISOString(),
  };
}

async function askOneQuestion(
  ui: FactoryPiUi,
  request: DecisionRequest,
  question: ParsedInterviewQuestion,
  index: number,
  total: number,
): Promise<InterviewAnswer> {
  const title = `${request.title} — Question ${index} of ${total}`;

  if (question.options.length > 0) {
    if (ui.select) {
      return askWithSelectFallback(ui, request, title, question);
    }
    if (ui.custom) {
      return askWithOptionsOverlay(ui.custom, request, title, question);
    }
    if (ui.editor) {
      const typed = await ui.editor(buildEditorPrompt(title, question), "");
      if (!typed?.trim()) {
        throw new Error(`Interview decision '${request.id}' was cancelled or left blank.`);
      }
      return { answer: typed.trim(), custom: true };
    }
    if (ui.input) {
      const typed = await ui.input(title, "Type your answer");
      if (!typed?.trim()) {
        throw new Error(`Interview decision '${request.id}' was cancelled or left blank.`);
      }
      return { answer: typed.trim(), custom: true };
    }
    throw new Error(`Interview decision '${request.id}' requires Pi custom, select, editor, or input UI for optioned questions.`);
  }

  // Prefer Pi's full editor when the host exposes it (interactive TUI/RPC).
  // The editor only displays its title above the input, so include the current
  // question there and keep the editable answer buffer empty.
  if (ui.editor) {
    const answer = await ui.editor(`${title}\n\n${question.prompt}\n\nAnswer:`, "");
    return { answer: answer ?? "", custom: true };
  }

  // Fall back to a custom overlay for hosts without an editor (tests, stubs).
  if (ui.custom) {
    const answer = await askWithTextOverlay(ui.custom, request, title, question.prompt);
    return { answer: answer ?? "", custom: true };
  }

  throw new Error(`Interview decision '${request.id}' requires Pi custom UI; no fallback is allowed.`);
}

type CustomOverlay = NonNullable<FactoryPiUi["custom"]>;

async function askWithTextOverlay(
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
        const questionLines = question
          .split(/\r?\n/)
          .flatMap((line) => wrapStyledLine(line, contentWidth));
        const header = [title, ""];
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
        const availableRows = Math.max(3, INTERVIEW_OVERLAY_HEIGHT - header.length - footer.length - 2);
        const maxOffset = Math.max(0, questionLines.length - availableRows);
        scrollOffset = Math.min(scrollOffset, maxOffset);
        const visible = questionLines.slice(scrollOffset, scrollOffset + availableRows);
        const position = questionLines.length > availableRows
          ? [`Showing ${scrollOffset + 1}-${Math.min(questionLines.length, scrollOffset + availableRows)} of ${questionLines.length}`, ""]
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
  }, overlayConfig());

  return result;
}

async function askWithOptionsOverlay(
  custom: CustomOverlay,
  request: DecisionRequest,
  title: string,
  question: ParsedInterviewQuestion,
): Promise<InterviewAnswer> {
  let selected = 0;
  let mode: "select" | "custom" = "select";
  let customAnswer = "";
  let scrollOffset = 0;
  const customIndex = question.options.length;

  const result = await custom<InterviewAnswer | undefined>((tui, _theme, _keybindings, done) => {
    const component = {
      render(width: number): string[] {
        const contentWidth = Math.max(24, width - 4);
        const questionLines = question.prompt
          .split(/\r?\n/)
          .flatMap((line) => wrapStyledLine(line, contentWidth));
        const optionLines = [
          ...question.options.flatMap((option, index) => renderOptionLine(option, index, selected, contentWidth, mode === "select")),
          `  ${selected === customIndex ? "›" : " "} Custom answer…`,
        ];
        const recommendationLines = question.recommendation
          ? ["", ...wrapStyledLine(`Recommended: ${question.recommendation}`, contentWidth)]
          : [];
        const customLines = mode === "custom"
          ? ["", "Custom answer", ...wrapStyledLine(`> ${customAnswer || ""}`, contentWidth)]
          : [];
        const footer = [
          "",
          mode === "custom"
            ? (customAnswer.trim()
              ? "enter submit · ↑/↓ move · backspace edit · escape cancel"
              : "type an answer · ↑/↓ move · backspace edit · escape cancel")
            : "↑/↓ select · enter choose · escape cancel",
        ];
        const allBody = [...questionLines, "", "Options", ...optionLines, ...recommendationLines, ...customLines];
        const header = [title, ""];
        const availableRows = Math.max(3, INTERVIEW_OVERLAY_HEIGHT - header.length - footer.length - 2);
        const maxOffset = Math.max(0, allBody.length - availableRows);
        scrollOffset = Math.min(scrollOffset, maxOffset);
        const visible = allBody.slice(scrollOffset, scrollOffset + availableRows);
        const position = allBody.length > availableRows
          ? [`Showing ${scrollOffset + 1}-${Math.min(allBody.length, scrollOffset + availableRows)} of ${allBody.length}`, ""]
          : [];
        return fixedHeightLines([...header, ...position, ...visible, ...footer], contentWidth, INTERVIEW_OVERLAY_HEIGHT);
      },
      invalidate(): void {},
      handleInput(data: string): void {
        if (data === "\u001b") {
          done(undefined);
          return;
        }
        if (data === "\u001b[A") {
          selected = Math.max(0, selected - 1);
          if (mode === "custom" && selected !== customIndex) {
            mode = "select";
          }
          tui.requestRender();
          return;
        }
        if (data === "\u001b[B") {
          selected = Math.min(customIndex, selected + 1);
          if (selected === customIndex && mode !== "custom") {
            mode = "select";
          }
          tui.requestRender();
          return;
        }
        if (data === "\r" || data === "\n") {
          if (mode === "custom") {
            if (customAnswer.trim()) {
              done({ answer: customAnswer.trim(), custom: true });
            }
            return;
          }
          if (selected === customIndex) {
            mode = "custom";
            tui.requestRender();
            return;
          }
          const option = question.options[selected];
          if (option) {
            done({ answer: option.label, selectedOptionId: option.id, selectedOptionLabel: option.label, custom: false });
          }
          return;
        }
        if (mode === "custom") {
          if (data === "\u007f" || data === "\b") {
            customAnswer = customAnswer.slice(0, -1);
            tui.requestRender();
            return;
          }
          if (isPrintableInput(data)) {
            customAnswer = `${customAnswer}${data}`;
            tui.requestRender();
          }
        }
      },
    };

    tui.requestRender();
    return component;
  }, overlayConfig());

  if (!result) {
    throw new Error(`Interview decision '${request.id}' was cancelled or left blank.`);
  }
  return result;
}

async function askWithSelectFallback(
  ui: FactoryPiUi,
  request: DecisionRequest,
  title: string,
  question: ParsedInterviewQuestion,
): Promise<InterviewAnswer> {
  const choice = await ui.select?.(
    title,
    [
      ...question.options.map((option) => option.description ? `${option.label} — ${option.description}` : option.label),
      "Custom answer…",
    ],
  );
  if (!choice) {
    throw new Error(`Interview decision '${request.id}' was cancelled or left blank.`);
  }
  if (choice === "Custom answer…") {
    const typed = ui.editor
      ? await ui.editor(buildEditorPrompt(title, question), "")
      : await ui.input?.(title, "Type your answer");
    if (!typed?.trim()) {
      throw new Error(`Interview decision '${request.id}' was cancelled or left blank.`);
    }
    return { answer: typed.trim(), custom: true };
  }
  const option = question.options.find((candidate) => choice === candidate.label || choice.startsWith(`${candidate.label} — `));
  if (!option) {
    throw new Error(`Interview decision '${request.id}' returned an unknown interview option: ${choice}`);
  }
  return { answer: option.label, selectedOptionId: option.id, selectedOptionLabel: option.label, custom: false };
}

function renderOptionLine(
  option: DecisionOption,
  index: number,
  selected: number,
  width: number,
  interactive: boolean,
): string[] {
  const marker = index === selected && interactive ? "›" : " ";
  const head = `  ${marker} [${option.id.toUpperCase()}] ${option.label}`;
  const lines = wrapStyledLine(head, width);
  if (!option.description) {
    return lines;
  }
  return [...lines, ...wrapStyledLine(`      ${option.description}`, width)];
}

function buildEditorPrompt(title: string, question: ParsedInterviewQuestion): string {
  const optionLines = question.options.map((option) => `- [${option.id.toUpperCase()}] ${option.label}${option.description ? ` — ${option.description}` : ""}`);
  return [
    title,
    "",
    question.prompt,
    "",
    "Options:",
    ...optionLines,
    question.recommendation ? `\nRecommended: ${question.recommendation}` : undefined,
    "",
    "Type your answer:",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function overlayConfig(): { overlay: boolean; overlayOptions: Record<string, unknown> } {
  return {
    overlay: true,
    overlayOptions: {
      width: "95%",
      maxHeight: INTERVIEW_OVERLAY_HEIGHT,
      anchor: "top-center",
      margin: { top: 1, right: 1, bottom: 1, left: 1 },
    },
  };
}

function fixedHeightLines(lines: string[], width: number, height: number): string[] {
  const rendered = lines.slice(0, height).map((line) => truncateStyledLine(line, width));
  while (rendered.length < height) {
    rendered.push("");
  }
  return rendered;
}

function buildInterviewQuestionDecisions(questions: ParsedInterviewQuestion[], answers: InterviewAnswer[]): InterviewQuestionDecision[] {
  return questions.map((question, index) => ({
    index: index + 1,
    prompt: question.prompt || question.raw,
    ...(question.options.length ? { options: question.options } : {}),
    ...(question.recommendation ? { recommendation: question.recommendation } : {}),
    ...(answers[index]?.selectedOptionId ? { selectedOptionId: answers[index]?.selectedOptionId } : {}),
    ...(answers[index]?.selectedOptionLabel ? { selectedOptionLabel: answers[index]?.selectedOptionLabel } : {}),
    ...(answers[index]?.custom ? { customAnswer: answers[index]?.answer ?? "" } : {}),
    finalAnswer: (answers[index]?.answer ?? "").trim(),
  }));
}

function formatInterviewAnswers(questions: ParsedInterviewQuestion[], answers: InterviewAnswer[]): string {
  return questions.map((question, index) => {
    const title = firstNonEmptyLine(question.prompt || question.raw) ?? `Question ${index + 1}`;
    return [
      `Q${index + 1}: ${stripMarkdown(title)}`,
      answers[index]?.selectedOptionLabel ? `Choice${index + 1}: [${(answers[index]?.selectedOptionId ?? "").toUpperCase()}] ${answers[index]?.selectedOptionLabel}` : undefined,
      answers[index]?.custom ? `Choice${index + 1}: custom` : undefined,
      `A${index + 1}: ${(answers[index]?.answer ?? "").trim()}`,
    ].filter(Boolean).join("\n");
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
