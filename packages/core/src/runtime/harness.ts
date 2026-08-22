import { runFactoryController } from "./controller.js";
import type { AgentExecutor } from "./interfaces.js";

export interface RuntimeHarnessResult {
  runId: string;
  summaryPath: string;
  plannerExecutionPath?: string;
  verificationPath: string;
}

export async function runRuntimeHarness(input: {
  cwd: string;
  goal: string;
  plannerExecutor: AgentExecutor;
  repairExecutor?: AgentExecutor;
  requestApproval?: (input: { runId: string; goal: string }) => Promise<boolean>;
}): Promise<RuntimeHarnessResult> {
  const result = await runFactoryController({
    cwd: input.cwd,
    goal: input.goal,
    plannerExecutor: input.plannerExecutor,
    repairExecutor: input.repairExecutor,
    requestApproval: input.requestApproval ?? (async () => true),
  });

  return {
    runId: result.runId,
    summaryPath: result.summaryPath,
    plannerExecutionPath: result.plannerExecutionPath,
    verificationPath: result.verificationPath,
  };
}
