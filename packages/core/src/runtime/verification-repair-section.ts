// Verification repair section (env-prep + signature-driven repair loop) —
// extracted from verification-phase2.ts.

import { attemptEnvironmentPreparation, runVerificationRepairLoop } from "./controller-helpers.js";
import { appendFactoryRunEvent, createFactoryRun } from "../runs/store.js";
import { emitProgress } from "./phase-plumbing.js";
import { renderSkillBundleForPrompt } from "./prompts.js";
import { loadEffectiveConfig } from "../config/loader.js";
import type { RunFactoryControllerInput, TaskWorkspaceSelection } from "./controller.js";
import type { VerificationPlan, VerificationRunResult } from "./verification.js";
import type { VerificationFailureClassification } from "./failure-classification.js";
import type { VerificationContractPlan, VerificationEngineResult } from "../verification/index.js";
import type { SkillBundleSelection } from "../skills/index.js";
import type { TaskTypeSelection } from "../models/index.js";

export interface VerificationRepairState {
  run: Awaited<ReturnType<typeof createFactoryRun>>;
  input: RunFactoryControllerInput;
  loaded: Awaited<ReturnType<typeof loadEffectiveConfig>>;
  executionCwd: string;
  repairGuidanceText: string;
  repairSkills: SkillBundleSelection;
  verificationPlan: VerificationPlan;
  contractPlan: VerificationContractPlan;
  implementationChangedFiles: string[];
  verification: VerificationRunResult;
  verificationFailureClassification: VerificationFailureClassification | undefined;
  verificationPath: string;
  contractResult: VerificationEngineResult;
  repairExecutionPaths: string[];
}

export async function runVerificationRepairSection(state: VerificationRepairState): Promise<{
  verification: VerificationRunResult;
  verificationFailureClassification: VerificationFailureClassification | undefined;
  verificationPath: string;
  contractResult: VerificationEngineResult;
  repairExecutionPaths: string[];
}> {
  const { run, input, loaded, executionCwd, repairGuidanceText, repairSkills, verificationPlan, contractPlan, implementationChangedFiles } = state;
  let { verification, verificationFailureClassification, verificationPath, contractResult, repairExecutionPaths } = state;
  const repairGuidance = { text: repairGuidanceText };
  const repairExecutor = input.repairExecutor;

const environmentPrepState = await attemptEnvironmentPreparation({
run,
input,
repairExecutor,
repairModel: loaded.effectiveConfig.models.repair,
repairEnabled: loaded.effectiveConfig.repair.enabled,
verificationPlan,
implementationChangedFiles,
verification,
verificationFailureClassification,
});
verification = environmentPrepState.verification;
verificationFailureClassification = environmentPrepState.verificationFailureClassification;
const shouldAttemptEnvPrep = environmentPrepState.shouldAttemptEnvPrep;
const repairableFailures = verificationFailureClassification?.perCommand
.filter((c) => c.category === "real-code-failure" && c.suggestedAction === "repair") ?? [];
const shouldAttemptVerificationRepair = verification.overallStatus === "failed"
&& Boolean(repairExecutor)
&& loaded.effectiveConfig.repair.enabled
&& repairableFailures.length > 0;
if (verification.overallStatus === "failed" && !shouldAttemptVerificationRepair && !shouldAttemptEnvPrep) {
await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: "repair.skipped",
  data: {
    reason: verificationFailureClassification?.reason ?? "Verification failure is not eligible for repair.",
    failureKind: verificationFailureClassification?.kind,
    implementationChangedFiles,
  },
});
}

if (shouldAttemptVerificationRepair && repairExecutor) {
const repairState = await runVerificationRepairLoop({
  run,
  input,
  repairConfig: loaded.effectiveConfig.repair,
  repairModel: loaded.effectiveConfig.models.repair,
  repairGuidanceText: repairGuidance.text ?? "",
  repairSkillsBundleText: renderSkillBundleForPrompt(repairSkills),
  verificationPlan,
  contractPlan,
  implementationChangedFiles,
  executionCwd,
  verification,
  verificationFailureClassification,
  verificationPath,
  contractResult,
  repairExecutionPaths,
});
verification = repairState.verification;
verificationFailureClassification = repairState.verificationFailureClassification;
verificationPath = repairState.verificationPath;
contractResult = repairState.contractResult;
repairExecutionPaths = repairState.repairExecutionPaths;
}

let reviewerExecutionPath: string | undefined;

// Baseline-unrelated failures (pre-existing repo issues, not caused by the task)
// warn and proceed instead of failing the run.

  return { verification, verificationFailureClassification, verificationPath, contractResult, repairExecutionPaths };
}
