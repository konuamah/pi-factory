// Headless entry point for driving a real Factory run without a human, used
// by the Harbor benchmark path (docs/factory/bombsite-benchmark-plan.md).
//
// The only piece the runtime harness lacks for headless use is a
// requestDecision handler: interview stages pause on a DecisionRequest and
// phase-plumbing throws when no handler is configured. This module supplies a
// scripted handler from a JSON answers file. Ambiguity fails loud — an
// unanswered decision throws instead of inventing an answer.

import fs from "node:fs/promises";
import { parseInterviewQuestions, type DecisionRequest, type DecisionResult, type InterviewQuestionDecision } from "@factory/core";

export interface ScriptedInterviewAnswer {
  optionId?: string;
  feedback?: string;
}

export interface ScriptedInterviewAnswerSet {
  answers?: ScriptedInterviewAnswer[];
  optionId?: string;
  feedback?: string;
}

export interface ScriptedDecisionAnswers {
  [key: string]: string | ScriptedInterviewAnswerSet;
}

// Answers file shape: { "<decision title or source>": "<answer text>" }.
// "title:<t>", "source:<s>", or a bare key all match (case-insensitive); "*" is the wildcard.
// Interview answers may also use an object form for optioned questions:
// { "INTERVIEW": { "optionId": "a" } }
// or multi-question interview rounds:
// { "INTERVIEW": { "answers": [{ "optionId": "a" }, { "feedback": "custom text" }] } }
export function parseScriptedDecisionAnswers(raw: string): ScriptedDecisionAnswers {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Interview answers file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Interview answers file must be a JSON object mapping decision keys to answer text.");
  }
  const answers: ScriptedDecisionAnswers = {};
  for (const [key, value] of Object.entries(parsed)) {
    answers[key] = parseScriptedAnswerValue(key, value);
  }
  return answers;
}

export async function loadScriptedDecisionAnswers(filePath: string): Promise<ScriptedDecisionAnswers> {
  return parseScriptedDecisionAnswers(await fs.readFile(filePath, "utf8"));
}

// Keys are matched case-insensitively so an answers file does not have to know
// that Factory emits source as "INTERVIEW".
function normalizeAnswers(answers: ScriptedDecisionAnswers): ScriptedDecisionAnswers {
  const normalized: ScriptedDecisionAnswers = {};
  for (const [key, value] of Object.entries(answers)) {
    normalized[key === "*" ? key : key.toLowerCase()] = value;
  }
  return normalized;
}

function answerFor(request: DecisionRequest, answers: ScriptedDecisionAnswers): string | ScriptedInterviewAnswerSet | undefined {
  const title = request.title.toLowerCase();
  const source = request.source.toLowerCase();
  return (
    answers[`title:${title}`] ??
    answers[title] ??
    answers[`source:${source}`] ??
    answers[source] ??
    answers["*"]
  );
}

export function createScriptedDecisionHandler(answers: ScriptedDecisionAnswers): (request: DecisionRequest) => Promise<DecisionResult> {
  const normalized = normalizeAnswers(answers);
  return async (request: DecisionRequest): Promise<DecisionResult> => {
    const answer = answerFor(request, normalized);
    if (answer === undefined) {
      throw new Error(
        `Scripted interview answers have no entry for decision "${request.title}" (source ${request.source}). ` +
          `Provide a "title:${request.title.toLowerCase()}", "${request.source.toLowerCase()}", or "*" key. ` +
          `Refusing to invent an answer.`,
      );
    }
    const option = request.options[0];
    if (!option) {
      throw new Error(`Decision "${request.title}" has no options; scripted answers cannot resolve it.`);
    }
    const structured = typeof answer === "string" ? undefined : buildStructuredInterviewQuestions(request, answer);
    return {
      requestId: request.id,
      optionId: option.id,
      feedback: typeof answer === "string" ? answer : formatStructuredInterviewAnswer(request, answer),
      ...(structured?.length ? { interviewQuestions: structured } : {}),
      decidedAt: new Date().toISOString(),
    };
  };
}

function parseScriptedAnswerValue(key: string, value: unknown): string | ScriptedInterviewAnswerSet {
  if (typeof value === "string") {
    if (!value.trim()) {
      throw new Error(`Interview answers file entry "${key}" must be a non-empty answer string.`);
    }
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Interview answers file entry "${key}" must be a non-empty answer string or answer object.`);
  }
  const object = value as Record<string, unknown>;
  const parsed: ScriptedInterviewAnswerSet = {};
  if (object.optionId !== undefined) {
    if (typeof object.optionId !== "string" || !object.optionId.trim()) {
      throw new Error(`Interview answers file entry "${key}" has an invalid optionId.`);
    }
    parsed.optionId = object.optionId.trim().toLowerCase();
  }
  if (object.feedback !== undefined) {
    if (typeof object.feedback !== "string" || !object.feedback.trim()) {
      throw new Error(`Interview answers file entry "${key}" has an invalid feedback value.`);
    }
    parsed.feedback = object.feedback.trim();
  }
  if (object.answers !== undefined) {
    if (!Array.isArray(object.answers) || object.answers.length === 0) {
      throw new Error(`Interview answers file entry "${key}" must use a non-empty answers array.`);
    }
    parsed.answers = object.answers.map((entry, index) => parseStructuredInterviewAnswer(key, entry, index));
  }
  if (!parsed.answers && !parsed.optionId && !parsed.feedback) {
    throw new Error(`Interview answers file entry "${key}" must provide optionId, feedback, or answers.`);
  }
  return parsed;
}

function parseStructuredInterviewAnswer(key: string, value: unknown, index: number): ScriptedInterviewAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Interview answers file entry "${key}" answer ${index + 1} must be an object.`);
  }
  const entry = value as Record<string, unknown>;
  const optionId = entry.optionId;
  const feedback = entry.feedback;
  if (optionId !== undefined && (typeof optionId !== "string" || !optionId.trim())) {
    throw new Error(`Interview answers file entry "${key}" answer ${index + 1} has an invalid optionId.`);
  }
  if (feedback !== undefined && (typeof feedback !== "string" || !feedback.trim())) {
    throw new Error(`Interview answers file entry "${key}" answer ${index + 1} has an invalid feedback value.`);
  }
  if (optionId === undefined && feedback === undefined) {
    throw new Error(`Interview answers file entry "${key}" answer ${index + 1} must provide optionId or feedback.`);
  }
  return {
    ...(optionId ? { optionId: optionId.trim().toLowerCase() } : {}),
    ...(feedback ? { feedback: feedback.trim() } : {}),
  };
}

function buildStructuredInterviewQuestions(request: DecisionRequest, answerSet: ScriptedInterviewAnswerSet): InterviewQuestionDecision[] {
  const questions = parseInterviewQuestions(request.question);
  const answers = answerSet.answers ?? [answerSet];
  if (questions.length !== answers.length) {
    throw new Error(`Decision "${request.title}" expects ${questions.length} scripted interview answer(s), received ${answers.length}.`);
  }
  return questions.map((question, index) => {
    const answer = answers[index]!;
    const option = answer.optionId ? question.options.find((candidate) => candidate.id.toLowerCase() === answer.optionId) : undefined;
    if (answer.optionId && !option) {
      throw new Error(`Decision "${request.title}" question ${index + 1} references unknown optionId "${answer.optionId}".`);
    }
    const resolvedAnswer = option?.label ?? answer.feedback?.trim();
    if (!resolvedAnswer) {
      throw new Error(`Decision "${request.title}" question ${index + 1} has no answer text.`);
    }
    return {
      index: index + 1,
      prompt: question.prompt || question.raw,
      ...(question.options.length ? { options: question.options } : {}),
      ...(question.recommendation ? { recommendation: question.recommendation } : {}),
      ...(option ? { selectedOptionId: option.id, selectedOptionLabel: option.label } : {}),
      ...(!option ? { customAnswer: resolvedAnswer } : {}),
      finalAnswer: resolvedAnswer,
    };
  });
}

function formatStructuredInterviewAnswer(request: DecisionRequest, answerSet: ScriptedInterviewAnswerSet): string {
  return buildStructuredInterviewQuestions(request, answerSet).map((question) => {
    return [
      `Q${question.index}: ${stripMarkdown(firstNonEmptyLine(question.prompt) ?? `Question ${question.index}`)}`,
      question.selectedOptionLabel ? `Choice${question.index}: [${(question.selectedOptionId ?? "").toUpperCase()}] ${question.selectedOptionLabel}` : undefined,
      !question.selectedOptionLabel ? `Choice${question.index}: custom` : undefined,
      `A${question.index}: ${question.finalAnswer}`,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function firstNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function stripMarkdown(value: string): string {
  return value.replace(/\*\*/g, "").replace(/^[-*]\s+/, "").trim();
}
