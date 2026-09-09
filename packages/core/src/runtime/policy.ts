import { appendFactoryRunEvent, updateFactoryRunState } from "../runs/store.js";
import { appendDecisionLedgerEntry, type DecisionOption } from "../decisions/index.js";
import { emitProgress, requestHumanDecision } from "./phase-plumbing.js";
import { verifyDecisionConstraints } from "./policy-constraints.js";
import type { RunFactoryControllerInput } from "./controller.js";

export type RuntimePolicyAction = "continue" | "retry" | "revise" | "repair" | "rerunImplementation" | "abort";

export interface RuntimePolicyDecision {
  action: RuntimePolicyAction;
  nextPhase?: string;
  feedback?: string;
  evidenceRefs?: string[];
  attempt: number;
  decidedAt: string;
}

export interface RuntimePolicyContext {
  runId: string;
  goal: string;
  currentPhase: string;
  evidence: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  allowedNextPhases: string[];
  constraints: Record<string, unknown>;
}

export interface RuntimePolicyConfig {
  enabled?: boolean;
  maxAttempts?: number;
  allowedPhasesByPhase?: Record<string, string[]>;
}

export interface RuntimePolicyExecutor {
  execute(input: { context: RuntimePolicyContext; controllerInput: RunFactoryControllerInput }): Promise<RuntimePolicyDecision>;
}

const MAX_CONSTRAINT_VIOLATIONS = 2;

export async function requestRuntimePolicy(input: {
  controllerInput: RunFactoryControllerInput;
  runDir: string;
  statePath: string;
  eventsPath: string;
  runId: string;
  context: RuntimePolicyContext;
}): Promise<RuntimePolicyDecision> {
  if (input.controllerInput.policy?.enabled === false) return decision("abort", input.context, "Runtime policy disabled");
  if (input.context.attempt > input.context.maxAttempts) return decision("abort", input.context, `Attempt ${input.context.attempt} exceeds maxAttempts ${input.context.maxAttempts}`);
  for (let violation = 0; violation <= MAX_CONSTRAINT_VIOLATIONS; violation += 1) {
    const result = input.controllerInput.policyExecutor
      ? await input.controllerInput.policyExecutor.execute({ context: input.context, controllerInput: input.controllerInput })
      : await fallbackDecision(input);
    const validation = verifyDecisionConstraints(result, input.context, input.controllerInput.policy);
    await appendFactoryRunEvent(input.eventsPath, {
      timestamp: new Date().toISOString(),
      type: validation.ok ? "policy.decision_resolved" : "policy.constraint_violation",
      data: { phase: input.context.currentPhase, action: result.action, nextPhase: result.nextPhase, reason: validation.reason, violation },
    });
    if (validation.ok) {
      const requestId = `policy-${input.runId}-${input.context.currentPhase}-${input.context.attempt}-${Date.now()}`;
      await appendDecisionLedgerEntry(input.runDir, { type: "request", request: {
        id: requestId, title: `Runtime policy: ${input.context.currentPhase}`, question: input.context.goal,
        options: policyOptions(input.context), evidenceRefs: result.evidenceRefs ?? [], source: "POLICY", reason: "FAILURE_RECOVERY",
      } });
      await appendDecisionLedgerEntry(input.runDir, { type: "resolution", result: {
        requestId, optionId: result.action, feedback: result.feedback, decidedAt: result.decidedAt,
      } });
      await updateFactoryRunState({ statePath: input.statePath, patch: { status: "RUNNING", phase: result.nextPhase ?? input.context.currentPhase } });
      await emitProgress(input.controllerInput, { runId: input.runId, phase: result.nextPhase ?? input.context.currentPhase, status: "RUNNING", message: `Policy decision: ${result.action}` });
      return result;
    }
    await appendFactoryRunEvent(input.eventsPath, { timestamp: new Date().toISOString(), type: "policy.re_prompted", data: { violation: validation.reason, attempt: violation + 1 } });
  }
  throw new Error(`Policy for '${input.context.currentPhase}' violated hard constraints ${MAX_CONSTRAINT_VIOLATIONS + 1} times`);
}

async function fallbackDecision(input: Parameters<typeof requestRuntimePolicy>[0]): Promise<RuntimePolicyDecision> {
  if (!input.controllerInput.requestDecision) return decision("abort", input.context, "No policy executor or requestDecision handler configured");
  const result = await requestHumanDecision({
    controllerInput: input.controllerInput, runDir: input.runDir, statePath: input.statePath, eventsPath: input.eventsPath, runId: input.runId,
    request: { id: `policy-${input.runId}-${input.context.currentPhase}-${input.context.attempt}-${Date.now()}`, title: `Policy for ${input.context.currentPhase}`, question: JSON.stringify(input.context), options: policyOptions(input.context), source: "POLICY", reason: "FAILURE_RECOVERY" },
  });
  const action = result.optionId === "stop" ? "abort" : result.optionId as RuntimePolicyAction;
  return { action, feedback: result.feedback, attempt: input.context.attempt, decidedAt: result.decidedAt };
}

function policyOptions(context: RuntimePolicyContext): DecisionOption[] {
  return ["continue", "retry", "revise", "repair", "rerunImplementation", "abort"]
    .filter((id) => id === "abort" || id === "continue" || context.allowedNextPhases.length === 0 || context.allowedNextPhases.includes(id))
    .map((id) => ({ id, label: id }));
}

function decision(action: RuntimePolicyAction, context: RuntimePolicyContext, feedback?: string): RuntimePolicyDecision {
  return { action, attempt: context.attempt, decidedAt: new Date().toISOString(), ...(feedback ? { feedback } : {}) };
}
