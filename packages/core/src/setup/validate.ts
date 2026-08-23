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
    const modelRoles = ["planner", "builder", "reviewer", "repair"] as const;
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

  const failed = checks.filter((check) => !check.ok);
  const readiness: SetupReadiness = failed.length === 0 ? "READY" : failed.length <= 2 ? "READY_WITH_WARNINGS" : "NOT_READY";

  return { readiness, checks };
}
