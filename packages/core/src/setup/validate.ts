import { runFactoryDoctor } from "../doctor/check.js";
import { discoverFactoryProject } from "../project/discovery.js";
import { loadEffectiveConfig } from "../config/loader.js";
import type { SetupReadiness, SetupValidationResult } from "./types.js";

export async function validateFactorySetup(cwd: string): Promise<SetupValidationResult> {
  const project = await discoverFactoryProject(cwd);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // Required files.
  checks.push({ name: "git-root", ok: Boolean(project.paths.gitRoot), detail: project.paths.gitRoot ?? "No git root" });
  checks.push({ name: "workflow", ok: Boolean(project.paths.workflowPath), detail: project.paths.workflowPath ?? "Missing factory.yaml" });
  checks.push({ name: "project-config", ok: Boolean(project.paths.projectConfigPath), detail: project.paths.projectConfigPath ?? "Missing .factory/config.yaml" });
  checks.push({ name: "constitution", ok: Boolean(project.paths.constitutionPath), detail: project.paths.constitutionPath ?? "Missing CONSTITUTION.md" });

  // Config loads + validates.
  let configOk = true;
  let configDetail = "Config loads";
  try {
    const loaded = await loadEffectiveConfig({ cwd });
    const modelRoles = ["discovery", "planner", "builder", "reviewer", "repair"] as const;
    const missingModels = modelRoles.filter((role) => !loaded.effectiveConfig.models[role]?.model);
    if (missingModels.length > 0) {
      configOk = false;
      configDetail = `Missing models for: ${missingModels.join(", ")}`;
    }
  } catch (error) {
    configOk = false;
    configDetail = error instanceof Error ? error.message : String(error);
  }
  checks.push({ name: "config", ok: configOk, detail: configDetail });

  // Doctor.
  const doctor = await runFactoryDoctor(cwd).catch(() => ({ checks: [] }));
  for (const check of doctor.checks) {
    checks.push({ name: `doctor:${check.name}`, ok: check.ok, detail: check.detail });
  }

  // Only blocking checks gate NOT_READY; optional integration checks (doctor:*) may be warns.
  const blockingFailed = checks.filter((check) => !check.ok && !isOptionalCheck(check.name));
  const anyFailed = checks.filter((check) => !check.ok);
  let readiness: SetupReadiness;
  if (blockingFailed.length === 0 && anyFailed.length === 0) readiness = "READY";
  else if (blockingFailed.length === 0) readiness = "READY_WITH_WARNINGS";
  else readiness = anyFailed.length <= 2 && blockingFailed.length === 0 ? "READY_WITH_WARNINGS" : "NOT_READY";
  // If only optional warnings, force READY_WITH_WARNINGS even when >2 optional fails.
  if (blockingFailed.length === 0 && anyFailed.length > 0) readiness = "READY_WITH_WARNINGS";

  return { readiness, checks };
}

function isOptionalCheck(name: string): boolean {
  return name.startsWith("doctor:") || name === "constitution";
}
