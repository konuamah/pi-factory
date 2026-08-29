// Verification phase of the run controller — extracted from controller-run.ts.
// Returns an early-exit result on failure, or undefined to continue.

import { hydrateWorkspaceDependencies, DependencyHydrationError } from "./dependencies.js";
import { buildDependencyCacheEnv } from "./dependency-cache.js";
import path from "node:path";
import { normalizeVerificationCommands, planVerificationExecution, runVerificationCommands, type VerificationPlan, type VerificationRunResult } from "./verification.js";
import { classifyVerificationFailure, type VerificationFailureClassification } from "./failure-classification.js";
import { classifyVerificationFailuresWithAI, type ClassificationSource } from "./ai-failure-classifier.js";
import { gatherVerificationRequirements, initializeVerificationProviders, runVerificationEngine } from "../verification/index.js";
import { buildContractArtifact, failureSignature, gitChangedFiles, filterVerificationByImpact, getChangedFilesFromBase } from "./verification-planning.js";
import { writePrototypeVerificationArtifact, writePrototypeRepairExecutionArtifact, writePrototypeSummaryArtifact } from "./artifacts.js";
import { appendFactoryRunEvent, updateFactoryRunState, createFactoryRun } from "../runs/store.js";
import { appendRepoLearning } from "../learnings/store.js";
import { emitProgress, movePhase, wait, requestHumanDecision, loadConstitutionConflicts } from "./phase-plumbing.js";
import { uniqueStrings, taskWorkspacesChangedFiles } from "./task-utils.js";
import { renderSkillBundleForPrompt } from "./prompts.js";
import { attemptEnvironmentPreparation, runVerificationRepairLoop, buildRunFailureResult } from "./controller-helpers.js";
import { loadEffectiveConfig } from "../config/loader.js";
import type { RunFactoryControllerInput, RunFactoryControllerResult, TaskWorkspaceSelection, InterviewDecisionRecord } from "./controller.js";
import type { VerificationContractPlan, VerificationEngineResult } from "../verification/index.js";
import type { ReviewProviderOptions } from "../verification/providers/review.js";
import type { TaskTypeSelection } from "../models/index.js";
import type { SkillBundleSelection } from "../skills/index.js";

export interface VerificationPhaseState {
  run: Awaited<ReturnType<typeof createFactoryRun>>;
  input: RunFactoryControllerInput;
  loaded: Awaited<ReturnType<typeof loadEffectiveConfig>>;
  executionCwd: string;
  projectRoot: string;
  worktree: RunFactoryControllerResult["worktree"];
  phases: string[];
  delayMs: number;
  planPath: string;
  taskPaths: string[];
  plannerExecutionPath: string | undefined;
  builderExecutionPaths: string[];
  integrationPath: string | undefined;
  repairExecutionPaths: string[];
  discoveryExecutionPath: string | undefined;
  runTaskType: TaskTypeSelection;
  repoSkillSignals: { constitutionAreas: number[] };
  repairGuidanceText: string;
  repairSkills: SkillBundleSelection;
  implementationRun: { taskWorkspaces: TaskWorkspaceSelection[] };
  interviewDecisions: InterviewDecisionRecord[];
}

export async function runVerificationPhase(state: VerificationPhaseState): Promise<RunFactoryControllerResult | { verificationPath: string; repairExecutionPaths: string[]; verification: VerificationRunResult; verificationFailureClassification: VerificationFailureClassification | undefined; contractResult: VerificationEngineResult }> {
  const {
    run, input, loaded, executionCwd, projectRoot, worktree, phases, delayMs, planPath, taskPaths,
    plannerExecutionPath, builderExecutionPaths, integrationPath,
    discoveryExecutionPath, runTaskType, repoSkillSignals, repairGuidanceText, repairSkills,
    implementationRun, interviewDecisions,
  } = state;
  const repairGuidance = { text: repairGuidanceText };
  let repairExecutionPaths = state.repairExecutionPaths;

await movePhase(run.statePath, run.eventsPath, run.runId, input, "verification", "Planning verification strategy");
try {
  await hydrateWorkspaceDependencies({
    workspacePath: executionCwd,
    projectRoot,
    config: loaded.effectiveConfig,
    runId: run.runId,
    phase: "verification",
    onEvent: async (event) => appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: event.type,
      data: event.data,
    }),
    onRemediation: input.requestDependencyRemediation,
    mode: "agent",
  });
} catch (error) {
  const reason = error instanceof DependencyHydrationError
    ? error.message
    : `Dependency hydration failed: ${error instanceof Error ? error.message : String(error)}`;
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "run.failed",
    data: { reason },
  });
  const failedState = await updateFactoryRunState({
    statePath: run.statePath,
    patch: { status: "FAILED", phase: "verification-failed" },
  });
  await emitProgress(input, {
    runId: run.runId,
    phase: failedState.phase,
    status: "FAILED",
    message: reason,
  });
  const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
    runId: run.runId,
    goal: input.goal,
    status: "FAILED",
    phase: failedState.phase,
    approved: false,
    planPath,
    taskPaths,
    discoveryExecutionPath,
    plannerExecutionPath,
    builderExecutionPaths,
    integrationPath,
    repairExecutionPaths,
    verificationPath: path.join(run.runDir, "verification.json"),
    verificationStatus: "incomplete",
  });

  return {
    runId: run.runId,
    runDir: run.runDir,
    executionCwd,
    worktree,
    statePath: run.statePath,
    eventsPath: run.eventsPath,
    phases,
    approved: false,
    planPath,
    taskPaths,
    discoveryExecutionPath,
    plannerExecutionPath,
    builderExecutionPaths,
    integrationPath,
    repairExecutionPaths,
    verificationPath: path.join(run.runDir, "verification.json"),
    summaryPath,
  };
}
const { setup: _setupCommand, ...verificationCommands } = loaded.effectiveConfig.commands;
const normalizedCommands = normalizeVerificationCommands(verificationCommands);
// Impact-based verification: filter checks to only those affected by changes.
const changedFiles = await getChangedFilesFromBase(executionCwd, loaded.effectiveConfig.git.baseBranch);
const impactResult = filterVerificationByImpact(normalizedCommands as Record<string, string>, changedFiles);
if (impactResult.skipped.length > 0) {
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "verification.impact_filtered",
    data: {
      changedFiles,
      selectedChecks: impactResult.selected,
      skippedChecks: impactResult.skipped,
    },
  });
}
const filteredVerificationCommands = impactResult.commands;
const verificationPlan = await planVerificationExecution({
  cwd: executionCwd,
  goal: input.goal,
  commands: filteredVerificationCommands,
  constitutionContext: repairGuidance.text,
  executor: input.verificationPlannerExecutor,
  model: loaded.effectiveConfig.models.planner,
  runId: run.runId,
  allowDeterministicFallback: !input.verificationPlannerExecutor,
});
await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: "verification.plan_selected",
  data: {
    verificationCwd: verificationPlan.cwd,
    verificationCwdResolution: verificationPlan.cwdResolution,
    commandNames: Object.keys(verificationPlan.commands),
    selectionSource: verificationPlan.selectionSource,
    rationale: verificationPlan.rationale,
    evidence: verificationPlan.evidence,
    skillId: verificationPlan.skill.id,
    skillVersion: verificationPlan.skill.version,
    skillMode: verificationPlan.skill.mode,
    skillSelectionReasons: verificationPlan.skill.selectionReasons,
  },
});
await appendRepoLearning({
  projectRoot,
  category: "verification-plan",
  summary: `Verification uses ${verificationPlan.cwdResolution} at ${verificationPlan.cwd}`,
  data: {
    cwd: verificationPlan.cwd,
    cwdResolution: verificationPlan.cwdResolution,
    commandNames: Object.keys(verificationPlan.commands),
    selectionSource: verificationPlan.selectionSource,
  },
});
await emitProgress(input, {
  runId: run.runId,
  phase: "verification",
  status: "RUNNING",
  message: `Verification plan: ${Object.keys(verificationPlan.commands).join(", ") || "none"} in ${verificationPlan.cwd}`,
});
let verification = await runVerificationCommands({
  cwd: verificationPlan.cwd,
  commands: verificationPlan.commands,
  env: loaded.effectiveConfig.dependencies.enabled && loaded.effectiveConfig.dependencies.hydrate !== "never"
    ? await buildDependencyCacheEnv(loaded.effectiveConfig.dependencies.cacheRoot)
    : undefined,
});
verification.cwdResolution = verificationPlan.cwdResolution;
const implementationChangedFiles = uniqueStrings(taskWorkspacesChangedFiles(implementationRun.taskWorkspaces));
const deterministicClassification = classifyVerificationFailure({
  plan: verificationPlan,
  result: verification,
  changedFiles: implementationChangedFiles,
});
// LLM classification over deterministic evidence, with strict guards; falls back silently.
const aiResult = deterministicClassification
  ? await classifyVerificationFailuresWithAI({
      plan: verificationPlan,
      result: verification,
      changedFiles: implementationChangedFiles,
      deterministic: deterministicClassification,
      executor: input.failureClassifierExecutor ?? input.reviewerExecutor,
      model: loaded.effectiveConfig.models.reviewer,
    })
  : undefined;
let verificationFailureClassification = aiResult
  ? { ...aiResult, classificationSource: "ai" as ClassificationSource, deterministicClassification }
  : deterministicClassification
    ? { ...deterministicClassification, classificationSource: "deterministic" as ClassificationSource }
    : undefined as VerificationFailureClassification | undefined;
let verificationPath = await writePrototypeVerificationArtifact(run.runDir, {
  ...verification,
  selectionSource: verificationPlan.selectionSource,
  rationale: verificationPlan.rationale,
  skill: verificationPlan.skill,
  evidence: verificationPlan.evidence,
  failureClassification: verificationFailureClassification,
});
await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: "verification.commands_detected",
  data: {
    ...verificationPlan.commands,
    verificationCwd: verificationPlan.cwd,
    verificationCwdResolution: verificationPlan.cwdResolution,
    verificationSelectionSource: verificationPlan.selectionSource,
    verificationRationale: verificationPlan.rationale,
    verificationEvidence: verificationPlan.evidence,
    verificationSkillId: verificationPlan.skill.id,
    verificationSkillVersion: verificationPlan.skill.version,
    verificationSkillMode: verificationPlan.skill.mode,
    verificationSkillSelectionReasons: verificationPlan.skill.selectionReasons,
    verificationFailureKind: verificationFailureClassification?.kind,
    verificationFailureReason: verificationFailureClassification?.reason,
    implementationChangedFiles,
  },
});
await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: "verification.completed",
  data: {
    overallStatus: verification.overallStatus,
    failureClassification: verificationFailureClassification as unknown as Record<string, unknown> | undefined,
    implementationChangedFiles,
  },
});
if (verificationFailureClassification) {
  await appendRepoLearning({
    projectRoot,
    category: "verification-failure",
    summary: verificationFailureClassification.reason,
    data: verificationFailureClassification as unknown as Record<string, unknown>,
  });
}
await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: "verification.artifact_written",
  data: { verificationPath },
});
await emitProgress(input, {
  runId: run.runId,
  phase: "verification",
  status: verification.overallStatus === "failed" ? "FAILED" : "RUNNING",
  message: `Verification ${verification.overallStatus} in ${verification.cwd}`,
});

// Contract-based verification: gather requirements from all sources and run the engine.
const contractPlan = gatherVerificationRequirements({
  goal: input.goal,
  taskType: runTaskType.id,
  config: loaded.effectiveConfig,
  skills: undefined,
  constitutionAreas: undefined,
  conflictAreas: repoSkillSignals.constitutionAreas,
  workflowId: loaded.effectiveConfig.resolvedWorkflowId,
  commands: verificationPlan.commands,
  constitutionConflicts: await loadConstitutionConflicts(projectRoot),
});
initializeVerificationProviders({
  executor: input.reviewerExecutor,
  model: loaded.effectiveConfig.models.reviewer,
  goal: input.goal,
} satisfies ReviewProviderOptions);

// Skip contract requirements for commands already classified baseline-unrelated (ignore).
// The failure classifier is the authority: a pre-existing repo failure marked ignore
// should not re-block the contract completion gate.
const ignoredCommandNames = new Set(
  (verificationFailureClassification?.perCommand ?? [])
    .filter((c) => c.category === "baseline-unrelated" || c.suggestedAction === "ignore")
    .map((c) => c.commandName),
);
if (ignoredCommandNames.size > 0) {
  contractPlan.requirements = contractPlan.requirements.filter((requirement) => {
    if (requirement.type !== "COMMAND") {
      return true;
    }
    return !ignoredCommandNames.has(requirement.description.replace(/^Run /, "").toLowerCase());
  });
}

let contractResult = await runVerificationEngine({
  cwd: verificationPlan.cwd,
  plan: contractPlan,
});
verificationPath = await writePrototypeVerificationArtifact(run.runDir, {
  ...verification,
  selectionSource: verificationPlan.selectionSource,
  rationale: verificationPlan.rationale,
  skill: verificationPlan.skill,
  evidence: verificationPlan.evidence,
  failureClassification: verificationFailureClassification,
  contract: buildContractArtifact(contractPlan, contractResult),
});
await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: "verification.contract_completed",
  data: {
    overallStatus: contractResult.overallStatus,
    canComplete: contractResult.canComplete,
    requirementCount: contractPlan.requirements.length,
    results: contractResult.results.map((result) => ({
      requirementId: result.requirementId,
      status: result.status,
      blocking: result.blocking,
      reason: result.reason,
    })),
    createdFrom: contractPlan.createdFrom,
  },
});

// If contract verification surfaced a human decision request, raise the gate.
const pendingDecision = contractResult.results.find((result) => result.decision);
if (pendingDecision?.decision) {
  await requestHumanDecision({
    controllerInput: input,
    runDir: run.runDir,
    statePath: run.statePath,
    eventsPath: run.eventsPath,
    runId: run.runId,
    request: pendingDecision.decision,
  });
}

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
const allFailuresBaseline = verification.overallStatus === "failed"
  && Boolean(verificationFailureClassification)
  && verificationFailureClassification!.perCommand.length > 0
  && verificationFailureClassification!.perCommand.every(
    (c) => c.category === "baseline-unrelated" || c.suggestedAction === "ignore",
  );

if (verification.overallStatus === "failed" && allFailuresBaseline) {
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "verification.baseline_warning",
    data: {
      reason: verificationFailureClassification?.reason,
      perCommand: verificationFailureClassification?.perCommand,
    },
  });
  await emitProgress(input, {
    runId: run.runId,
    phase: "verification",
    status: "RUNNING",
    message: `Verification warnings (baseline-unrelated): ${verificationFailureClassification?.reason ?? "pre-existing repo issues"}`,
  });
  await appendRepoLearning({
    projectRoot,
    category: "verification-baseline-warning",
    summary: verificationFailureClassification?.reason ?? "Baseline-unrelated verification failure",
    data: {
      perCommand: verificationFailureClassification?.perCommand,
    },
  });
} else if (verification.overallStatus === "failed") {
  const failedState = await updateFactoryRunState({
    statePath: run.statePath,
    patch: { status: "FAILED", phase: "verification-failed" },
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "run.failed",
    data: { reason: "verification failed" },
  });
  const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
    runId: run.runId,
    goal: input.goal,
    status: "FAILED",
    phase: failedState.phase,
    approved: false,
    planPath,
    taskPaths,
    plannerExecutionPath,
    builderExecutionPaths,
    integrationPath,
    repairExecutionPaths,

    reviewerExecutionPath,
    verificationPath,
    verificationStatus: verification.overallStatus,
  });

  return buildRunFailureResult({
    run,
    executionCwd,
    worktree,
    phases,
    planPath,
    taskPaths,
    plannerExecutionPath,
    builderExecutionPaths,
    integrationPath,
    repairExecutionPaths,
    reviewerExecutionPath,
    verificationPath,
    summaryPath,
  });
}

// Verified: only after all required checks pass.

  return { verificationPath, repairExecutionPaths, verification, verificationFailureClassification, contractResult };
}
