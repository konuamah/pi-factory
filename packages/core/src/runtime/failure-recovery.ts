import { appendFactoryRunEvent } from "../runs/store.js";
import type { DecisionOption, DecisionRequest } from "../decisions/index.js";
import { requestHumanDecision } from "./phase-plumbing.js";
import { writeRecoveryCheckpoint, type RecoveryCheckpointInput } from "./recovery-checkpoint.js";
import type { RunFactoryControllerInput } from "./controller.js";

export type FailureRecoveryAction = "retry" | "repair" | "revise" | "stop";

export interface FailureRecoveryContext {
  phase: string;
  title: string;
  reason: string;
  category: string;
  retryable: boolean;
  evidenceRefs?: string[];
  canRepair?: boolean;
  canRevise?: boolean;
  attempt: number;
  maxAttempts?: number;
}

export interface FailureRecoveryResolution {
  action: FailureRecoveryAction;
  feedback?: string;
  requestId: string;
}

export function shouldUseInteractiveRecovery(input: RunFactoryControllerInput): boolean {
  return input.failureRecovery?.enabled !== false && Boolean(input.requestDecision);
}

export function buildFailureRecoveryRequest(runId: string, context: FailureRecoveryContext): DecisionRequest {
  const options: DecisionOption[] = [
    ...(context.retryable ? [{ id: "retry", label: "I fixed it; retry this phase" }] : []),
    ...(context.canRepair ? [{ id: "repair", label: "Let Factory repair and retry" }] : []),
    ...(context.canRevise ? [{ id: "revise", label: "Revise with my guidance" }] : []),
    { id: "stop", label: "Stop and preserve the failure" },
  ];
  return {
    id: `${runId}-recovery-${slug(context.phase)}-${context.attempt}`,
    title: `Factory needs help: ${context.title}`,
    question: [
      `Phase: ${context.phase}`,
      `Problem: ${truncate(context.reason, 1200)}`,
      `Category: ${context.category}`,
      "Fix the issue if needed, then choose how Factory should continue.",
    ].join("\n"),
    context: `Recovery attempt ${context.attempt} of ${context.maxAttempts ?? 3}. Factory will not claim success without rerunning the affected phase.`,
    options,
    evidenceRefs: context.evidenceRefs ?? [],
    source: "RUNTIME",
    reason: "FAILURE_RECOVERY",
  };
}

export async function requestFailureRecovery(input: {
  controllerInput: RunFactoryControllerInput;
  runDir: string;
  statePath: string;
  eventsPath: string;
  runId: string;
  context: FailureRecoveryContext;
  checkpoint?: RecoveryCheckpointInput;
}): Promise<FailureRecoveryResolution> {
  const maxAttempts = input.context.maxAttempts ?? input.controllerInput.failureRecovery?.maxAttempts ?? 3;
  if (!shouldUseInteractiveRecovery(input.controllerInput) || input.context.attempt > maxAttempts) {
    return { action: "stop", requestId: "" };
  }
  const context = { ...input.context, maxAttempts };
  const request = buildFailureRecoveryRequest(input.runId, context);
  if (input.checkpoint) {
    await writeRecoveryCheckpoint(input.runDir, {
      ...input.checkpoint,
      version: 1,
      createdAt: new Date().toISOString(),
      recoveryContext: context,
    });
  }
  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "run.recovery_requested",
    data: {
      decisionRequestId: request.id,
      phase: input.context.phase,
      category: input.context.category,
      attempt: input.context.attempt,
      evidenceRefs: input.context.evidenceRefs ?? [],
    },
  });
  const result = await requestHumanDecision({
    controllerInput: input.controllerInput,
    runDir: input.runDir,
    statePath: input.statePath,
    eventsPath: input.eventsPath,
    runId: input.runId,
    request,
  });
  const allowed = new Set(request.options.map((option) => option.id));
  if (!allowed.has(result.optionId)) {
    await appendFactoryRunEvent(input.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "decision.invalid",
      data: { decisionRequestId: request.id, optionId: result.optionId },
    });
    return { action: "stop", feedback: `Invalid recovery option: ${result.optionId}`, requestId: request.id };
  }
  const action = result.optionId as FailureRecoveryAction;
  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "run.recovery_resolved",
    data: { decisionRequestId: request.id, phase: input.context.phase, action, attempt: input.context.attempt },
  });
  return { action, feedback: result.feedback?.trim() || undefined, requestId: request.id };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "phase";
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
