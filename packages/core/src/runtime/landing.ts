import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { appendModelLedgerEntry } from "../runs/model-ledger.js";
import { appendFactoryRunEvent } from "../runs/store.js";
import { resolveModelForRole } from "../models/index.js";
import { buildRepairPrompt } from "./prompts.js";
import { classifyVerificationFailure } from "./failure-classification.js";
import { runVerificationCommands, type VerificationPlan, type VerificationRunResult } from "./verification.js";
import { writePrototypeCompletedTasksArtifact, writePrototypeLandingPlanArtifact, writePrototypeLandingDiagnosisArtifact, appendPrototypeLandingAttemptArtifact, writePrototypeFinalMergeArtifact, type PrototypeCompletedTaskArtifact, type PrototypeLandingDiagnosisArtifact, type PrototypeLandingPlanArtifact } from "./artifacts.js";
import type { AgentExecutor } from "./interfaces.js";
import type { EffectiveFactoryConfig, ModelSelection } from "@factory/schemas";
import type { TaskWorkspaceSelection, RunFactoryControllerInput } from "./controller.js";

const execFileAsync = promisify(execFile);

export interface LandingPlan {
  strategy: "cherry-pick" | "merge" | "merge-no-ff" | "rebase" | "skip" | "block";
  targetBranch: string;
  candidateSha?: string;
  sourceBranch?: string;
  reasoning: string[];
  verification: string[];
  risk: "low" | "medium" | "high";
  expectedFiles: string[];
  recoveryPlan?: string;
}

interface LandingGuardVerdict {
  ok: boolean;
  reasons: string[];
}

export interface LandingResult {
  finalMergePath: string;
  status: "COMPLETED" | "BLOCKED";
  phase: "complete" | "merge-blocked";
  approved: boolean;
  landingStatus: "landed" | "skipped" | "blocked" | "failed";
  landingAttempts: number;
  recoveryHint?: string;
}

export function buildCompletedTasks(
  workspaces: TaskWorkspaceSelection[],
  targetBranch: string,
): PrototypeCompletedTaskArtifact[] {
  return workspaces
    .filter((workspace) => workspace.commitSha && (workspace.changedFiles?.length ?? 0) > 0)
    .map((workspace) => ({
      taskId: workspace.taskId,
      targetBranch,
      sourceBranch: workspace.branch,
      commitSha: workspace.commitSha!,
      changedFiles: workspace.changedFiles ?? [],
      workspaceMode: workspace.mode,
      worktreePath: workspace.mode === "in-place" ? undefined : workspace.path,
    }));
}

export async function runLandingFlow(input: {
  runDir: string;
  runId: string;
  eventsPath: string;
  goal: string;
  mergeCwd: string;
  taskType: string;
  config: EffectiveFactoryConfig;
  completedTasks: PrototypeCompletedTaskArtifact[];
  candidateSha?: string;
  candidateBranch?: string;
  verificationPlan: VerificationPlan;
  verification: VerificationRunResult;
  controllerInput: RunFactoryControllerInput;
  repairGuidanceText?: string;
}): Promise<LandingResult> {
  await writePrototypeCompletedTasksArtifact(input.runDir, input.completedTasks);
  const dirtyFiles = await readDirtyFiles(input.mergeCwd);
  const modelSelection = resolveLandingModel(input.config, input.taskType);
  await appendModelLedgerEntry(input.runDir, {
    operationId: `${input.runId}-landing`,
    nodeId: "landing",
    role: "landing",
    taskType: input.taskType,
    taskTypeSource: "run",
    requestedModel: modelSelection.model.model,
    resolvedModel: modelSelection.model.model,
    provider: modelSelection.model.provider,
    modelSource: modelSelection.source,
  });

  const executor = input.controllerInput.landingExecutor ?? input.controllerInput.reviewerExecutor;
  const plan = await buildLandingPlan({
    executor,
    model: modelSelection.model,
    goal: input.goal,
    mergeCwd: input.mergeCwd,
    baseBranch: input.config.git.baseBranch,
    finalMergePolicy: input.config.approval.finalMerge,
    dirtyFiles,
    completedTasks: input.completedTasks,
    candidateSha: input.candidateSha,
    candidateBranch: input.candidateBranch,
    verification: input.verification,
  });
  const guardVerdict = await validateLandingPlan({
    mergeCwd: input.mergeCwd,
    plan,
    dirtyFiles,
    finalMergePolicy: input.config.approval.finalMerge,
  });
  const landingPlanArtifact: PrototypeLandingPlanArtifact = {
    ...plan,
    guardVerdict,
  };
  await writePrototypeLandingPlanArtifact(input.runDir, landingPlanArtifact);
  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "landing.plan_selected",
    data: landingPlanArtifact as unknown as Record<string, unknown>,
  });

  if (!guardVerdict.ok) {
    const diagnosis = await diagnoseLandingFailure({
      executor,
      model: modelSelection.model,
      plan,
      reason: guardVerdict.reasons.join("; "),
      dirtyFiles,
      verification: input.verification,
    });
    await writePrototypeLandingDiagnosisArtifact(input.runDir, 1, diagnosis);
    await appendPrototypeLandingAttemptArtifact(input.runDir, {
      attempt: 1,
      plan: landingPlanArtifact,
      execution: { status: "blocked", outcome: diagnosis.kind, reason: diagnosis.recoveryHint },
      diagnosis,
    });
    return {
      finalMergePath: await writePrototypeFinalMergeArtifact(input.runDir, {
        mergeBaseBranch: input.config.git.baseBranch,
        candidateBranch: input.candidateBranch,
        candidateSha: input.candidateSha,
        mergeCwd: input.mergeCwd,
        targetBranch: plan.targetBranch,
        sourceBranch: plan.sourceBranch,
        strategy: plan.strategy,
        status: "blocked",
        outcome: mapDiagnosisToOutcome(diagnosis.kind),
        recoveryHint: diagnosis.recoveryHint,
        reason: guardVerdict.reasons.join("; "),
      }),
      status: "BLOCKED",
      phase: "merge-blocked",
      approved: false,
      landingStatus: "blocked",
      landingAttempts: 1,
      recoveryHint: diagnosis.recoveryHint,
    };
  }

  const execution = await executeLandingStrategy({
    cwd: input.mergeCwd,
    plan,
    baseBranch: input.config.git.baseBranch,
  });
  let diagnosis: PrototypeLandingDiagnosisArtifact | undefined;
  let landingStatus: LandingResult["landingStatus"] = execution.status;
  let finalStatus: LandingResult["status"] = execution.status === "landed" || execution.status === "skipped" ? "COMPLETED" : "BLOCKED";
  let finalPhase: LandingResult["phase"] = finalStatus === "COMPLETED" ? "complete" : "merge-blocked";
  let recoveryHint = execution.reason;

  let verificationResult = input.verification;
  let verificationCommands = Object.keys(input.verificationPlan.commands);
  if (execution.status === "landed") {
    verificationCommands = resolveVerificationCommands(plan, input.verificationPlan);
    verificationResult = await runVerificationCommands({
      cwd: input.verificationPlan.cwd,
      commands: pickVerificationCommands(input.verificationPlan.commands, verificationCommands),
    });
    if (verificationResult.overallStatus === "failed" && input.controllerInput.repairExecutor) {
      const repaired = await attemptLandingRepair({
        controllerInput: input.controllerInput,
        cwd: input.verificationPlan.cwd,
        goal: input.goal,
        verificationResult,
        repairGuidanceText: input.repairGuidanceText,
        model: input.config.models.repair,
      });
      if (repaired) {
        verificationResult = await runVerificationCommands({
          cwd: input.verificationPlan.cwd,
          commands: pickVerificationCommands(input.verificationPlan.commands, verificationCommands),
        });
      }
    }
    if (verificationResult.overallStatus !== "passed") {
      diagnosis = await diagnoseLandingFailure({
        executor,
        model: modelSelection.model,
        plan,
        reason: `Post-landing verification ${verificationResult.overallStatus}`,
        dirtyFiles: [],
        verification: verificationResult,
      });
      landingStatus = "blocked";
      finalStatus = "BLOCKED";
      finalPhase = "merge-blocked";
      recoveryHint = diagnosis.recoveryHint;
    }
  } else if (execution.status !== "skipped") {
    diagnosis = await diagnoseLandingFailure({
      executor,
      model: modelSelection.model,
      plan,
      reason: execution.reason ?? execution.outcome,
      dirtyFiles,
      verification: input.verification,
    });
    recoveryHint = diagnosis.recoveryHint;
  }

  if (diagnosis) {
    await writePrototypeLandingDiagnosisArtifact(input.runDir, 1, diagnosis);
  }
  await appendPrototypeLandingAttemptArtifact(input.runDir, {
    attempt: 1,
    plan: landingPlanArtifact,
    execution: {
      status: landingStatus,
      outcome: diagnosis?.kind ?? execution.outcome,
      reason: recoveryHint,
    },
    verification: {
      overallStatus: verificationResult.overallStatus,
      commands: verificationCommands,
    },
    diagnosis,
  });

  const outcome = landingStatus === "landed"
    ? "landed"
    : landingStatus === "skipped"
      ? "policy-skipped"
      : mapDiagnosisToOutcome(diagnosis?.kind ?? "unknown");
  return {
    finalMergePath: await writePrototypeFinalMergeArtifact(input.runDir, {
      mergeBaseBranch: input.config.git.baseBranch,
      candidateBranch: input.candidateBranch,
      candidateSha: input.candidateSha,
      mergeCwd: input.mergeCwd,
      targetBranch: plan.targetBranch,
      sourceBranch: plan.sourceBranch,
      strategy: plan.strategy,
      status: landingStatus,
      outcome,
      recoveryHint,
      reason: execution.reason,
    }),
    status: finalStatus,
    phase: finalPhase,
    approved: finalStatus === "COMPLETED",
    landingStatus,
    landingAttempts: 1,
    recoveryHint,
  };
}

function resolveLandingModel(config: EffectiveFactoryConfig, taskType: string): { model: ModelSelection; source: string } {
  try {
    const resolved = resolveModelForRole({
      role: "landing",
      taskType,
      config,
    });
    return resolved;
  } catch {
    const fallback = config.models.reviewer;
    if (!fallback?.model) {
      throw new Error(`No model configured for landing or reviewer under task type '${taskType}'.`);
    }
    return { model: fallback, source: "reviewer-fallback" };
  }
}

async function buildLandingPlan(input: {
  executor?: AgentExecutor;
  model: ModelSelection;
  goal: string;
  mergeCwd: string;
  baseBranch: string;
  finalMergePolicy: "required" | "not-required";
  dirtyFiles: string[];
  completedTasks: PrototypeCompletedTaskArtifact[];
  candidateSha?: string;
  candidateBranch?: string;
  verification: VerificationRunResult;
}): Promise<LandingPlan> {
  if (!input.executor) {
    throw new Error("Landing planning requires a landing or reviewer executor.");
  }
  const result = await input.executor.execute({
    executionId: `landing-plan-${Date.now()}`,
    cwd: input.mergeCwd,
    prompt: [
      "You are the Factory landing planner.",
      "Return STRICT JSON only. No markdown.",
      "Choose what Factory should do to land the candidate safely.",
      'Allowed strategy: "cherry-pick" | "merge" | "merge-no-ff" | "rebase" | "skip" | "block".',
      'Allowed risk: "low" | "medium" | "high".',
      JSON.stringify({
        strategy: "cherry-pick",
        targetBranch: input.baseBranch,
        candidateSha: input.candidateSha,
        sourceBranch: input.candidateBranch,
        reasoning: ["short reason"],
        verification: ["test"],
        risk: "low",
        expectedFiles: ["src/file.ts"],
        recoveryPlan: "optional",
      }, null, 2),
      "Evidence:",
      JSON.stringify({
        goal: input.goal,
        baseBranch: input.baseBranch,
        finalMergePolicy: input.finalMergePolicy,
        dirtyFiles: input.dirtyFiles,
        candidateSha: input.candidateSha,
        candidateBranch: input.candidateBranch,
        completedTasks: input.completedTasks,
        verificationStatus: input.verification.overallStatus,
        verificationCommands: input.verification.commands.map((command) => ({ name: command.name, status: command.status })),
      }, null, 2),
    ].join("\n"),
    model: input.model,
    tools: ["read", "grep", "find", "ls"],
    metadata: { role: "landing", stage: "landing-planning" },
  });
  const parsed = parseJsonObject(result.outputText);
  if (!parsed) {
    throw new Error("Landing planner returned invalid JSON.");
  }
  return sanitizeLandingPlan(parsed, input);
}

async function validateLandingPlan(input: {
  mergeCwd: string;
  plan: LandingPlan;
  dirtyFiles: string[];
  finalMergePolicy: "required" | "not-required";
}): Promise<LandingGuardVerdict> {
  const reasons: string[] = [];
  if (input.dirtyFiles.length > 0) {
    reasons.push(`Dirty target checkout: ${input.dirtyFiles.join(", ")}`);
  }
  if (input.finalMergePolicy === "required" && input.plan.strategy === "skip") {
    reasons.push("Landing plan cannot skip while final merge policy is required.");
  }
  if (input.plan.risk === "high" && input.plan.strategy !== "block") {
    reasons.push("High-risk landing plans must block instead of executing automatically.");
  }
  if (["cherry-pick", "rebase"].includes(input.plan.strategy) && !input.plan.candidateSha) {
    reasons.push(`Strategy ${input.plan.strategy} requires a candidate SHA.`);
  }
  if (["merge", "merge-no-ff"].includes(input.plan.strategy) && !input.plan.sourceBranch) {
    reasons.push(`Strategy ${input.plan.strategy} requires a source branch.`);
  }
  if (!await gitRefExists(input.mergeCwd, input.plan.targetBranch)) {
    reasons.push(`Target branch does not exist: ${input.plan.targetBranch}`);
  }
  if (input.plan.candidateSha && !await gitCommitExists(input.mergeCwd, input.plan.candidateSha)) {
    reasons.push(`Candidate commit does not exist: ${input.plan.candidateSha}`);
  }
  if (input.plan.sourceBranch && !await gitRefExists(input.mergeCwd, input.plan.sourceBranch)) {
    reasons.push(`Source branch does not exist: ${input.plan.sourceBranch}`);
  }
  return { ok: reasons.length === 0, reasons };
}

async function executeLandingStrategy(input: {
  cwd: string;
  plan: LandingPlan;
  baseBranch: string;
}): Promise<{ status: "landed" | "blocked" | "failed" | "skipped"; outcome: string; reason?: string }> {
  if (input.plan.strategy === "block") {
    return { status: "blocked", outcome: "unsafe-plan", reason: input.plan.reasoning.join("; ") };
  }
  if (input.plan.strategy === "skip") {
    return { status: "skipped", outcome: "policy-skipped", reason: input.plan.reasoning.join("; ") };
  }
  try {
    await execFileAsync("git", ["checkout", input.plan.targetBranch], { cwd: input.cwd, windowsHide: true });
    if (input.plan.strategy === "cherry-pick") {
      await execFileAsync("git", ["cherry-pick", input.plan.candidateSha!], { cwd: input.cwd, windowsHide: true });
    } else if (input.plan.strategy === "merge-no-ff") {
      await execFileAsync("git", ["merge", "--no-ff", "--no-edit", input.plan.sourceBranch!], { cwd: input.cwd, windowsHide: true });
    } else if (input.plan.strategy === "merge") {
      await execFileAsync("git", ["merge", "--ff", input.plan.sourceBranch!], { cwd: input.cwd, windowsHide: true });
    } else if (input.plan.strategy === "rebase") {
      await execFileAsync("git", ["rebase", input.plan.candidateSha!], { cwd: input.cwd, windowsHide: true });
    }
    return { status: "landed", outcome: "landed" };
  } catch (error) {
    await abortGitOperation(input.cwd, input.plan.strategy);
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "blocked", outcome: classifyLandingOperationFailure(input.plan.strategy, reason), reason };
  }
}

async function attemptLandingRepair(input: {
  controllerInput: RunFactoryControllerInput;
  cwd: string;
  goal: string;
  verificationResult: VerificationRunResult;
  repairGuidanceText?: string;
  model?: ModelSelection;
}): Promise<boolean> {
  const repairExecutor = input.controllerInput.repairExecutor;
  if (!repairExecutor) {
    return false;
  }
  const result = await repairExecutor.execute({
    executionId: `landing-repair-${Date.now()}`,
    cwd: input.cwd,
    prompt: buildRepairPrompt(
      input.goal,
      input.verificationResult,
      input.repairGuidanceText,
      undefined,
      classifyVerificationFailure({
        plan: { cwd: input.cwd, commands: {}, cwdResolution: "default-root" },
        result: input.verificationResult,
      })?.reason,
    ),
    model: input.model,
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    metadata: { role: "repair", stage: "landing-repair" },
  });
  return result.status === "completed";
}

async function diagnoseLandingFailure(input: {
  executor?: AgentExecutor;
  model: ModelSelection;
  plan: LandingPlan;
  reason: string;
  dirtyFiles: string[];
  verification: VerificationRunResult;
}): Promise<PrototypeLandingDiagnosisArtifact> {
  if (!input.executor) {
    return fallbackDiagnosis(input.reason, input.dirtyFiles, input.verification.overallStatus);
  }
  try {
    const result = await input.executor.execute({
      executionId: `landing-diagnosis-${Date.now()}`,
      cwd: ".",
      prompt: [
        "You diagnose Factory landing failures.",
        "Return STRICT JSON only. No markdown.",
        JSON.stringify({
          kind: "unknown",
          reasoning: ["short reason"],
          retryable: false,
          recoveryAction: "block",
          risk: "medium",
          recoveryHint: "what to do next",
        }, null, 2),
        "Evidence:",
        JSON.stringify({
          plan: input.plan,
          reason: input.reason,
          dirtyFiles: input.dirtyFiles,
          verificationStatus: input.verification.overallStatus,
          verificationCommands: input.verification.commands.map((command) => ({ name: command.name, status: command.status })),
        }, null, 2),
      ].join("\n"),
      model: input.model,
      tools: ["read", "grep", "find", "ls"],
      metadata: { role: "landing", stage: "landing-diagnosis" },
    });
    const parsed = parseJsonObject(result.outputText);
    if (!parsed) {
      return fallbackDiagnosis(input.reason, input.dirtyFiles, input.verification.overallStatus);
    }
    return sanitizeLandingDiagnosis(parsed, input.reason, input.dirtyFiles, input.verification.overallStatus);
  } catch {
    return fallbackDiagnosis(input.reason, input.dirtyFiles, input.verification.overallStatus);
  }
}

function fallbackDiagnosis(reason: string, dirtyFiles: string[], verificationStatus: string): PrototypeLandingDiagnosisArtifact {
  if (dirtyFiles.length > 0) {
    return {
      kind: "dirty-target",
      reasoning: ["Target checkout has uncommitted changes."],
      retryable: true,
      recoveryAction: "block",
      risk: "medium",
      recoveryHint: `Clean or stash these files, then retry landing: ${dirtyFiles.join(", ")}`,
    };
  }
  if (verificationStatus === "failed") {
    return {
      kind: "verification-failed",
      reasoning: ["Post-landing verification failed."],
      retryable: true,
      recoveryAction: "repair-code",
      risk: "medium",
      recoveryHint: "Repair the landed code and rerun verification.",
    };
  }
  return {
    kind: reason.includes("conflict") ? "merge-conflict" : "unknown",
    reasoning: [reason],
    retryable: reason.includes("conflict"),
    recoveryAction: reason.includes("conflict") ? "resolve-conflict" : "block",
    risk: reason.includes("conflict") ? "medium" : "high",
    recoveryHint: reason,
  };
}

function sanitizeLandingPlan(parsed: Record<string, unknown>, input: { baseBranch: string; candidateSha?: string; candidateBranch?: string; completedTasks: PrototypeCompletedTaskArtifact[] }): LandingPlan {
  const allowedStrategies = new Set(["cherry-pick", "merge", "merge-no-ff", "rebase", "skip", "block"]);
  const allowedRisks = new Set(["low", "medium", "high"]);
  const strategy = typeof parsed.strategy === "string" && allowedStrategies.has(parsed.strategy) ? parsed.strategy as LandingPlan["strategy"] : "block";
  const risk = typeof parsed.risk === "string" && allowedRisks.has(parsed.risk) ? parsed.risk as LandingPlan["risk"] : "high";
  return {
    strategy,
    targetBranch: typeof parsed.targetBranch === "string" && parsed.targetBranch.trim() ? parsed.targetBranch : input.baseBranch,
    candidateSha: typeof parsed.candidateSha === "string" ? parsed.candidateSha : input.candidateSha ?? input.completedTasks[0]?.commitSha,
    sourceBranch: typeof parsed.sourceBranch === "string" ? parsed.sourceBranch : input.candidateBranch ?? input.completedTasks[0]?.sourceBranch,
    reasoning: coerceStringArray(parsed.reasoning, ["Landing planner returned no reasoning."]),
    verification: coerceStringArray(parsed.verification, []),
    risk,
    expectedFiles: coerceStringArray(parsed.expectedFiles, input.completedTasks.flatMap((task) => task.changedFiles)),
    recoveryPlan: typeof parsed.recoveryPlan === "string" ? parsed.recoveryPlan : undefined,
  };
}

function sanitizeLandingDiagnosis(parsed: Record<string, unknown>, reason: string, dirtyFiles: string[], verificationStatus: string): PrototypeLandingDiagnosisArtifact {
  const allowedKinds = new Set(["dirty-target", "merge-conflict", "cherry-pick-conflict", "rebase-conflict", "missing-candidate", "candidate-empty", "transient-only-change", "verification-failed", "verification-missing", "baseline-debt", "environment-failure", "unsafe-risk", "auth-required", "timeout", "unknown"]);
  const allowedActions = new Set(["repair-code", "resolve-conflict", "refresh-target", "rerun-verification", "replan-landing", "prepare-environment", "ask-approval", "block"]);
  const allowedRisks = new Set(["low", "medium", "high"]);
  return {
    kind: typeof parsed.kind === "string" && allowedKinds.has(parsed.kind) ? parsed.kind as PrototypeLandingDiagnosisArtifact["kind"] : fallbackDiagnosis(reason, dirtyFiles, verificationStatus).kind,
    reasoning: coerceStringArray(parsed.reasoning, [reason]),
    retryable: typeof parsed.retryable === "boolean" ? parsed.retryable : false,
    recoveryAction: typeof parsed.recoveryAction === "string" && allowedActions.has(parsed.recoveryAction) ? parsed.recoveryAction as PrototypeLandingDiagnosisArtifact["recoveryAction"] : "block",
    risk: typeof parsed.risk === "string" && allowedRisks.has(parsed.risk) ? parsed.risk as PrototypeLandingDiagnosisArtifact["risk"] : "medium",
    recoveryHint: typeof parsed.recoveryHint === "string" && parsed.recoveryHint.trim() ? parsed.recoveryHint : reason,
  };
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = (fenced ?? value).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function coerceStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const result = value.filter((item): item is string => typeof item === "string" && item.trim()).slice(0, 20);
  return result.length > 0 ? result : fallback;
}

function pickVerificationCommands(allCommands: VerificationPlan["commands"], names: string[]): VerificationPlan["commands"] {
  const picked = Object.fromEntries(
    Object.entries(allCommands).filter(([name]) => names.includes(name)),
  );
  return Object.keys(picked).length > 0 ? picked : allCommands;
}

function resolveVerificationCommands(plan: LandingPlan, verificationPlan: VerificationPlan): string[] {
  const available = new Set(Object.keys(verificationPlan.commands));
  const selected = plan.verification.filter((name) => available.has(name));
  return selected.length > 0 ? selected : Object.keys(verificationPlan.commands);
}

function classifyLandingOperationFailure(strategy: LandingPlan["strategy"], reason: string): string {
  if (/conflict/i.test(reason)) {
    return strategy === "cherry-pick" ? "cherry-pick-conflict" : strategy === "rebase" ? "rebase-conflict" : "merge-conflict";
  }
  if (/could not apply|bad revision|unknown revision|not a valid object/i.test(reason)) {
    return "missing-candidate";
  }
  return "unknown";
}

function mapDiagnosisToOutcome(kind: PrototypeLandingDiagnosisArtifact["kind"]): NonNullable<PrototypeLandingPlanArtifact["strategy"]> extends never ? never : "dirty-checkout" | "conflict" | "verification-failed" | "missing-candidate" | "unsafe-plan" | "unknown" {
  switch (kind) {
    case "dirty-target": return "dirty-checkout";
    case "merge-conflict":
    case "cherry-pick-conflict":
    case "rebase-conflict": return "conflict";
    case "verification-failed":
    case "verification-missing":
    case "baseline-debt":
    case "environment-failure": return "verification-failed";
    case "missing-candidate":
    case "candidate-empty":
    case "transient-only-change": return "missing-candidate";
    case "unsafe-risk":
    case "auth-required": return "unsafe-plan";
    default: return "unknown";
  }
}

async function readDirtyFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd, windowsHide: true });
    return stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function gitRefExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", ref], { cwd, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function gitCommitExists(cwd: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function abortGitOperation(cwd: string, strategy: LandingPlan["strategy"]): Promise<void> {
  const commands = strategy === "cherry-pick"
    ? [["cherry-pick", "--abort"]]
    : strategy === "rebase"
      ? [["rebase", "--abort"]]
      : [["merge", "--abort"]];
  for (const command of commands) {
    try {
      await execFileAsync("git", command, { cwd, windowsHide: true });
    } catch {
      // best effort
    }
  }
}
