import type {
  VerificationEvidenceStore,
  VerificationContractPlan,
  VerificationProvider,
  VerificationResult,
  VerificationStatus,
} from "./types.js";
import { getVerificationProvider } from "./registry.js";
import { commandProvider, artifactProvider } from "./providers/command-artifact.js";

export interface VerificationEngineOptions {
  cwd: string;
  plan: VerificationContractPlan;
  affectedFiles?: string[];
}

export interface VerificationEngineResult {
  results: VerificationResult[];
  evidence: VerificationEvidenceStore;
  overallStatus: VerificationStatus;
  canComplete: boolean;
}

const PROVIDERS = new Map<string, VerificationProvider>();

export function registerProviderType(provider: VerificationProvider): void {
  PROVIDERS.set(provider.type, provider);
}

export function initializeVerificationProviders(): void {
  registerProviderType(commandProvider);
  registerProviderType(artifactProvider);
}

export async function runVerificationEngine(options: VerificationEngineOptions): Promise<VerificationEngineResult> {
  const evidence: VerificationEvidenceStore = {};
  const results: VerificationResult[] = [];

  for (const requirement of options.plan.requirements) {
    // Skip task-scoped requirements not affected by changed files.
    if (options.affectedFiles?.length && requirement.scope === "TASK" && requirement.affectedFiles?.length) {
      const affected = requirement.affectedFiles.some((file) => options.affectedFiles!.includes(file));
      if (!affected) {
        results.push({
          requirementId: requirement.id,
          blocking: requirement.blocking,
          status: "NOT_RUN",
          evidence: [],
          reason: "Not affected by changed files.",
        });
        continue;
      }
    }

    const provider = PROVIDERS.get(requirement.type) ?? getVerificationProvider(requirement.type);
    if (!provider) {
      results.push({
        requirementId: requirement.id,
        blocking: requirement.blocking,
        status: "BLOCKED",
        evidence: [],
        reason: `No verification provider registered for type '${requirement.type}'.`,
      });
      continue;
    }

    const result = await provider.verify(requirement, { cwd: options.cwd, evidence, results });
    results.push({ ...result, blocking: requirement.blocking });
  }

  const overallStatus = computeOverallStatus(results);
  return {
    results,
    evidence,
    overallStatus,
    canComplete: canComplete(results),
  };
}

export function canComplete(results: VerificationResult[]): boolean {
  return results.every(
    (result) => !result.blocking || result.status === "PASS" || result.status === "NOT_APPLICABLE",
  );
}

export function computeOverallStatus(results: VerificationResult[]): VerificationStatus {
  if (results.some((result) => result.blocking && result.status === "FAIL")) {
    return "FAIL";
  }
  if (results.some((result) => result.blocking && result.status === "BLOCKED")) {
    return "BLOCKED";
  }
  if (results.some((result) => result.blocking && result.status === "INCONCLUSIVE")) {
    return "INCONCLUSIVE";
  }
  if (results.some((result) => result.blocking && result.status === "NOT_RUN")) {
    return "NOT_RUN";
  }
  return "PASS";
}
