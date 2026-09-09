// Phase plumbing (movePhase/emitProgress/decisions/wait) — extracted from
// controller.ts. Runtime state transitions + human-decision gate; no phase
// orchestration.

import { appendFactoryRunEvent, updateFactoryRunState } from "../runs/store.js";
import { appendDecisionLedgerEntry, findPendingDecision, readDecisionLedger, type DecisionRequest, type DecisionResult } from "../decisions/index.js";
import type { RunFactoryControllerInput, FactoryRunProgressEvent } from "./controller.js";
import fs from "node:fs/promises";
import path from "node:path";

export async function movePhase(
  statePath: string,
  eventsPath: string,
  runId: string,
  input: RunFactoryControllerInput,
  phase: string,
  message: string,
): Promise<void> {
  await updateFactoryRunState({
    statePath,
    patch: { status: "RUNNING", phase },
  });
  await appendFactoryRunEvent(eventsPath, {
    timestamp: new Date().toISOString(),
    type: `phase.${phase}`,
    data: { message },
  });
  await emitProgress(input, {
    runId,
    phase,
    status: "RUNNING",
    message,
  });
}

export async function emitProgress(
  input: RunFactoryControllerInput,
  event: FactoryRunProgressEvent,
): Promise<void> {
  await input.onProgress?.(event);
}

export async function loadConstitutionConflicts(projectRoot: string): Promise<Array<{ areas: number[]; message: string }>> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, ".factory", "constitution", "facts.json"), "utf8");
    const facts = JSON.parse(raw) as { areas?: Array<{ id?: number; claims?: Array<{ kind?: string; statement?: string }> }> };
    const conflicts = new Map<string, number[]>();
    for (const area of facts.areas ?? []) {
      for (const claim of area.claims ?? []) {
        if (claim.kind === "conflict" && claim.statement) {
          const areas = conflicts.get(claim.statement) ?? [];
          if (typeof area.id === "number" && !areas.includes(area.id)) {
            areas.push(area.id);
          }
          conflicts.set(claim.statement, areas);
        }
      }
    }
    return [...conflicts.entries()].map(([message, areas]) => ({ message, areas }));
  } catch {
    return [];
  }
}

export async function loadRunDecisions(runDir: string): Promise<Array<{ requestId: string; question: string; optionId: string; feedback?: string }>> {
  const { readDecisionLedger } = await import("../decisions/index.js");
  const entries = await readDecisionLedger(runDir).catch(() => []);
  const resolutions: Array<{ type: "resolution"; result: { requestId: string; optionId: string; feedback?: string } }> = [];
  const requests = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type === "request") {
      requests.set(entry.request.id, entry.request.question);
    } else if (entry.type === "resolution") {
      resolutions.push(entry as { type: "resolution"; result: { requestId: string; optionId: string; feedback?: string } });
    }
  }
  return resolutions.map((entry) => ({
    requestId: entry.result.requestId,
    question: requests.get(entry.result.requestId) ?? entry.result.requestId,
    optionId: entry.result.optionId,
    ...(entry.result.feedback ? { feedback: entry.result.feedback } : {}),
  }));
}

export async function requestHumanDecision(input: {
  controllerInput: RunFactoryControllerInput;
  runDir: string;
  statePath: string;
  eventsPath: string;
  runId: string;
  request: DecisionRequest;
}): Promise<DecisionResult> {
  // Persist the request first (audit + resume point).
  await appendDecisionLedgerEntry(input.runDir, { type: "request", request: input.request });

  // Pause the run in DECISION_REQUIRED state so a restart knows what it was waiting for.
  await updateFactoryRunState({
    statePath: input.statePath,
    patch: { status: "DECISION_REQUIRED", phase: `decision-${input.request.source.toLowerCase()}` },
  });
  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "decision.required",
    data: {
      decisionRequestId: input.request.id,
      title: input.request.title,
      question: input.request.question,
      options: input.request.options.map((option) => option.id),
      evidenceRefs: input.request.evidenceRefs ?? [],
      source: input.request.source,
      reason: input.request.reason,
    },
  });
  await emitProgress(input.controllerInput, {
    runId: input.runId,
    phase: `decision-${input.request.source.toLowerCase()}`,
    status: "DECISION_REQUIRED",
    message: `Decision required: ${input.request.title}`,
  });

  // Reuse a persisted resolution if this request was already decided (resume case).
  const pending = await findPendingDecision(input.runDir);
  if (!pending) {
    throw new Error(`Decision request '${input.request.id}' has no pending state; cannot resume.`);
  }

  const decide = input.controllerInput.requestDecision;
  if (!decide) {
    throw new Error(`Decision required ('${input.request.id}') but no requestDecision handler is configured.`);
  }
  const result = await decide(pending);

  // Persist the resolution and resume.
  await appendDecisionLedgerEntry(input.runDir, { type: "resolution", result });
  await updateFactoryRunState({
    statePath: input.statePath,
    patch: { status: "RUNNING", phase: "running" },
  });
  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "decision.resolved",
    data: {
      decisionRequestId: result.requestId,
      optionId: result.optionId,
      feedback: result.feedback,
    },
  });
  await emitProgress(input.controllerInput, {
    runId: input.runId,
    phase: "running",
    status: "RUNNING",
    message: `Decision resolved: ${result.optionId}`,
  });

  return result;
}

export async function wait(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

