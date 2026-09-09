import type { RuntimePolicyConfig, RuntimePolicyContext, RuntimePolicyDecision, RuntimePolicyAction } from "./policy.js";

export interface PolicyConstraintResult {
  ok: boolean;
  reason?: string;
}

const ACTIONS = new Set<RuntimePolicyAction>([
  "continue", "retry", "revise", "repair", "rerunImplementation", "abort",
]);

export function verifyDecisionConstraints(
  decision: RuntimePolicyDecision,
  context: RuntimePolicyContext,
  config?: RuntimePolicyConfig,
): PolicyConstraintResult {
  if (!decision || !ACTIONS.has(decision.action)) return { ok: false, reason: "Unknown policy action" };
  if (!Number.isInteger(decision.attempt) || decision.attempt !== context.attempt) {
    return { ok: false, reason: `Decision attempt ${decision.attempt} does not match current attempt ${context.attempt}` };
  }
  if (decision.attempt > context.maxAttempts) return { ok: false, reason: `Attempt ${decision.attempt} exceeds maxAttempts ${context.maxAttempts}` };
  if (!decision.decidedAt || Number.isNaN(Date.parse(decision.decidedAt))) return { ok: false, reason: "decidedAt must be an ISO timestamp" };
  const allowed = config?.allowedPhasesByPhase?.[context.currentPhase] ?? context.allowedNextPhases;
  if (decision.nextPhase && allowed.length > 0 && !allowed.includes(decision.nextPhase)) {
    return { ok: false, reason: `nextPhase '${decision.nextPhase}' is not allowed from '${context.currentPhase}'` };
  }
  if (decision.action === "repair" && (context.constraints.repairEnabled === false || context.constraints.hasRepairExecutor !== true)) {
    return { ok: false, reason: "repair requires an enabled repair executor" };
  }
  if (decision.action === "rerunImplementation" && context.constraints.completedTasksRerunnable !== true) {
    return { ok: false, reason: "rerunImplementation requires rerunnable completed task commits" };
  }
  if ((decision.action === "retry" || decision.action === "revise") && context.constraints.retryable === false) {
    return { ok: false, reason: `${decision.action} is not allowed for this evidence` };
  }
  return { ok: true };
}
