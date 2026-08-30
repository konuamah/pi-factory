// Headless entry point for driving a real Factory run without a human, used
// by the Harbor benchmark path (docs/factory/bombsite-benchmark-plan.md).
//
// The only piece the runtime harness lacks for headless use is a
// requestDecision handler: interview stages pause on a DecisionRequest and
// phase-plumbing throws when no handler is configured. This module supplies a
// scripted handler from a JSON answers file. Ambiguity fails loud — an
// unanswered decision throws instead of inventing an answer.

import fs from "node:fs/promises";
import type { DecisionRequest, DecisionResult } from "@factory/core";

export interface ScriptedDecisionAnswers {
  [key: string]: string;
}

// Answers file shape: { "<decision title or source>": "<answer text>" }.
// "title:<t>", "source:<s>", or a bare key all match (case-insensitive); "*" is the wildcard.
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
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Interview answers file entry "${key}" must be a non-empty answer string.`);
    }
    answers[key] = value;
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

function answerFor(request: DecisionRequest, answers: ScriptedDecisionAnswers): string | undefined {
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
    return { requestId: request.id, optionId: option.id, feedback: answer, decidedAt: new Date().toISOString() };
  };
}
