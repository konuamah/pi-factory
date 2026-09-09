import fs from "node:fs/promises";
import path from "node:path";
import { discoverFactoryProject } from "../project/discovery.js";
import { listFactoryRuns } from "../runs/list.js";
import { readDecisionLedger } from "../decisions/ledger.js";
import { inspectRepositoryForSetup } from "../setup/profile.js";
import { loadEffectiveConfig } from "../config/loader.js";
import { listRegisteredCapabilities } from "../capabilities/registry.js";
import { initializeCapabilitySystem } from "../capabilities/registry.js";
import { getProvider } from "../capabilities/providers.js";
import { checkExecutability } from "../capabilities/executability.js";
import { readAcceptanceEvidence } from "../runs/show.js";

export interface DashboardStatus {
  repository: { name?: string; branch?: string; commit?: string; root?: string };
  readiness: "READY" | "READY_WITH_WARNINGS" | "NOT_READY";
  activeRuns: number;
  needsAttention: Array<{ runId: string; kind: string; detail?: string }>;
  verificationFailures: number;
  constitution: { coveredAreas: number; totalAreas: number };
  recentRuns: Array<{ runId: string; goal?: string; status?: string; phase?: string }>;
}

export async function queryStatus(cwd: string): Promise<DashboardStatus> {
  const project = await discoverFactoryProject(cwd);
  const runsDir = project.paths.runsDir;
  const runs = await listFactoryRuns(runsDir);

  const activeRuns = runs.filter((run) => run.status === "RUNNING" || run.status === "DECISION_REQUIRED" || run.status === "PENDING").length;
  const verificationFailures = runs.filter((run) => run.status === "FAILED").length;

  const needsAttention: DashboardStatus["needsAttention"] = [];
  for (const run of runs.slice(0, 10)) {
    const runDir = path.join(runsDir, run.runId);
    const decisions = await readDecisionLedger(runDir).catch(() => []);
    const pending = decisions.filter((entry) => entry.type === "request").length > 0 &&
      !decisions.some((entry) => entry.type === "resolution" && entry.result.requestId === (decisions.filter((d) => d.type === "request").at(-1) as { request: { id: string } } | undefined)?.request.id);
    if (run.status === "DECISION_REQUIRED" || pending) {
      needsAttention.push({ runId: run.runId, kind: "decision-required", detail: run.goal });
    } else if (run.status === "BLOCKED") {
      needsAttention.push({ runId: run.runId, kind: "blocked", detail: run.title ?? run.goal });
    }
  }

  const repo = await inspectRepositoryForSetup(cwd).catch(() => undefined);
  const git = await readGitInfo(cwd).catch(() => undefined);
  const config = await loadEffectiveConfig({ cwd }).catch(() => undefined);

  return {
    repository: {
      name: git?.root ? path.basename(git.root) : repo?.gitRoot ? path.basename(repo.gitRoot) : undefined,
      branch: git?.branch,
      commit: git?.commit,
      root: repo?.gitRoot,
    },
    readiness: repo ? (repo.factory.files.workflow && repo.factory.files.projectConfig ? "READY" : "READY_WITH_WARNINGS") : "NOT_READY",
    activeRuns,
    needsAttention,
    verificationFailures,
    constitution: {
      coveredAreas: 0,
      totalAreas: 120,
    },
    recentRuns: runs.slice(0, 8).map((run) => ({ runId: run.runId, title: run.title, goal: run.goal, status: run.status, phase: run.phase })),
  };
}

export async function queryRepository(cwd: string): Promise<Record<string, unknown>> {
  const profile = await inspectRepositoryForSetup(cwd);
  const git = await readGitInfo(cwd).catch(() => undefined);
  const config = await loadEffectiveConfig({ cwd }).catch(() => undefined);
  return {
    gitRoot: profile.gitRoot,
    branch: git?.branch,
    commit: git?.commit,
    maturity: profile.maturity,
    languages: profile.languages,
    packageManagers: profile.packageManagers,
    frameworks: profile.frameworks,
    monorepo: profile.structure.monorepo,
    commands: profile.commands,
    testing: profile.testing,
    persistence: profile.persistence,
    ci: profile.ci,
    deployment: profile.deployment,
    factory: profile.factory,
    workflowId: config?.effectiveConfig.resolvedWorkflowId,
    baseBranch: config?.effectiveConfig.git.baseBranch,
  };
}

export async function queryRuns(cwd: string): Promise<Array<Record<string, unknown>>> {
  const project = await discoverFactoryProject(cwd);
  const runs = await listFactoryRuns(project.paths.runsDir);
  return runs.map((run) => ({
    runId: run.runId,
    status: run.status,
    phase: run.phase,
    title: run.title,
    goal: run.goal,
    updatedAt: run.updatedAt,
  }));
}

export async function queryRun(cwd: string, runId: string): Promise<Record<string, unknown> | undefined> {
  const project = await discoverFactoryProject(cwd);
  const runDir = path.join(project.paths.runsDir, runId);
  try {
    await fs.access(path.join(runDir, "state.json"));
  } catch {
    return undefined;
  }
  const state = await readJson(path.join(runDir, "state.json")).catch(() => undefined);
  const summary = await readJson(path.join(runDir, "summary.json")).catch(() => undefined);
  const plan = await readJson(path.join(runDir, "plan.json")).catch(() => undefined);
  const verification = await readJson(path.join(runDir, "verification.json")).catch(() => undefined);
  const modelLedger = await readModelLedgerLines(runDir);
  const decisions = await readDecisionLedger(runDir).catch(() => []);
  const acceptanceEvidence = await readAcceptanceEvidence(runDir).catch(() => undefined);

  const result: Record<string, unknown> = {
    runId,
    runDir,
    state,
    summary,
    plan,
    verification,
    models: modelLedger,
    decisions: decisions.map((entry) => (entry.type === "request" ? { type: "request", requestId: entry.request.id, question: entry.request.question } : { type: "resolution", requestId: entry.result.requestId, optionId: entry.result.optionId, feedback: entry.result.feedback })),
    status: state?.status ?? summary?.status,
    phase: state?.phase ?? summary?.phase,
    title: summary?.title,
    goal: summary?.goal,
  };
  if (acceptanceEvidence) result.acceptanceEvidence = acceptanceEvidence;
  return result;
}

export async function queryConstitution(cwd: string): Promise<Record<string, unknown>> {
  const project = await discoverFactoryProject(cwd);
  const facts = await readJson(path.join(project.paths.gitRoot ?? cwd, ".factory", "constitution", "facts.json")).catch(() => undefined) as
    | { areas?: Array<{ id?: number; status?: string; finding?: string }> }
    | undefined;
  const areas = facts?.areas ?? [];
  const statusCounts: Record<string, number> = {};
  for (const area of areas) {
    const status = area.status ?? "NOT_DEFINED";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }
  return {
    totalAreas: 120,
    evaluatedAreas: areas.length,
    statusCounts,
    areas: areas.map((area) => ({ id: area.id, status: area.status, finding: area.finding })),
  };
}

export async function queryConstitutionArea(cwd: string, areaId: number): Promise<Record<string, unknown> | undefined> {
  const project = await discoverFactoryProject(cwd);
  const facts = await readJson(path.join(project.paths.gitRoot ?? cwd, ".factory", "constitution", "facts.json")).catch(() => undefined) as
    | { areas?: Array<Record<string, unknown>> }
    | undefined;
  return facts?.areas?.find((area) => area.id === areaId);
}

export async function querySkills(): Promise<Record<string, unknown>[]> {
  const { initializeFactorySkills, listFactorySkills } = await import("../skills/index.js");
  await initializeFactorySkills();
  return listFactorySkills().map((skill) => ({
    id: skill.id,
    version: skill.version,
    description: skill.description,
    capabilities: skill.provides?.capabilities ?? [],
    constitutionAreas: skill.constitutionDependencies ?? skill.applicability?.constitutionAreas ?? [],
    stages: skill.applicability?.stages ?? [],
  }));
}

export async function querySkill(id: string): Promise<Record<string, unknown> | undefined> {
  const { listFactorySkills } = await import("../skills/index.js");
  const skill = listFactorySkills().find((s) => s.id === id);
  if (!skill) {
    return undefined;
  }
  return {
    id: skill.id,
    version: skill.version,
    description: skill.description,
    capabilities: skill.provides?.capabilities ?? [],
    constitutionAreas: skill.constitutionDependencies ?? skill.applicability?.constitutionAreas ?? [],
    stages: skill.applicability?.stages ?? [],
    permissions: skill.permissions,
  };
}

export async function queryModels(cwd: string): Promise<Record<string, unknown>> {
  const config = await loadEffectiveConfig({ cwd }).catch(() => undefined);
  return {
    roleDefaults: config?.effectiveConfig.models ?? {},
    taskTypes: config?.effectiveConfig.taskTypes ?? {},
    recentLedger: [],
  };
}

export async function queryCapabilities(cwd: string): Promise<Record<string, unknown>[]> {
  const project = await discoverFactoryProject(cwd);
  await initializeCapabilitySystem(project.paths.gitRoot ?? cwd).catch(() => undefined);
  const capabilities = listRegisteredCapabilities();
  return capabilities.map((capability) => {
    const executability = checkExecutability({ capabilityId: capability.id });
    const provider = executability.bindingExists ? getProvider("native")?.id : undefined;
    return {
      id: capability.id,
      effect: capability.effect,
      source: capability.source,
      status: executability.status,
      provider: provider ?? undefined,
      policy: executability.policyAllows ? "allowed" : "restricted",
    };
  });
}

export async function queryVerification(cwd: string): Promise<Record<string, unknown>> {
  const config = await loadEffectiveConfig({ cwd }).catch(() => undefined);
  const project = await discoverFactoryProject(cwd);
  const runs = await listFactoryRuns(project.paths.runsDir);
  return {
    commands: config?.effectiveConfig.commands ?? {},
    recent: runs.slice(0, 5).map((run) => ({ runId: run.runId, status: run.status, phase: run.phase })),
  };
}

export async function queryDecisions(cwd: string): Promise<Record<string, unknown>> {
  const project = await discoverFactoryProject(cwd);
  const runs = await listFactoryRuns(project.paths.runsDir);
  const all: Array<Record<string, unknown>> = [];
  for (const run of runs.slice(0, 10)) {
    const decisions = await readDecisionLedger(path.join(project.paths.runsDir, run.runId)).catch(() => []);
    for (const entry of decisions) {
      all.push(
        entry.type === "request"
          ? { runId: run.runId, type: "request", requestId: entry.request.id, question: entry.request.question, options: entry.request.options }
          : { runId: run.runId, type: "resolution", requestId: entry.result.requestId, optionId: entry.result.optionId, feedback: entry.result.feedback },
      );
    }
  }
  return { decisions: all };
}

export async function querySetup(cwd: string): Promise<Record<string, unknown>> {
  const repo = await inspectRepositoryForSetup(cwd);
  const config = await loadEffectiveConfig({ cwd }).catch(() => undefined);
  return {
    workflowId: config?.effectiveConfig.resolvedWorkflowId,
    files: repo.factory.files,
    repository: {
      languages: repo.languages,
      packageManagers: repo.packageManagers,
      frameworks: repo.frameworks,
    },
    models: config?.effectiveConfig.models ?? {},
    readiness: repo.factory.files.workflow && repo.factory.files.projectConfig ? "READY" : "READY_WITH_WARNINGS",
  };
}

export async function queryRunLogs(cwd: string, runId: string): Promise<Array<Record<string, unknown>>> {
  const project = await discoverFactoryProject(cwd);
  const runDir = path.join(project.paths.runsDir, runId);
  try {
    const raw = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8");
    return raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
      const event = JSON.parse(line) as { timestamp?: string; type?: string; data?: Record<string, unknown> };
      return {
        id: `${runId}-${index}`,
        timestamp: event.timestamp,
        runId,
        source: sourceForEvent(event.type ?? ""),
        level: levelForEvent(event.type ?? "", event.data),
        message: `${event.type ?? "event"}${event.data ? ` | ${JSON.stringify(event.data).slice(0, 200)}` : ""}`,
        metadata: event.data,
      };
    });
  } catch {
    return [];
  }
}

function sourceForEvent(type: string): string {
  if (/planner|planning/.test(type)) return "PLANNER";
  if (/builder|task\.|implementation/.test(type)) return "BUILDER";
  if (/repair/.test(type)) return "REPAIR";
  if (/reviewer|review/.test(type)) return "REVIEWER";
  if (/verification|verify/.test(type)) return "VERIFICATION";
  if (/tool|command/.test(type)) return "TOOL";
  return "SYSTEM";
}

function levelForEvent(type: string, data?: Record<string, unknown>): string {
  const haystack = `${type} ${JSON.stringify(data ?? {})}`.toLowerCase();
  if (/failed|error|blocked|violation/.test(haystack)) return "ERROR";
  if (/warn|warning|inconclusive/.test(haystack)) return "WARN";
  return "INFO";
}

async function readGitInfo(cwd: string): Promise<{ root?: string; branch?: string; commit?: string } | undefined> {
  const project = await discoverFactoryProject(cwd);
  if (!project.paths.gitRoot) {
    return undefined;
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  let branch: string | undefined;
  let commit: string | undefined;
  try {
    const branchResult = await execFileAsync("git", ["branch", "--show-current"], { cwd: project.paths.gitRoot, windowsHide: true });
    branch = branchResult.stdout.trim() || undefined;
  } catch {}
  try {
    const commitResult = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: project.paths.gitRoot, windowsHide: true });
    commit = commitResult.stdout.trim() || undefined;
  } catch {}
  return { root: project.paths.gitRoot, branch, commit };
}

async function readJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readModelLedgerLines(runDir: string): Promise<Record<string, unknown>[]> {
  try {
    const raw = await fs.readFile(path.join(runDir, "model-ledger.jsonl"), "utf8");
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}
