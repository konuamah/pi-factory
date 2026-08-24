import type { FactorySetupContext, FactorySetupRecommendation } from "@factory/schemas";

export function validateSetupRecommendation(
  rec: FactorySetupRecommendation,
  ctx: FactorySetupContext,
): FactorySetupRecommendation {
  const allowedModels = new Set(ctx.availableModels.map((m) => `${m.provider ?? ""}:${m.model}`));
  const allowedCaps = new Set(ctx.availableCapabilities);
  const allowedSkills = new Set(ctx.availableSkills.map((s) => s.id));
  const allowedPresets = new Set(["balanced", "fast", "safe"]);
  const discoveredVals = new Set(Object.values(ctx.discoveredCommands).filter(Boolean) as string[]);

  if (!rec.projectUnderstanding?.summary?.trim()) throw new Error("projectUnderstanding.summary is required");

  if (rec.workflow) {
    const v = rec.workflow.value as { kind?: string; preset?: string; workflow?: unknown };
    if (v.kind === "custom") {
      const wf = (v as { workflow: import("@factory/schemas").WorkflowDefinition }).workflow;
      if (!wf?.stages || wf.stages.length < 2 || wf.stages.length > 10) throw new Error("custom workflow must have 2-10 stages");
      if (wf.stages.some((s) => !s.name?.trim())) throw new Error("workflow stage missing name");
      if (wf.stages.some((s) => s.role && !["planner","builder","reviewer","repair"].includes(s.role))) throw new Error("workflow stage has unknown role");
      if (hasCycle(wf.stages)) throw new Error("workflow DAG has a cycle");
      for (const st of wf.stages) if (st.requiredCapabilities?.some((c) => !allowedCaps.has(c as unknown as import("@factory/schemas").Capability))) throw new Error(`workflow stage requires unknown capability`);
      // model overrides must be allowlisted
      for (const st of wf.stages) if (st.model?.model) {
        const key = `${st.model.provider ?? ""}:${st.model.model}`;
        if (!allowedModels.has(key) && !["opus","sonnet"].includes(st.model.model)) throw new Error(`workflow stage model not allowlisted: ${key}`);
      }
    } else if (v.kind === "preset" || v.preset) {
      const preset = (v as { preset: string }).preset;
      if (!allowedPresets.has(preset)) throw new Error(`workflow preset must be one of balanced|fast|safe`);
    } else {
      throw new Error("workflow value must be {kind:preset,preset} or {kind:custom,workflow}");
    }
  }

  // Models — must be in availableModels
  if (rec.models) {
    for (const [role, entry] of Object.entries(rec.models)) {
      if (!entry) continue;
      const key = `${entry.value.provider ?? ""}:${entry.value.model}`;
      if (!allowedModels.has(key)) {
        throw new Error(`model for ${role} not in availableModels: ${key}`);
      }
    }
  }

  // Commands — DISCOVERED must match discoveredCommands, AI_SUGGESTED must have requiresConfirmation
  if (rec.commands) {
    for (const [field, r] of Object.entries(rec.commands) as Array<[string, import("@factory/schemas").Recommendation<string> | undefined]>) {
      if (!r) continue;
      const v = r.value.trim();
      if (!v) throw new Error(`command ${field} must not be empty`);
      if (r.source === "DISCOVERED" && !discoveredVals.has(v)) {
        throw new Error(`command ${field} marked DISCOVERED but value not discovered: ${v}`);
      }
      if (r.source === "AI_SUGGESTED" && r.requiresConfirmation !== true) {
        throw new Error(`AI_SUGGESTED command ${field} must have requiresConfirmation: true`);
      }
      // DISCOVERED commands come from package.json/scripts and may legitimately contain &&, ;, |, $ etc.
      // Only block invented commands that smuggle metachars without confirmation.
      if (r.source === "AI_SUGGESTED" && /[;&|`$]/.test(v) && r.requiresConfirmation !== true) {
        throw new Error(`command ${field} with shell metacharacters must require confirmation`);
      }
      if (r.source === "AI_SUGGESTED" && r.requiresConfirmation !== true && !discoveredVals.has(v)) {
        // extra guard: non-discovered value without explicit confirmation is still AI_SUGGESTED
        // (already enforced above via source check)
      }
    }
  }

  // Capabilities — only allowlisted IDs
  if (rec.capabilities?.allow) {
    for (const c of rec.capabilities.allow) {
      if (!allowedCaps.has(c)) throw new Error(`capability allow not in availableCapabilities: ${c}`);
    }
  }
  if (rec.capabilities?.deny) {
    for (const c of rec.capabilities.deny) {
      if (!allowedCaps.has(c)) throw new Error(`capability deny not in availableCapabilities: ${c}`);
    }
  }

  // Skills in taskTypes — recommendation taskTypes must reference allowed skill ids if they claim to
  if (rec.taskTypes) {
    for (const tt of rec.taskTypes) {
      // taskType ids are free-form but routing models must be allowlisted
      if (tt.routing) {
        for (const [role, routing] of Object.entries(tt.routing)) {
          if (!routing) continue;
          const key = `${routing.provider ?? ""}:${routing.model}`;
          // routing model must be either an availableModel or built-in opus/sonnet which are already in availableModels
          if (routing.model && !allowedModels.has(key) && !["opus", "sonnet"].includes(routing.model)) {
            throw new Error(`taskType ${tt.id} routing ${role} model not allowlisted: ${key}`);
          }
        }
      }
    }
  }

  // Runtime/repair/approval ranges
  if (rec.runtime?.maxParallelAgents) {
    const n = rec.runtime.maxParallelAgents.value;
    if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error(`maxParallelAgents must be 1..16`);
  }
  if (rec.repair?.maxAttempts) {
    const n = rec.repair.maxAttempts.value;
    if (!Number.isInteger(n) || n < 0 || n > 10) throw new Error(`repair maxAttempts must be 0..10`);
  }
  if (rec.git?.cleanup?.retainRuns) {
    const n = rec.git.cleanup.retainRuns.value;
    if (!Number.isInteger(n) || n < 0) throw new Error(`retainRuns must be >=0`);
  }
  if (rec.git?.baseBranch) {
    if (!rec.git.baseBranch.value.trim()) throw new Error(`baseBranch must not be empty`);
    if (/[^\w./-]/.test(rec.git.baseBranch.value)) throw new Error(`baseBranch contains illegal characters`);
  }

  // Constitution
  if (!["GENERATE", "REFRESH", "KEEP"].includes(rec.constitution)) {
    throw new Error(`constitution must be GENERATE|REFRESH|KEEP`);
  }

  if (rec.skills?.ids) for (const id of rec.skills.ids) if (!allowedSkills.has(id)) throw new Error(`skill not allowlisted: ${id}`);

  for (const q of rec.questions ?? []) if (!q.question?.trim() || !q.options?.length) throw new Error(`question ${q.id} missing question/options`);

  // Cross-check: AI_SUGGESTED commands must not be auto-applied later — caller must enforce requiresConfirmation gate

  return rec;
}

function hasCycle(stages: Array<{ name: string; dependsOn?: string[] }>): boolean {
  const byName = new Map(stages.map((s) => [s.name, s]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): boolean => {
    if (visited.has(name)) return false;
    if (visiting.has(name)) return true;
    visiting.add(name);
    const node = byName.get(name);
    if (node?.dependsOn) for (const dep of node.dependsOn) if (visit(dep)) return true;
    visiting.delete(name); visited.add(name); return false;
  };
  return stages.some((s) => visit(s.name));
}
