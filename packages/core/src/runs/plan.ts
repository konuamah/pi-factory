import path from "node:path";
import { readLatestFactoryRunStatus } from "./status.js";
import { showFactoryRun } from "./show.js";

export interface LatestFactoryRunPlan {
  runDir?: string;
  runId?: string;
  goal?: string;
  status?: string;
  phase?: string;
  planPath?: string;
  summary?: string;
  workflowStages?: Array<{ name: string; dependsOn?: string[] }>;
  tasks?: Array<{
    id?: string;
    title?: string;
    stage?: string;
    status?: string;
    dependsOn?: string[];
  }>;
}

export async function readLatestFactoryRunPlan(runsDir: string): Promise<LatestFactoryRunPlan> {
  const latest = await readLatestFactoryRunStatus(runsDir);
  if (!latest.runDir || !latest.state?.runId) {
    return {};
  }

  const shown = await showFactoryRun(runsDir, latest.state.runId);
  const plan = shown.plan;
  const summary = shown.summary;
  if (!plan) {
    return {
      runDir: latest.runDir,
      runId: latest.state.runId,
      goal: typeof summary?.goal === "string" ? summary.goal : undefined,
      status: typeof summary?.status === "string" ? summary.status : latest.state.status,
      phase: typeof summary?.phase === "string" ? summary.phase : latest.state.phase,
    };
  }

  const workflowStages = Array.isArray(plan.workflowStages)
    ? plan.workflowStages
        .flatMap((stage) => {
          if (!stage || typeof stage !== "object") return [];
          const value = stage as { name?: unknown; dependsOn?: unknown };
          if (typeof value.name !== "string") return [];
          return [{
            name: value.name,
            dependsOn: Array.isArray(value.dependsOn)
              ? value.dependsOn.filter((item): item is string => typeof item === "string")
              : undefined,
          }];
        })
    : undefined;

  const tasks = Array.isArray(plan.tasks)
    ? plan.tasks
        .flatMap((task) => {
          if (!task || typeof task !== "object") return [];
          const value = task as { id?: unknown; title?: unknown; stage?: unknown; status?: unknown; dependsOn?: unknown };
          return [{
            id: typeof value.id === "string" ? value.id : undefined,
            title: typeof value.title === "string" ? value.title : undefined,
            stage: typeof value.stage === "string" ? value.stage : undefined,
            status: typeof value.status === "string" ? value.status : undefined,
            dependsOn: Array.isArray(value.dependsOn)
              ? value.dependsOn.filter((item): item is string => typeof item === "string")
              : undefined,
          }];
        })
    : undefined;

  return {
    runDir: latest.runDir,
    runId: latest.state.runId,
    goal: typeof plan.goal === "string" ? plan.goal : typeof summary?.goal === "string" ? summary.goal : undefined,
    status: typeof summary?.status === "string" ? summary.status : latest.state.status,
    phase: typeof summary?.phase === "string" ? summary.phase : latest.state.phase,
    planPath: path.join(latest.runDir, "plan.json"),
    summary: typeof plan.summary === "string" ? plan.summary : undefined,
    workflowStages,
    tasks,
  };
}
