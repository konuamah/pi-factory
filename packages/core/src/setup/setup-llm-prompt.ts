// LLM prompt + parse helpers — extracted from factory-setup-llm.ts.
import type { FactorySetupContext, FactorySetupRecommendation } from "@factory/schemas";
export async function loadFactorySetupSkillSource(cwd: string): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const candidates = [
    path.join(cwd, "skills", "factory-setup", "SKILL.md"),
    path.join(cwd, ".pi", "skills", "factory-setup", "SKILL.md"),
    path.resolve(cwd, "..", "skills", "factory-setup", "SKILL.md"),
  ];
  for (const p of candidates) {
    try {
      const content = await fs.readFile(p, "utf8");
      if (content.trim()) return content;
    } catch {}
  }
  try {
    const fsSync = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const packageRoot = path.resolve(moduleDir, "../../../..");
    const candidates2 = [
      path.join(packageRoot, "skills", "factory-setup", "SKILL.md"),
      path.resolve(moduleDir, "../../../skills/factory-setup/SKILL.md"),
      path.resolve(moduleDir, "../../../../skills/factory-setup/SKILL.md"),
      path.resolve(moduleDir, "../../../../../skills/factory-setup/SKILL.md"),
      path.resolve(cwd, "skills/factory-setup/SKILL.md"),
    ];
    for (const p of candidates2) {
      try {
        const content = fsSync.readFileSync(p, "utf8");
        if (content.trim()) return content;
      } catch {}
    }
  } catch {}
  throw new Error(
    `factory-setup skill not found — expected skills/factory-setup/SKILL.md at: ${candidates.join(", ")}`
  );
}

export function buildFactorySetupPrompt(context: FactorySetupContext, skillSource: string): string {
  const compact = buildCompactContext(context);
  const ctxJson = JSON.stringify(compact, null, 2);
  const skillBudget = 6000;
  const ctxBudget = 12000;
  const skillSlice = skillSource ? skillSource.slice(0, skillBudget) : "";
  const ctxSlice = smartTruncateJson(ctxJson, ctxBudget, compact);
  const workflowPrimitives = `
## Workflow primitives (Factory already supports these — you may emit a custom DAG)
Stages: { name, dependsOn?: string[], type?: "agent"|"command"|"approval", role?: ModelRole, commands?: string[], requiresApproval?: boolean, requiredCapabilities?: Capability[] }
Roles: discovery|planner|builder|reviewer|repair|landing  · Keep DAG acyclic, 2-7 stages.
Example simple docs repo: plan -> build -> verify
Example mature app: discover{discovery} -> plan{planner} -> implementation{builder} -> verification{command} -> review{reviewer} -> approval
Example DB repo (recommended here): plan -> build -> migration-check{command} -> integration-verify{command} -> review -> approval — Why: DB changes affect app+deploy, verify before review.
You may return workflow as { kind:"preset", preset:"balanced"|"fast"|"safe" } or { kind:"custom", workflow: WorkflowDefinition }.
`;
  const englishRule = `Simple-English rule: translate internals — finalMerge=required -> "Ask before merging", maxParallelAgents -> "Parallel workers", retainRuns -> "Old workspaces kept".
`;
  return [
    skillSlice ? `# Factory Setup Skill\n\n${skillSlice}` : "",
    workflowPrimitives,
    englishRule,
    "\n## FactorySetupContext (JSON)\n",
    "```json",
    ctxSlice,
    "```",
    "\n## Task\nProduce FactorySetupRecommendation: projectUnderstanding{summary,highlights} + workflow + models/commands/runtime/git/dependencies/repair/approval/capabilities/taskTypes/skills/dashboard/constitution + whyNot[] + questions{kind=fact|recommendation|preference} . Use only allowlisted choices. Return JSON only.",
  ].filter(Boolean).join("\n");
}

export function buildCompactContext(context: FactorySetupContext): Record<string, unknown> {
  // Omit raw text dumps; keep parsed provenance
  const { existing, ...rest } = context;
  const { rawGlobalText, rawProjectText, rawWorkflowText, ...provenance } = existing;
  // Also cap raw dumps to first 500 chars as evidence, not full file
  const evidence: Record<string, string | undefined> = {};
  if (rawGlobalText) evidence.globalSample = rawGlobalText.slice(0, 500);
  if (rawProjectText) evidence.projectSample = rawProjectText.slice(0, 500);
  if (rawWorkflowText) evidence.workflowSample = rawWorkflowText.slice(0, 800);
  return {
    ...rest,
    existing: {
      ...provenance,
      ...(Object.keys(evidence).length ? { _rawSamples: evidence } : {}),
    },
  };
}

export function smartTruncateJson(json: string, budget: number, compact: Record<string, unknown>): string {
  if (json.length <= budget) return json;
  // Priority: keep repository, effective, availableModels/Capabilities, discoveredCommands;
  // truncate existing.workflows and availableSkills last
  const truncated: Record<string, unknown> = { ...compact };
  // Drop availableSkills descriptions first
  if (truncated.availableSkills && json.length > budget) {
    const skills = truncated.availableSkills as Array<{ id: string; description?: string }>;
    truncated.availableSkills = skills.map((s) => ({ id: s.id }));
    const rejson = JSON.stringify(truncated, null, 2);
    if (rejson.length <= budget) return rejson;
  }
  // Drop workflows body
  const ex = truncated.existing as Record<string, unknown> | undefined;
  if (ex?.workflows && JSON.stringify(truncated, null, 2).length > budget) {
    ex.workflows = (ex.workflows as unknown[]).slice(0, 2);
    const rejson = JSON.stringify(truncated, null, 2);
    if (rejson.length <= budget) return rejson;
  }
  // Hard slice as fallback, preserving JSON validity
  const sliced = json.slice(0, budget);
  const lastBrace = sliced.lastIndexOf("}");
  return sliced.slice(0, lastBrace + 1) || sliced;
}

export function extractJson(text: string): unknown | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  // Try raw JSON
  try {
    return JSON.parse(trimmed);
  } catch {}
  // Try code fence
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    try { return JSON.parse(fence[1].trim()); } catch {}
  }
  // Try first {...}
  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace?.[0]) {
    try { return JSON.parse(brace[0]); } catch {}
  }
  return undefined;
}

