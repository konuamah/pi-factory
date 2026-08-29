import { runFactoryController, type PlanApprovalResult } from "./controller.js";
import type { AgentExecutor } from "./interfaces.js";
import type { ModelRole } from "@factory/schemas";
import type { DecisionRequest, DecisionResult } from "../decisions/types.js";

export interface RuntimeHarnessResult {
  runId: string;
  runDir: string;
  summaryPath: string;
  discoveryExecutionPath?: string;
  plannerExecutionPath?: string;
  builderExecutionPaths?: string[];
  integrationPath?: string;
  finalMergePath?: string;
  candidateSha?: string;
  verificationPath: string;
}

export async function runRuntimeHarness(input: {
  cwd: string;
  goal: string;
  workflowId?: string;
  taskType?: string;
  modelOverrides?: Partial<Record<ModelRole, { provider?: string; model: string }>>;
  discoveryExecutor?: AgentExecutor;
  plannerExecutor: AgentExecutor;
  builderExecutor?: AgentExecutor;
  repairExecutor?: AgentExecutor;
  reviewerExecutor?: AgentExecutor;
  verificationPlannerExecutor?: AgentExecutor;
  failureClassifierExecutor?: AgentExecutor;
  requestPlanApproval?: (input: { runId: string; goal: string; planPath: string; taskCount: number; workflowStages: string[]; summary: string; discoveryText?: string; planText?: string; tasks: Array<{ id: string; title: string; stage: string; status: "pending" | "done"; dependsOn: string[]; type?: string; role?: string; commands?: string[]; requiresApproval?: boolean }> }) => Promise<PlanApprovalResult>;
  requestApproval?: (input: { runId: string; goal: string }) => Promise<boolean>;
  requestDecision?: (request: DecisionRequest) => Promise<DecisionResult>;
}): Promise<RuntimeHarnessResult> {
  const result = await runFactoryController({
    cwd: input.cwd,
    goal: input.goal,
    workflowId: input.workflowId,
    taskType: input.taskType,
    modelOverrides: input.modelOverrides,
    discoveryExecutor: input.discoveryExecutor,
    plannerExecutor: input.plannerExecutor,
    builderExecutor: input.builderExecutor,
    repairExecutor: input.repairExecutor,
    reviewerExecutor: input.reviewerExecutor,
    verificationPlannerExecutor: input.verificationPlannerExecutor,
    failureClassifierExecutor: input.failureClassifierExecutor,
    requestPlanApproval: input.requestPlanApproval ?? (async () => ({ decision: "approve" })),
    requestApproval: input.requestApproval ?? (async () => true),
    requestDecision: input.requestDecision,
  });

  return {
    runId: result.runId,
    runDir: result.runDir,
    summaryPath: result.summaryPath,
    discoveryExecutionPath: result.discoveryExecutionPath,
    plannerExecutionPath: result.plannerExecutionPath,
    builderExecutionPaths: result.builderExecutionPaths,
    integrationPath: result.integrationPath,
    finalMergePath: result.finalMergePath,
    candidateSha: result.candidateSha,
    verificationPath: result.verificationPath,
  };
}
