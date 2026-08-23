import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { EffectiveFactoryConfig } from "@factory/schemas";

export interface FactoryRunState {
  runId: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "BLOCKED" | "DECISION_REQUIRED";
  phase: string;
  workflowId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FactoryRunEvent {
  timestamp: string;
  type: string;
  data?: Record<string, unknown>;
}

export interface CreateFactoryRunInput {
  runsDir: string;
  initialPhase?: string;
  effectiveConfig?: EffectiveFactoryConfig;
  workflowId?: string;
}

export interface CreatedFactoryRun {
  runId: string;
  runDir: string;
  statePath: string;
  eventsPath: string;
  effectiveConfigPath: string;
  state: FactoryRunState;
}

export async function createFactoryRun(input: CreateFactoryRunInput): Promise<CreatedFactoryRun> {
  const timestamp = new Date().toISOString();
  const runId = buildRunId();
  const runDir = path.join(input.runsDir, runId);
  const statePath = path.join(runDir, "state.json");
  const eventsPath = path.join(runDir, "events.jsonl");
  const effectiveConfigPath = path.join(runDir, "effective-config.json");

  const state: FactoryRunState = {
    runId,
    status: "PENDING",
    phase: input.initialPhase ?? "setup",
    workflowId: input.workflowId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  await fs.writeFile(eventsPath, "", "utf8");
  await fs.writeFile(
    effectiveConfigPath,
    JSON.stringify(input.effectiveConfig ?? {}, null, 2),
    "utf8",
  );

  await appendFactoryRunEvent(eventsPath, {
    timestamp,
    type: "run.created",
    data: {
      runId,
      phase: state.phase,
      workflowId: state.workflowId,
    },
  });

  return {
    runId,
    runDir,
    statePath,
    eventsPath,
    effectiveConfigPath,
    state,
  };
}

export async function updateFactoryRunState(input: {
  statePath: string;
  patch: Partial<Pick<FactoryRunState, "status" | "phase">>;
}): Promise<FactoryRunState> {
  const raw = await fs.readFile(input.statePath, "utf8");
  const current = JSON.parse(raw) as FactoryRunState;
  const next: FactoryRunState = {
    ...current,
    ...input.patch,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(input.statePath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export async function appendFactoryRunEvent(
  eventsPath: string,
  event: FactoryRunEvent,
): Promise<void> {
  await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

function buildRunId(): string {
  return `run_${Date.now()}_${randomUUID().slice(0, 8)}`;
}
