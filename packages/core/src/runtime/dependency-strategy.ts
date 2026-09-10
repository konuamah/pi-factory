import type { AgentExecutor } from "./interfaces.js";
import type { DependencyEvidence } from "./dependency-evidence.js";

export interface DependencyStrategy { cwd: string; packageManager?: string; setup?: string; rationale: string; selectionSource: "ai" | "deterministic"; }

export function buildDeterministicDependencyStrategy(evidence: DependencyEvidence, configuredSetup?: string): DependencyStrategy {
  const candidate = evidence.candidateCwds.find((item) => item.missingDependencyMarkers.length > 0) ?? evidence.candidateCwds[0];
  const manager = candidate?.packageManager;
  return { cwd: candidate?.path ?? evidence.rootCwd, packageManager: manager, setup: configuredSetup ?? defaultSetup(manager), rationale: "Selected from detected workspace markers and configured setup.", selectionSource: "deterministic" };
}

export async function planDependencyStrategy(input: { cwd: string; goal: string; evidence: DependencyEvidence; configuredSetup?: string; executor?: AgentExecutor; model?: { provider?: string; model: string }; limits?: Record<string, unknown>; allowDeterministicFallback?: boolean }): Promise<DependencyStrategy> {
  const fallback = () => buildDeterministicDependencyStrategy(input.evidence, input.configuredSetup);
  if (!input.executor) {
    if (input.allowDeterministicFallback === false) throw new Error("DEPENDENCY_STRATEGY_MISSING_EXECUTOR");
    return fallback();
  }
  const result = await input.executor.execute({ executionId: `${input.cwd}-dependency-strategy`, cwd: input.cwd, prompt: JSON.stringify({ goal: input.goal, instruction: "Choose a candidate cwd and setup command from this evidence. Return JSON only.", evidence: input.evidence, configuredSetup: input.configuredSetup }), model: input.model, tools: ["read"], limits: input.limits as never, metadata: { role: "planner", purpose: "dependency-strategy" } });
  if (result.status !== "completed") return fallback();
  try {
    const parsed = JSON.parse(result.outputText) as Partial<DependencyStrategy>;
    const candidate = input.evidence.candidateCwds.find((item) => item.path === parsed.cwd);
    if (!candidate || (parsed.packageManager && parsed.packageManager !== candidate.packageManager)) return fallback();
    if (parsed.setup && !/^(npm|pnpm|yarn|bun|uv|pip|cargo|go|make)\b/.test(parsed.setup.trim())) return fallback();
    return { cwd: candidate.path, packageManager: candidate.packageManager, setup: parsed.setup ?? input.configuredSetup ?? defaultSetup(candidate.packageManager), rationale: typeof parsed.rationale === "string" ? parsed.rationale : "Selected by dependency strategy model.", selectionSource: "ai" };
  } catch { return fallback(); }
}

function defaultSetup(manager?: string): string | undefined {
  return manager === "npm" ? "npm install" : manager === "pnpm" ? "pnpm install" : manager === "yarn" ? "yarn install" : manager === "bun" ? "bun install" : undefined;
}
