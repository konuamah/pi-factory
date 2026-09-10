import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readLatestFactoryRunStatus } from "./status.js";
import { findPendingDecision } from "../decisions/index.js";
import { readRecoveryCheckpoint, recoveryCheckpointPath } from "../runtime/recovery-checkpoint.js";
import { appendFactoryRunEvent, updateFactoryRunState } from "./store.js";

const execFileAsync = promisify(execFile);

export interface PendingRecoveryDecisionSummary {
  requestId: string;
  title: string;
  phase: string;
  question: string;
  options: string[];
  checkpointPath?: string;
}

export interface ResumeFactoryRunResult {
  resumed: boolean;
  reason: string;
  runDir?: string;
  statePath?: string;
  eventsPath?: string;
  recovery?: {
    resumable: boolean;
    suggestedPhase: string;
    nextStatus: "PENDING" | "RUNNING";
    executionCwd?: string;
    candidateSha?: string;
    finalMergePath?: string;
    policyReason?: string;
    checks: Array<{
      name: string;
      ok: boolean;
      detail: string;
    }>;
    pendingDecision?: PendingRecoveryDecisionSummary;
  };
  state?: {
    runId?: string;
    status?: string;
    phase?: string;
    createdAt?: string;
    updatedAt?: string;
  };
}

export async function resumeLatestFactoryRun(runsDir: string): Promise<ResumeFactoryRunResult> {
  const latest = await readLatestFactoryRunStatus(runsDir);
  if (!latest.runDir || !latest.statePath || !latest.state) {
    return {
      resumed: false,
      reason: "No run state found",
    };
  }

  const eventsPath = path.join(latest.runDir, "events.jsonl");
  const currentStatus = latest.state.status ?? "UNKNOWN";
  const currentPhase = latest.state.phase ?? "unknown";
  const recovery = await inspectRecoveryState(latest.runDir, runsDir, currentPhase);

  if (currentPhase === "decision-runtime" && recovery.pendingDecision) {
    return {
      resumed: false,
      reason: recovery.resumable
        ? "Latest run is awaiting a runtime recovery decision"
        : "Pending runtime recovery is missing its checkpoint artifact",
      runDir: latest.runDir,
      statePath: latest.statePath,
      eventsPath,
      state: latest.state,
      recovery,
    };
  }

  if (currentStatus === "COMPLETED") {
    return {
      resumed: false,
      reason: "Latest run is already completed",
      runDir: latest.runDir,
      statePath: latest.statePath,
      eventsPath,
      state: latest.state,
      recovery,
    };
  }

  if (!recovery.resumable) {
    return {
      resumed: false,
      reason:
        currentPhase === "plan-approval-rejected"
          ? "Latest run was rejected during plan approval; start a new run to continue"
          : "Latest run is not resumable from its current phase",
      runDir: latest.runDir,
      statePath: latest.statePath,
      eventsPath,
      state: latest.state,
      recovery,
    };
  }

  if (currentStatus === "RUNNING" || currentStatus === "PENDING") {
    const next = await updateFactoryRunState({
      statePath: latest.statePath,
      patch: {
        status: recovery.nextStatus,
        phase: recovery.suggestedPhase,
      },
    });

    await appendFactoryRunEvent(eventsPath, {
      timestamp: new Date().toISOString(),
      type: "run.resumed",
      data: {
        previousStatus: currentStatus,
        previousPhase: currentPhase,
        suggestedPhase: recovery.suggestedPhase,
        nextStatus: recovery.nextStatus,
        policyReason: recovery.policyReason,
        checks: recovery.checks,
      },
    });

    return {
      resumed: true,
      reason:
        recovery.nextStatus === "PENDING"
          ? "Latest run remains paused pending plan action"
          : "Latest in-progress run marked resumed",
      runDir: latest.runDir,
      statePath: latest.statePath,
      eventsPath,
      state: next,
      recovery,
    };
  }

  if (currentStatus === "ABORTED") {
    const next = await updateFactoryRunState({
      statePath: latest.statePath,
      patch: {
        status: recovery.nextStatus,
        phase: recovery.suggestedPhase,
      },
    });
    await appendFactoryRunEvent(eventsPath, {
      timestamp: new Date().toISOString(),
      type: "run.resume_requested",
      data: {
        previousStatus: currentStatus,
        previousPhase: currentPhase,
        suggestedPhase: recovery.suggestedPhase,
        nextStatus: recovery.nextStatus,
        policyReason: recovery.policyReason,
        checks: recovery.checks,
      },
    });
    return {
      resumed: true,
      reason: "Latest aborted run re-opened for continuation",
      runDir: latest.runDir,
      statePath: latest.statePath,
      eventsPath,
      state: next,
      recovery,
    };
  }

  if (currentStatus === "CANCELLED" || currentStatus === "FAILED") {
    const next = await updateFactoryRunState({
      statePath: latest.statePath,
      patch: {
        status: recovery.nextStatus,
        phase: recovery.suggestedPhase,
      },
    });

    await appendFactoryRunEvent(eventsPath, {
      timestamp: new Date().toISOString(),
      type: "run.resume_requested",
      data: {
        previousStatus: currentStatus,
        previousPhase: currentPhase,
        suggestedPhase: recovery.suggestedPhase,
        nextStatus: recovery.nextStatus,
        policyReason: recovery.policyReason,
        checks: recovery.checks,
      },
    });

    return {
      resumed: true,
      reason:
        recovery.nextStatus === "PENDING"
          ? "Latest run re-opened but remains paused pending plan action"
          : "Latest interrupted run re-opened",
      runDir: latest.runDir,
      statePath: latest.statePath,
      eventsPath,
      state: next,
      recovery,
    };
  }

  const fallbackState = await readState(latest.statePath);
  return {
    resumed: false,
    reason: `Unhandled run status: ${currentStatus}`,
    runDir: latest.runDir,
    statePath: latest.statePath,
    eventsPath,
    state: fallbackState,
    recovery,
  };
}

async function inspectRecoveryState(
  runDir: string,
  runsDir: string,
  currentPhase: string,
): Promise<NonNullable<ResumeFactoryRunResult["recovery"]>> {
  const projectRoot = path.dirname(path.dirname(runsDir));
  const summary = await readJson<Record<string, unknown>>(path.join(runDir, "summary.json"));
  const integration = await readJson<Record<string, unknown>>(path.join(runDir, "integration.json"));
  const finalMergePath = path.join(runDir, "final-merge.json");
  const finalMerge = await readJson<Record<string, unknown>>(finalMergePath);
  const verification = await readJson<Record<string, unknown>>(path.join(runDir, "verification.json"));
  const taskArtifacts = await readTaskArtifacts(path.join(runDir, "tasks"));
  const executionCwd = typeof integration?.executionCwd === "string" ? integration.executionCwd : undefined;
  const candidateSha = typeof summary?.candidateSha === "string" ? summary.candidateSha : undefined;

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  checks.push({
    name: "project-root",
    ok: await exists(projectRoot),
    detail: projectRoot,
  });
  checks.push({
    name: "execution-cwd",
    ok: executionCwd ? await exists(executionCwd) : false,
    detail: executionCwd ?? "missing",
  });
  checks.push({
    name: "candidate-sha",
    ok: candidateSha ? await gitObjectExists(executionCwd ?? projectRoot, candidateSha) : false,
    detail: candidateSha ?? "missing",
  });
  checks.push({
    name: "final-merge-artifact",
    ok: await exists(finalMergePath),
    detail: finalMergePath,
  });

  for (const task of taskArtifacts) {
    const taskId = String(task.id ?? "unknown");
    const workspacePath = typeof task.workspacePath === "string" ? task.workspacePath : undefined;
    const workspaceBranch = typeof task.workspaceBranch === "string" ? task.workspaceBranch : undefined;
    checks.push({
      name: `task-${taskId}-workspace`,
      ok: workspacePath ? await exists(workspacePath) : false,
      detail: workspacePath ?? "missing",
    });
    if (workspaceBranch) {
      checks.push({
        name: `task-${taskId}-branch`,
        ok: await gitBranchExists(projectRoot, workspaceBranch),
        detail: workspaceBranch,
      });
    }
  }

  const pendingDecision = await readPendingRecoveryDecision(runDir, currentPhase);
  const checkpoint = pendingDecision ? await readRecoveryCheckpoint(runDir) : undefined;
  const resumePolicy = pendingDecision && !checkpoint
    ? { resumable: false, suggestedPhase: currentPhase, nextStatus: "PENDING" as const, reason: "Pending runtime recovery is missing its checkpoint artifact." }
    : suggestResumePolicy(currentPhase, finalMerge, verification);

  return {
    resumable: resumePolicy.resumable,
    suggestedPhase: resumePolicy.suggestedPhase,
    nextStatus: resumePolicy.nextStatus,
    executionCwd,
    candidateSha,
    finalMergePath: await exists(finalMergePath) ? finalMergePath : undefined,
    policyReason: resumePolicy.reason,
    checks,
    pendingDecision,
  };
}

async function readPendingRecoveryDecision(runDir: string, currentPhase: string): Promise<PendingRecoveryDecisionSummary | undefined> {
  if (currentPhase !== "decision-runtime") return undefined;
  const pending = await findPendingDecision(runDir);
  if (!pending || pending.source !== "RUNTIME" || pending.reason !== "FAILURE_RECOVERY") return undefined;
  return {
    requestId: pending.id,
    title: pending.title,
    phase: currentPhase,
    question: pending.question,
    options: pending.options.map((option) => option.id),
    checkpointPath: recoveryCheckpointPath(runDir),
  };
}

function suggestResumePolicy(
  currentPhase: string,
  finalMerge: Record<string, unknown> | undefined,
  verification: Record<string, unknown> | undefined,
): { resumable: boolean; suggestedPhase: string; nextStatus: "PENDING" | "RUNNING"; reason: string } {
  if (currentPhase === "implementation-blocked") {
    return { resumable: false, suggestedPhase: "implementation-blocked", nextStatus: "PENDING", reason: "The implementation contract produced no candidate. Revise the goal or plan and start a new run." };
  }
  if (currentPhase === "dependency-hydration-blocked") {
    return { resumable: true, suggestedPhase: "verification-planning", nextStatus: "RUNNING", reason: "Resume after dependencies are installed or setup is revised." };
  }
  if (currentPhase === "plan-approval") {
    return { resumable: true, suggestedPhase: "plan-approval", nextStatus: "PENDING", reason: "Plan approval was interrupted." };
  }
  if (currentPhase.startsWith("decision-")) {
    return { resumable: true, suggestedPhase: currentPhase, nextStatus: "PENDING", reason: "Resume awaiting the pending human decision." };
  }
  if (currentPhase === "plan-revision-requested") {
    return { resumable: true, suggestedPhase: "plan-revision-requested", nextStatus: "PENDING", reason: "Plan revisions are still required before implementation." };
  }
  if (currentPhase === "plan-approval-rejected") {
    return { resumable: false, suggestedPhase: "plan-approval-rejected", nextStatus: "PENDING", reason: "Rejected plans are not resumable." };
  }
  if (currentPhase === "acceptance") {
    return { resumable: true, suggestedPhase: "acceptance", nextStatus: "RUNNING", reason: "Resume from acceptance gate." };
  }
  if (currentPhase === "landing") {
    return { resumable: true, suggestedPhase: "landing", nextStatus: "RUNNING", reason: "Resume landing stage." };
  }
  if (currentPhase === "merge-blocked") {
    return {
      resumable: true,
      suggestedPhase: "landing",
      nextStatus: "RUNNING",
      reason: "Clean the target checkout, then resume landing; the candidate branch and commit are preserved.",
    };
  }
  if (currentPhase.includes("review")) {
    return { resumable: true, suggestedPhase: "review", nextStatus: "RUNNING", reason: "Resume review stage." };
  }
  if (currentPhase.includes("verification") || currentPhase.includes("repair")) {
    const failureKind = typeof verification?.failureClassification === "object" && verification?.failureClassification && typeof (verification.failureClassification as { kind?: unknown }).kind === "string"
      ? String((verification.failureClassification as { kind?: unknown }).kind)
      : undefined;
    if (failureKind === "harness/config" || failureKind === "repo script/config" || failureKind === "missing-executable" || failureKind === "invalid-command" || failureKind === "missing-dependency" || failureKind === "environment-policy") {
      return { resumable: true, suggestedPhase: "verification-planning", nextStatus: "RUNNING", reason: `Resume by re-planning verification because the last failure was classified as ${failureKind}.` };
    }
    return { resumable: true, suggestedPhase: "verification", nextStatus: "RUNNING", reason: failureKind === "real code failure" ? "Resume verification/repair for a real code failure." : "Resume verification stage." };
  }
  if (currentPhase.includes("integration")) {
    return { resumable: true, suggestedPhase: "integration", nextStatus: "RUNNING", reason: "Resume integration stage." };
  }
  return { resumable: true, suggestedPhase: "implementation", nextStatus: "RUNNING", reason: "Resume implementation stage." };
}

async function readTaskArtifacts(tasksDir: string): Promise<Record<string, unknown>[]> {
  try {
    const entries = await fs.readdir(tasksDir);
    const files = entries.filter((entry) => entry.endsWith(".json")).sort();
    const results: Record<string, unknown>[] = [];
    for (const file of files) {
      const parsed = await readJson<Record<string, unknown>>(path.join(tasksDir, file));
      if (parsed) {
        results.push(parsed);
      }
    }
    return results;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function gitBranchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", branch], { cwd, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function gitObjectExists(cwd: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readState(filePath: string) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as ResumeFactoryRunResult["state"];
}
