import type { FactorySetupContext, FactorySetupRecommendation } from "@factory/schemas";

export function validateSetupRecommendation(
  rec: FactorySetupRecommendation,
  ctx: FactorySetupContext,
): FactorySetupRecommendation {
  // Allowlist sets
  const allowedModels = new Set(ctx.availableModels.map((m) => `${m.provider ?? ""}:${m.model}`));
  const allowedCaps = new Set(ctx.availableCapabilities);
  const allowedSkills = new Set(ctx.availableSkills.map((s) => s.id));
  const allowedPresets = new Set(["balanced", "fast", "safe"]);
  const discoveredVals = new Set(Object.values(ctx.discoveredCommands).filter(Boolean) as string[]);

  // Workflow preset
  if (rec.workflow) {
    if (!allowedPresets.has(rec.workflow.value.preset)) {
      throw new Error(`workflow preset must be one of balanced|fast|safe`);
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

  // Cross-check: AI_SUGGESTED commands must not be auto-applied later — caller must enforce requiresConfirmation gate

  return rec;
}
