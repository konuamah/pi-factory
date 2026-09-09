import { appendFactoryRunEvent } from "../runs/store.js";
import type { DecisionOption, DecisionRequest } from "../decisions/index.js";
import { requestHumanDecision } from "./phase-plumbing.js";
import { writeRecoveryCheckpoint, type RecoveryCheckpointInput } from "./recovery-checkpoint.js";
import type { RunFactoryControllerInput } from "./controller.js";
import { fallbackRecoveryNarration, narrateRecovery, type RecoveryOptionId } from "./recovery-narrator.js";
import type { AgentExecutionInput, AgentExecutor } from "./interfaces.js";

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

export async function buildFailureRecoveryRequest(runId: string, context: FailureRecoveryContext, narrator?: { executor?: AgentExecutor; model?: { provider?: string; model: string }; limits?: AgentExecutionInput["limits"]; disableNarrator?: boolean }): Promise<DecisionRequest> {
  const enabledOptions: RecoveryOptionId[] = [
    ...(context.retryable ? ["retry" as const] : []),
    ...(context.canRepair ? ["repair" as const] : []),
    ...(context.canRevise ? ["revise" as const] : []),
    "stop",
  ];
  let narration;
  try {
    narration = narrator?.disableNarrator
      ? fallbackRecoveryNarration(context, enabledOptions)
      : await narrateRecovery({ runId, phase: context.phase, context, enabledOptions, ...narrator });
  } catch {
    narration = fallbackRecoveryNarration(context, enabledOptions);
  }
  const options: DecisionOption[] = narration.options;
  return {
    id: `${runId}-recovery-${slug(context.phase)}-${context.attempt}`,
    title: narration.title,
    question: [
      `Phase: ${context.phase}`,
      `Problem: ${truncate(narration.problem, 1200)}`,
      `Category: ${context.category}`,
      narration.howToRecover,
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
  const request = await buildFailureRecoveryRequest(input.runId, context, {
    executor: input.controllerInput.failureClassifierExecutor ?? input.controllerInput.reviewerExecutor,
    model: input.controllerInput.failureRecovery?.narratorModel,
    disableNarrator: input.controllerInput.failureRecovery?.disableNarrator,
  });
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
  const allowed = new Set([...request.options.map((option) => option.id), "custom"]);
  if (!allowed.has(result.optionId)) {
    await appendFactoryRunEvent(input.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "decision.invalid",
      data: { decisionRequestId: request.id, optionId: result.optionId },
    });
    return { action: "stop", feedback: `Invalid recovery option: ${result.optionId}`, requestId: request.id };
  }
  const feedback = result.feedback?.trim() || undefined;
  const action: FailureRecoveryAction = result.optionId === "custom" ? (feedback ? "revise" : "stop") : result.optionId as FailureRecoveryAction;
  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "run.recovery_resolved",
    data: { decisionRequestId: request.id, phase: input.context.phase, action, attempt: input.context.attempt },
  });
  return { action, feedback, requestId: request.id };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "phase";
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
