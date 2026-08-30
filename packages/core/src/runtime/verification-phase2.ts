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
import { runVerificationRepairSection } from "./verification-repair-section.js";
import { handleVerificationOutcome } from "./verification-outcome.js";

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
    if (requirement.type !== "COMMAND") return true;
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
  let reviewerExecutionPath: string | undefined;
  const repairSection = await runVerificationRepairSection({
    run,
    input,
    loaded,
    executionCwd,
    repairGuidanceText: repairGuidance.text ?? "",
    repairSkills,
    verificationPlan,
    contractPlan,
    implementationChangedFiles,
    verification,
    verificationFailureClassification,
    verificationPath,
    contractResult,
    repairExecutionPaths,
  });
  verification = repairSection.verification;
  verificationFailureClassification = repairSection.verificationFailureClassification;
  verificationPath = repairSection.verificationPath;
  contractResult = repairSection.contractResult;
  repairExecutionPaths = repairSection.repairExecutionPaths;
  const verificationOutcome = await handleVerificationOutcome({
    run,
    input,
    projectRoot,
    executionCwd,
    worktree,
    phases,
    delayMs,
    planPath,
    taskPaths,
    discoveryExecutionPath,
    plannerExecutionPath,
    builderExecutionPaths,
    integrationPath,
    repairExecutionPaths,
    verificationPath,
    verification,
    verificationFailureClassification,
  });
  if (verificationOutcome) return verificationOutcome;
  return { verificationPath, repairExecutionPaths, verification, verificationFailureClassification, contractResult };
}
