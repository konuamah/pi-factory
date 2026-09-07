// Discovery phase of the run controller — extracted from controller-run.ts.

import { selectConstitutionContext } from "../constitution/index.js";
import { collectRuntimeSkillSignals, applyWorkflowSkillPolicy, summarizeSkillBundle } from "./skills.js";
import { findBuiltInWorkflowStage } from "./task-utils.js";
import { resolveFactorySkills, initializeFactorySkills } from "../skills/index.js";
import { failBuiltInSkillPolicy } from "./controller-helpers.js";
import { resolveRunTaskTypeWithPaths } from "./verification-planning.js";
import { buildDiscoveryEvidencePacket, validateDiscoveryOutput, shouldRetryDiscoveryJsonRepair, buildDiscoveryJsonRepairPrompt, normalizeDiscoveryFilePath } from "./discovery-validate.js";
import { runInterviewStages } from "./controller-interview.js";
import { buildDiscoveryPrompt } from "./controller-interview.js";
import { renderSkillBundleForPrompt } from "./prompts.js";
import { appendFactoryRunEvent, updateFactoryRunState, createFactoryRun } from "../runs/store.js";
import { appendModelLedgerEntry } from "../runs/model-ledger.js";
import { writePrototypeDiscoveryExecutionArtifact } from "./artifacts.js";
import { emitProgress, movePhase } from "./phase-plumbing.js";
import { resolveModelForRole } from "../models/index.js";
import path from "node:path";
import fs from "node:fs/promises";
import { normalizeDiscoveryFileHints } from "./controller.js";
import type { PlannerArtifact } from "./planner.js";
import { loadEffectiveConfig } from "../config/loader.js";
import type { RunFactoryControllerInput, InterviewDecisionRecord } from "./controller.js";
import type { SkillBundleSelection } from "../skills/index.js";
import type { TaskTypeSelection } from "../models/index.js";
import type { WorkflowStage } from "@factory/schemas";
import type { AgentExecutor } from "./interfaces.js";


export interface DiscoveryPhaseState {
  run: Awaited<ReturnType<typeof createFactoryRun>>;
  input: RunFactoryControllerInput;
  loaded: Awaited<ReturnType<typeof loadEffectiveConfig>>;
  projectRoot: string;
  executionCwd: string;
}

export interface DiscoveryPhaseResult {
  runTaskType: TaskTypeSelection;
  discoveryExecutionPath: string | undefined;
  discoveryOutputText: string | undefined;
  discoveryFileHints: string[];
  plannerExecutionPath: string | undefined;
  plannerOutputText: string | undefined;
  interviewContext: string | undefined;
  interviewExecutionPath: string | undefined;
  interviewDecisions: InterviewDecisionRecord[];
  discoveryGuidance: Awaited<ReturnType<typeof selectConstitutionContext>>;
  plannerGuidance: Awaited<ReturnType<typeof selectConstitutionContext>>;
  builderGuidance: Awaited<ReturnType<typeof selectConstitutionContext>>;
  repairGuidance: Awaited<ReturnType<typeof selectConstitutionContext>>;
  reviewerGuidance: Awaited<ReturnType<typeof selectConstitutionContext>>;
  repoSkillSignals: { constitutionAreas: number[] };
  workflowStages: WorkflowStage[];
  discoverySkills: SkillBundleSelection;
  plannerSkills: SkillBundleSelection;
  builderSkills: SkillBundleSelection;
  repairSkills: SkillBundleSelection;
  reviewerSkills: SkillBundleSelection;
}

export async function runDiscoveryPhase(state: DiscoveryPhaseState): Promise<DiscoveryPhaseResult> {
  const { run, input, loaded, projectRoot, executionCwd } = state;

await movePhase(run.statePath, run.eventsPath, run.runId, input, "discovery", "Discovering relevant system context");

const useConstitution = loaded.effectiveConfig.constitution.enabled;
const discoveryGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "planner", goal: input.goal, useConstitution });
const plannerGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "planner", goal: input.goal, useConstitution });
const builderGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "builder", goal: input.goal, useConstitution });
const repairGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "repair", goal: input.goal, useConstitution });
const reviewerGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "reviewer", goal: input.goal, useConstitution });

await initializeFactorySkills(projectRoot);
const repoSkillSignals = await collectRuntimeSkillSignals(projectRoot);
const workflowStages = loaded.effectiveConfig.resolvedWorkflow?.stages ?? [];
const discoveryStage = findBuiltInWorkflowStage(workflowStages, ["discover", "discovery"]);
const plannerStage = findBuiltInWorkflowStage(workflowStages, ["plan", "planning"]);
const interviewStages = workflowStages.filter((stage) => stage.type === "interview");

let discoverySkills = resolveFactorySkills({
  goal: input.goal,
  stage: "discover",
  taskKinds: ["repo-interpretation", "planning"],
  requiredCapabilities: ["repo-interpretation"],
  availableTools: ["read", "grep", "find", "ls"],
  ...repoSkillSignals,
});
let plannerSkills = resolveFactorySkills({
  goal: input.goal,
  stage: "plan",
  taskKinds: ["planning", "repo-interpretation"],
  requiredCapabilities: ["repo-interpretation", "architecture-planning"],
  availableTools: ["read", "grep", "find", "ls"],
  ...repoSkillSignals,
});

const discoveryPolicy = applyWorkflowSkillPolicy(discoverySkills, discoveryStage?.skills);
if (!discoveryPolicy.ok) {
  await failBuiltInSkillPolicy({
    run,
    input,
    phase: "discovery-failed",
    stage: discoveryStage?.name ?? "discover",
    missingRequired: discoveryPolicy.missingRequired,
  });
  throw new Error(`Discovery failed: Missing required workflow skill(s): ${discoveryPolicy.missingRequired.join(", ")}`);
}
discoverySkills = discoveryPolicy.bundle;

const plannerPolicy = applyWorkflowSkillPolicy(plannerSkills, plannerStage?.skills);
if (!plannerPolicy.ok) {
  await failBuiltInSkillPolicy({
    run,
    input,
    phase: "planning-failed",
    stage: plannerStage?.name ?? "plan",
    missingRequired: plannerPolicy.missingRequired,
  });
  throw new Error(`Planning failed: Missing required workflow skill(s): ${plannerPolicy.missingRequired.join(", ")}`);
}
plannerSkills = plannerPolicy.bundle;
const builderSkills = resolveFactorySkills({
  goal: input.goal,
  stage: "build",
  taskKinds: ["implementation"],
  requiredCapabilities: ["repo-interpretation", "implementation-task"],
  availableTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  ...repoSkillSignals,
});
const repairSkills = resolveFactorySkills({
  goal: input.goal,
  stage: "repair",
  taskKinds: ["repair", "verification"],
  requiredCapabilities: ["failure-triage", "verification-repair"],
  availableTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  ...repoSkillSignals,
});
const reviewerSkills = resolveFactorySkills({
  goal: input.goal,
  stage: "review",
  taskKinds: ["review"],
  requiredCapabilities: ["acceptance-review"],
  availableTools: ["read", "grep", "find", "ls"],
  ...repoSkillSignals,
});

await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: "guidance.context_selected",
  data: {
    plannerInstructionFiles: plannerGuidance.instructionFiles,
    discoveryInstructionFiles: discoveryGuidance.instructionFiles,
    builderInstructionFiles: builderGuidance.instructionFiles,
    repairInstructionFiles: repairGuidance.instructionFiles,
    reviewerInstructionFiles: reviewerGuidance.instructionFiles,
    plannerInstructionDetails: plannerGuidance.instructionDetails,
    discoveryInstructionDetails: discoveryGuidance.instructionDetails,
    builderInstructionDetails: builderGuidance.instructionDetails,
    repairInstructionDetails: repairGuidance.instructionDetails,
    reviewerInstructionDetails: reviewerGuidance.instructionDetails,
    plannerHasConstitution: plannerGuidance.hasConstitution,
    discoveryHasConstitution: discoveryGuidance.hasConstitution,
    builderHasConstitution: builderGuidance.hasConstitution,
    repairHasConstitution: repairGuidance.hasConstitution,
    reviewerHasConstitution: reviewerGuidance.hasConstitution,
    plannerUsedConstitution: plannerGuidance.usedConstitution,
    discoveryUsedConstitution: discoveryGuidance.usedConstitution,
    builderUsedConstitution: builderGuidance.usedConstitution,
    repairUsedConstitution: repairGuidance.usedConstitution,
    reviewerUsedConstitution: reviewerGuidance.usedConstitution,
    plannerGuidanceChars: plannerGuidance.approxChars,
    discoveryGuidanceChars: discoveryGuidance.approxChars,
    builderGuidanceChars: builderGuidance.approxChars,
    repairGuidanceChars: repairGuidance.approxChars,
    reviewerGuidanceChars: reviewerGuidance.approxChars,
  },
});
await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: "skills.selected",
  data: {
    discovery: summarizeSkillBundle(discoverySkills),
    planner: summarizeSkillBundle(plannerSkills),
    builder: summarizeSkillBundle(builderSkills),
    repair: summarizeSkillBundle(repairSkills),
    reviewer: summarizeSkillBundle(reviewerSkills),
  },
});
await emitProgress(input, {
  runId: run.runId,
  phase: "planning",
  status: "RUNNING",
  message: `Guidance selected: planner files=${plannerGuidance.instructionFiles.length}, constitution=${plannerGuidance.usedConstitution ? "used" : "skipped"}, approx chars=${plannerGuidance.approxChars}`,
});

const runTaskType = await resolveRunTaskTypeWithPaths(input, loaded.effectiveConfig, projectRoot);
await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: "task.type_resolved",
  data: {
    taskType: runTaskType.id,
    source: runTaskType.source,
    confidence: runTaskType.confidence,
    reasons: runTaskType.reasons,
  },
});

let discoveryExecutionPath: string | undefined;
let discoveryOutputText: string | undefined;
let discoveryFileHints: string[] = [];
let plannerExecutionPath: string | undefined;
let plannerOutputText: string | undefined;
const discoveryExecutor = input.discoveryExecutor ?? input.plannerExecutor;
if (discoveryExecutor) {
  const discoveryModel = resolveModelForRole({
    role: "discovery",
    taskType: runTaskType.id,
    config: loaded.effectiveConfig,
    runModelOverride: input.modelOverrides?.discovery,
  });
  await appendModelLedgerEntry(run.runDir, {
    operationId: `${run.runId}-discovery`,
    role: "discovery",
    taskType: runTaskType.id,
    taskTypeSource: runTaskType.source,
    taskTypeConfidence: runTaskType.confidence,
    requestedModel: discoveryModel.model.model,
    resolvedModel: discoveryModel.model.model,
    provider: discoveryModel.model.provider,
    modelSource: discoveryModel.source,
  });
  const discoveryEvidence = await buildDiscoveryEvidencePacket(executionCwd, input.goal);
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "discovery.evidence_collected",
    data: {
      observedFileCount: discoveryEvidence.observedFiles.length,
      candidateFileCount: discoveryEvidence.candidateFiles.length,
      snippetCount: discoveryEvidence.snippets.length,
      truncated: discoveryEvidence.truncated,
    },
  });
  let discoveryResult = await discoveryExecutor.execute({
    executionId: `${run.runId}-discovery`,
    cwd: executionCwd,
    prompt: buildDiscoveryPrompt(input.goal, discoveryGuidance.text, renderSkillBundleForPrompt(discoverySkills), discoveryEvidence),
    model: discoveryModel.model,
    tools: ["read", "grep", "find", "ls"],
    limits: loaded.effectiveConfig.runtime.limits,
    metadata: {
      role: "discovery",
      runId: run.runId,
      taskType: runTaskType.id,
    },
  });
  discoveryExecutionPath = await writePrototypeDiscoveryExecutionArtifact(run.runDir, discoveryResult);
  let discoveryValidation = await validateDiscoveryOutput(discoveryResult.outputText, executionCwd, discoveryEvidence);
  if (discoveryResult.status === "completed" && !discoveryValidation.ok && shouldRetryDiscoveryJsonRepair(discoveryValidation.reason, discoveryResult.outputText)) {
    const invalidDiscoveryExecutionPath = path.join(run.runDir, "discovery-execution-invalid.json");
    await fs.writeFile(invalidDiscoveryExecutionPath, JSON.stringify(discoveryResult, null, 2), "utf8");
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "discovery.json_repair_retrying",
      data: {
        discoveryExecutionPath: invalidDiscoveryExecutionPath,
        reason: discoveryValidation.reason,
      },
    });
    discoveryResult = await discoveryExecutor.execute({
      executionId: `${run.runId}-discovery-json-repair`,
      cwd: executionCwd,
      prompt: buildDiscoveryJsonRepairPrompt(discoveryResult.outputText),
      model: discoveryModel.model,
      tools: [],
      limits: loaded.effectiveConfig.runtime.limits,
      metadata: {
        role: "discovery",
        runId: run.runId,
        taskType: runTaskType.id,
        attempt: "json-repair",
      },
    });
    discoveryExecutionPath = await writePrototypeDiscoveryExecutionArtifact(run.runDir, discoveryResult);
    discoveryValidation = await validateDiscoveryOutput(discoveryResult.outputText, executionCwd, discoveryEvidence);
  }
  if (!discoveryValidation.ok) {
    const reason = discoveryResult.status === "completed"
      ? discoveryValidation.reason
      : discoveryResult.errorMessage?.trim() || `Discovery executor ${discoveryResult.status}`;
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "discovery.invalid_output",
      data: {
        discoveryExecutionPath,
        reason,
        discoveryStatus: discoveryResult.status,
        errorMessage: discoveryResult.errorMessage,
      },
    });
    await updateFactoryRunState({
      statePath: run.statePath,
      patch: { status: "FAILED", phase: "discovery-failed" },
    });
    throw new Error(`Discovery failed: ${reason}`);
  }
  discoveryOutputText = JSON.stringify(discoveryValidation.discovery, null, 2);
  // Existing files and to-be-created files both become file hints so the
  // Builder gets the full surface (edit these + create these).
  discoveryFileHints = normalizeDiscoveryFileHints([
    ...(discoveryValidation.discovery.files ?? []),
    ...(discoveryValidation.discovery.newFiles ?? []),
  ]);
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "discovery.executor_completed",
    data: {
      discoveryExecutionPath,
      discoveryStatus: discoveryResult.status,
    },
  });
}

const interviewResult = await runInterviewStages({
  stages: interviewStages,
  run,
  input,
  executionCwd,
  goal: input.goal,
  config: loaded.effectiveConfig,
  plannerGuidanceText: plannerGuidance.text,
  plannerSkills,
  runTaskType,
  discoveryOutputText,
});
const interviewContext = interviewResult.text;
const interviewExecutionPath = interviewResult.executionPath;
const interviewDecisions = interviewResult.decisions ?? [];

let plan: PlannerArtifact;
let planPath: string;
let taskPaths: string[];

  return {
    runTaskType,
    discoveryExecutionPath,
    discoveryOutputText,
    discoveryFileHints,
    plannerExecutionPath,
    plannerOutputText,
    interviewContext,
    interviewExecutionPath,
    interviewDecisions,
    discoveryGuidance,
    plannerGuidance,
    builderGuidance,
    repairGuidance,
    reviewerGuidance,
    repoSkillSignals,
    workflowStages,
    discoverySkills,
    plannerSkills,
    builderSkills,
    repairSkills,
    reviewerSkills,
  };
}
