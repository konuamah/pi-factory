import { runFactoryController } from "./controller.js";
import type { AgentExecutor } from "./interfaces.js";

export interface RuntimeHarnessResult {
  runId: string;
  summaryPath: string;
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
  plannerExecutor: AgentExecutor;
  builderExecutor?: AgentExecutor;
  repairExecutor?: AgentExecutor;
  reviewerExecutor?: AgentExecutor;
  requestApproval?: (input: { runId: string; goal: string }) => Promise<boolean>;
}): Promise<RuntimeHarnessResult> {
  const result = await runFactoryController({
    cwd: input.cwd,
    goal: input.goal,
    plannerExecutor: input.plannerExecutor,
    builderExecutor: input.builderExecutor,
    repairExecutor: input.repairExecutor,
    reviewerExecutor: input.reviewerExecutor,
    requestApproval: input.requestApproval ?? (async () => true),
  });

  return {
    runId: result.runId,
    summaryPath: result.summaryPath,
    plannerExecutionPath: result.plannerExecutionPath,
    builderExecutionPaths: result.builderExecutionPaths,
    integrationPath: result.integrationPath,
    finalMergePath: result.finalMergePath,
    candidateSha: result.candidateSha,
    verificationPath: result.verificationPath,
  };
}
