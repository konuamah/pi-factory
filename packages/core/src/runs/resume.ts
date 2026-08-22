import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readLatestFactoryRunStatus } from "./status.js";
import { appendFactoryRunEvent, updateFactoryRunState } from "./store.js";

const execFileAsync = promisify(execFile);

export interface ResumeFactoryRunResult {
  resumed: boolean;
  reason: string;
  runDir?: string;
  statePath?: string;
  eventsPath?: string;
  recovery?: {
    suggestedPhase: string;
    executionCwd?: string;
    candidateSha?: string;
    finalMergePath?: string;
    checks: Array<{
      name: string;
      ok: boolean;
      detail: string;
    }>;
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

  if (currentStatus === "RUNNING" || currentStatus === "PENDING") {
    const next = await updateFactoryRunState({
      statePath: latest.statePath,
      patch: {
        status: "RUNNING",
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
        checks: recovery.checks,
      },
    });

    return {
      resumed: true,
      reason: "Latest in-progress run marked resumed",
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
        status: "RUNNING",
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
        checks: recovery.checks,
      },
    });

    return {
      resumed: true,
      reason: "Latest interrupted run re-opened",
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

  return {
    suggestedPhase: suggestResumePhase(currentPhase, finalMerge),
    executionCwd,
    candidateSha,
    finalMergePath: await exists(finalMergePath) ? finalMergePath : undefined,
    checks,
  };
}

function suggestResumePhase(currentPhase: string, finalMerge: Record<string, unknown> | undefined): string {
  if (currentPhase.includes("approval")) {
    return "approval-ready";
  }
  if (currentPhase.includes("merge")) {
    return finalMerge ? "merge" : "approval-ready";
  }
  if (currentPhase.includes("review")) {
    return "review";
  }
  if (currentPhase.includes("verification") || currentPhase.includes("repair")) {
    return "verification";
  }
  if (currentPhase.includes("integration")) {
    return "integration";
  }
  return "implementation";
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
