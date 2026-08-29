import type { FactorySetupContext, FactorySetupRecommendation } from "@factory/schemas";

export type StewardSlideId =
  | "understanding"
  | "workflow"
  | "models"
  | "commands"
  | "runtime"
  | "git"
  | "dependencies"
  | "repair"
  | "approvals"
  | "capabilities"
  | "taskRouting"
  | "skills"
  | "dashboard"
  | "constitution"
  | "finalReview";

export interface StewardSlide {
  id: StewardSlideId;
  title: string;
  simpleTitle: string;
  lines: string[];
  details?: string[];
  kind: "fact" | "recommendation" | "preference";
  recommended?: unknown;
  requiresConfirmation?: boolean;
}

export function buildStewardSlides(
  ctx: FactorySetupContext,
  rec: FactorySetupRecommendation,
): StewardSlide[] {
  const pu = rec.projectUnderstanding;
  const wf = rec.workflow?.value;
  const workflowSummary = describeWorkflow(wf);

  return [
    {
      id: "understanding",
      title: "1. Project understanding",
      simpleTitle: "Here's how I understand this project",
      kind: "fact",
      lines: [
        pu.summary,
        "",
        ...pu.highlights.map((h) => `• ${h}`),
        "",
        "Does this look right?",
      ],
    },
    {
      id: "workflow",
      title: "2. Workflow",
      simpleTitle: "How Factory will work on this project",
      kind: "recommendation",
      recommended: rec.workflow,
      lines: describeWorkflowLines(rec, workflowSummary),
      details: wf?.kind === "custom" ? [`Stages: ${(wf as { workflow: { stages: Array<{ name: string }> } }).workflow.stages.map((s) => s.name).join(", ")}`] : undefined,
    },
    {
      id: "models",
      title: "3. Models",
      simpleTitle: "Which AI models Factory will use",
      kind: "recommendation",
      recommended: rec.models,
      lines: describeModelLines(ctx, rec),
    },
    {
      id: "commands",
      title: "4. Commands and verification",
      simpleTitle: "How Factory checks the work",
      kind: "recommendation",
      recommended: rec.commands,
      lines: describeCommandLines(rec),
    },
    {
      id: "runtime",
      title: "5. Runtime — parallel workers",
      simpleTitle: "How many AI workers may work at once",
      kind: "recommendation",
      recommended: rec.runtime,
      lines: [
        `Recommended: ${rec.runtime?.maxParallelAgents?.value ?? 2} worker(s)`,
        ...(rec.runtime?.maxParallelAgents?.reason ? [`Why: ${rec.runtime.maxParallelAgents.reason}`] : ["Why: 2 is safe for most repos; raise if machine is large."]),
      ],
    },
    {
      id: "git",
      title: "6. Git and worktrees",
      simpleTitle: "How Factory isolates work",
      kind: "recommendation",
      recommended: rec.git,
      lines: describeGitLines(ctx, rec),
    },
    {
      id: "dependencies",
      title: "7. Dependencies",
      simpleTitle: "How Factory prepares each worktree",
      kind: "recommendation",
      recommended: rec.dependencies,
      lines: describeDependencyLines(ctx, rec),
    },
    {
      id: "repair",
      title: "8. Repair",
      simpleTitle: "What happens when verification fails",
      kind: "recommendation",
      recommended: rec.repair,
      lines: [
        `Enabled: ${rec.repair?.enabled?.value ?? ctx.effective?.repair.enabled ? "Yes" : "No"}`,
        `Up to ${rec.repair?.maxAttempts?.value ?? ctx.effective?.repair.maxAttempts ?? 3} attempts`,
        ...(rec.repair?.enabled?.reason ? [`Why: ${rec.repair.enabled.reason}`] : []),
      ],
    },
    {
      id: "approvals",
      title: "9. Approvals — final merge",
      simpleTitle: "Should Factory ask before merging completed work?",
      kind: "preference",
      recommended: rec.approval,
      lines: [
        `${(rec.approval?.finalMerge?.value ?? "required") === "required" ? "Yes, ask me" : "No, merge automatically after verification"}`,
        ...(rec.approval?.finalMerge?.reason ? [`Why: ${rec.approval.finalMerge.reason}`] : []),
      ],
    },
    {
      id: "capabilities",
      title: "10. Capabilities",
      simpleTitle: "What Factory is allowed to do",
      kind: "preference",
      recommended: rec.capabilities,
      lines: describeCapabilityLines(rec),
    },
    {
      id: "taskRouting",
      title: "11. Task routing",
      simpleTitle: "How different kinds of work are routed",
      kind: "recommendation",
      recommended: rec.taskTypes,
      lines: describeTaskRouting(ctx, rec),
    },
    {
      id: "skills",
      title: "12. Skills",
      simpleTitle: "Extra capabilities for this project",
      kind: "recommendation",
      recommended: rec.skills,
      lines: describeSkills(ctx, rec),
    },
    {
      id: "dashboard",
      title: "13. Dashboard",
      simpleTitle: "Live progress dashboard",
      kind: "recommendation",
      recommended: rec.dashboard,
      lines: describeDashboardLines(ctx, rec),
    },
    {
      id: "constitution",
      title: "14. Constitution — living understanding",
      simpleTitle: "How Factory remembers this repo",
      kind: "recommendation",
      lines: describeConstitution(ctx, rec),
    },
    {
      id: "finalReview",
      title: "15. Final review",
      simpleTitle: "Ready to write the setup?",
      kind: "preference",
      lines: [
        "We'll review it together — each section started with a recommendation. You can keep or Customize any slide.",
        ...(rec.questions?.length ? [`Open questions: ${rec.questions.length} — we'll ask them as we go.`] : []),
        ...(rec.whyNot?.length ? rec.whyNot.map((w) => `Not enabled: ${w.area} — ${w.reason}`) : []),
      ],
    },
  ];
}

function describeWorkflowLines(rec: FactorySetupRecommendation, workflowSummary: ReturnType<typeof describeWorkflow>): string[] {
  const wf = rec.workflow?.value;
  return [
    `I recommend: ${workflowSummary.label}`,
    ...(workflowSummary.idLine ? [workflowSummary.idLine] : []),
    ...(workflowSummary.stageLine ? [workflowSummary.stageLine] : []),
    ...(rec.workflow?.reason ? [`Why: ${rec.workflow.reason}`] : []),
    ...(wf?.kind === "custom" ? [(wf as { reason: string }).reason ? `Reason: ${(wf as { reason: string }).reason}` : undefined].filter(Boolean) as string[] : []),
    ...(rec.whyNot?.filter((w) => w.area.toLowerCase().includes("workflow")).map((w) => `Not recommended: ${w.area} — ${w.reason}`) ?? []),
  ].filter(Boolean) as string[];
}

function describeModelLines(ctx: FactorySetupContext, rec: FactorySetupRecommendation): string[] {
  return [
    ...describeConfiguredModels(ctx),
    ...(rec.models
      ? Object.entries(rec.models).map(([role, v]) => `${role}: ${v!.value.provider ? `${v!.value.provider}/` : ""}${v!.value.model} — ${v!.reason}`)
      : ["No model overrides — using Factory defaults (opus/sonnet)."]),
    "",
    rec.models
      ? "Why: Factory is using models discovered from your Pi configuration first; built-in fallbacks are only used if no configured model is available."
      : "Why: No configured Pi model was available to Factory, so it will fall back to built-in role defaults.",
  ];
}

function describeCommandLines(rec: FactorySetupRecommendation): string[] {
  return [
    ...Object.entries(rec.commands ?? {}).map(([k, v]) => {
      if (!v) return `${k}: none`;
      const flag = v.source === "DISCOVERED" ? "✓" : v.source === "AI_SUGGESTED" ? "?" : "·";
      return `${flag} ${k}: ${v.value} [${v.source}] — ${v.reason}${v.requiresConfirmation ? " (needs confirmation)" : ""}`;
    }),
    ...(rec.whyNot?.filter((w) => w.area.toLowerCase().includes("verification")).map((w) => `Skipped: ${w.area} — ${w.reason}`) ?? []),
  ];
}

function describeGitLines(ctx: FactorySetupContext, rec: FactorySetupRecommendation): string[] {
  return [
    `Base branch: ${rec.git?.baseBranch?.value ?? ctx.effective?.git.baseBranch ?? "main"}`,
    `Worktrees: ${rec.git?.allowWorktrees?.value ?? ctx.effective?.git.allowWorktrees ? "Enabled" : "Disabled"} — keeps parallel work isolated`,
    `Keep completed workspaces: ${rec.git?.cleanup?.retainRuns?.value ?? ctx.effective?.git.cleanup.retainRuns ?? 10} runs`,
  ];
}

function describeDependencyLines(ctx: FactorySetupContext, rec: FactorySetupRecommendation): string[] {
  return [
    `Hydration: ${rec.dependencies?.enabled?.value ?? ctx.effective?.dependencies.enabled ? "Enabled" : "Disabled"}`,
    `Mode: ${rec.dependencies?.hydrate?.value ?? ctx.effective?.dependencies.hydrate ?? "auto"}`,
    `Cache root: ${rec.dependencies?.cacheRoot?.value ?? ctx.effective?.dependencies.cacheRoot ?? "~/.factory/cache"}`,
    ...(rec.dependencies?.hydrate?.reason ? [`Why: ${rec.dependencies.hydrate.reason}`] : ["Why: shared package caches keep isolated worktrees fast without sharing writable dependency folders."]),
  ];
}

function describeCapabilityLines(rec: FactorySetupRecommendation): string[] {
  return [
    ...(rec.capabilities?.allow?.length ? [`Allowed: ${rec.capabilities.allow.join(", ")}`] : ["Allowed: default (repo read/write, shell)"]),
    ...(rec.capabilities?.deny?.length ? [`Denied: ${rec.capabilities.deny.join(", ")}`] : []),
    ...(rec.whyNot?.filter((w) => w.area.toLowerCase().includes("production")).map((w) => `${w.area}: ${w.reason}${w.howToEnable ? ` — ${w.howToEnable}` : ""}`) ?? []),
  ];
}

function describeDashboardLines(ctx: FactorySetupContext, rec: FactorySetupRecommendation): string[] {
  return [
    `Dashboard: ${rec.dashboard?.enabled?.value ?? ctx.effective?.dashboard.enabled ? "Enabled" : "Disabled"}${rec.dashboard?.port?.value ? ` on :${rec.dashboard.port.value}` : ""}`,
    ...(rec.dashboard?.enabled?.reason ? [`Why: ${rec.dashboard.enabled.reason}`] : []),
  ];
}

export function simpleEnglishLabel(field: string): string {
  const map: Record<string, string> = {
    "approval.finalMerge": "Ask before merging completed work?",
    "runtime.maxParallelAgents": "How many AI workers may work at once?",
    "git.cleanup.retainRuns": "How many completed run workspaces should Factory keep?",
    "git.allowWorktrees": "Isolate work with git worktrees?",
    "dependencies.hydrate": "When should Factory hydrate dependencies?",
    "dependencies.cacheRoot": "Where should Factory keep shared dependency caches?",
    "repair.maxAttempts": "How many repair attempts after verification fails?",
  };
  return map[field] ?? field;
}

function describeWorkflow(wf: NonNullable<FactorySetupRecommendation["workflow"]>["value"] | undefined): {
  label: string;
  idLine?: string;
  stageLine?: string;
} {
  if (!wf) {
    return {
      label: "Balanced development flow",
      idLine: "Saved as: default-dev — the workflow name Factory uses when you do not choose another one.",
      stageLine: "Steps: plan → build → verify → approval → merge.",
    };
  }

  if (wf.kind === "custom") {
    return {
      label: "Custom workflow",
      idLine: `Saved as: ${wf.workflow.id} — the workflow name Factory uses when selecting this custom flow.`,
      stageLine: `Steps: ${wf.workflow.stages.map((s) => s.name).join(" → ")}.`,
    };
  }

  const presetName = wf.preset === "safe"
    ? "Safe development flow"
    : wf.preset === "fast"
      ? "Fast development flow"
      : "Balanced development flow";
  const stages = wf.preset === "fast"
    ? "plan → build → approval → merge"
    : "plan → build → verify → approval → merge";
  const workflowId = wf.workflowId ?? "default-dev";

  return {
    label: presetName,
    idLine: `Saved as: ${workflowId} — the workflow name Factory uses when you do not choose another one.`,
    stageLine: `Steps: ${stages}.`,
  };
}

function describeConfiguredModels(ctx: FactorySetupContext): string[] {
  const configured = ctx.availableModels.filter((model) => model.provider);
  if (configured.length === 0) {
    return ["Configured Pi models found: none visible to Factory.", ""];
  }

  const byProvider = new Map<string, string[]>();
  for (const model of configured) {
    const provider = model.provider ?? "default";
    const models = byProvider.get(provider) ?? [];
    models.push(model.model);
    byProvider.set(provider, models);
  }

  const providerLines = [...byProvider.entries()].slice(0, 4).map(([provider, models]) => {
    const sample = models.slice(0, 3).join(", ");
    const extra = models.length > 3 ? `, +${models.length - 3} more` : "";
    return `${provider}: ${sample}${extra}`;
  });

  return [
    `Configured Pi providers found: ${[...byProvider.keys()].slice(0, 4).join(", ")}${byProvider.size > 4 ? `, +${byProvider.size - 4} more` : ""}.`,
    ...providerLines.map((line) => `  ${line}`),
    "",
  ];
}

function describeTaskRouting(ctx: FactorySetupContext, rec: FactorySetupRecommendation): string[] {
  const taskTypes = rec.taskTypes?.length
    ? rec.taskTypes
    : Object.entries(ctx.effective?.taskTypes ?? {}).map(([id, definition]) => ({
        id,
        description: definition.description,
        match: definition.match,
        routing: definition.routing,
        reason: "Already present in this project config.",
        source: "DEFAULT" as const,
        confidence: "MEDIUM" as const,
      }));

  if (taskTypes.length === 0) {
    return [
      "Task routing means: Factory can tag a run as a specific kind of work, then use any matching model or workflow rules for that kind.",
      "How it matches: first an explicit run task type, then goal keywords, then changed-file path hints.",
      "",
      "Factory will treat work as general unless you choose a task type for a run.",
      "What this affects: task type can choose different role models or workflows when configured.",
      "Configured task types: none.",
    ];
  }

  const lines = [
    "Task routing means: Factory can tag a run as a specific kind of work, then use any matching model or workflow rules for that kind.",
    "How it matches: first an explicit run task type, then goal keywords, then changed-file path hints.",
    "",
  ];

  for (const taskType of taskTypes) {
    const keywords = taskType.match?.keywords ?? [];
    const paths = taskType.match?.paths ?? [];
    const routes = Object.entries(taskType.routing ?? {})
      .filter(([, route]) => Boolean(route?.model))
      .map(([role, route]) => `${role} → ${route!.provider ? `${route!.provider}/` : ""}${route!.model}`);
    lines.push(`• ${taskType.id}`);
    lines.push(`  When it matches: ${[
      keywords.length ? `goal contains ${keywords.map((k) => JSON.stringify(k)).join(", ")}` : "",
      paths.length ? `changed files match ${paths.map((p) => JSON.stringify(p)).join(", ")}` : "",
    ].filter(Boolean).join("; ") || "only when explicitly chosen for a run"}.`);
    lines.push(`  What changes: ${routes.length ? routes.join(", ") : "no special model routing yet; it only labels the run for now"}.`);
    if (taskType.reason) lines.push(`  Why keep it: ${taskType.reason}`);
  }

  return lines;
}

function describeSkills(ctx: FactorySetupContext, rec: FactorySetupRecommendation): string[] {
  const selected = rec.skills?.ids ?? [];
  const available = ctx.availableSkills.map((skill) => skill.id);
  const personal = available.filter((id) => !isFactoryBuiltInSkill(id));
  const lines = [
    "Skills are reusable agent playbooks: a SKILL.md file plus optional scripts, references, and assets.",
    "Factory will bring your own skills into its inventory before falling back to built-in Factory stage skills.",
    "Where Factory looks globally: ~/.agents/skills, ~/.codex/skills, ~/.claude/skills, ~/.warp/skills, ~/.cursor/skills, ~/.gemini/skills, ~/.copilot/skills, ~/.github/skills, ~/.opencode/skills, ~/.factory/skills.",
    "Where Factory looks in this repo: .agents/skills, .codex/skills, .claude/skills, .warp/skills, .cursor/skills, .gemini/skills, .copilot/skills, .github/skills, .opencode/skills, .factory/skills, .pi/skills, skills/.",
    "Other agent guidance such as AGENTS.md, CLAUDE.md, and Cursor rules can stay as repo guidance; Customize can be used to decide what should become a Factory skill.",
    "",
    `Detected skills: ${available.length ? available.slice(0, 12).join(", ") : "none"}${available.length > 12 ? `, +${available.length - 12} more` : ""}.`,
  ];

  if (personal.length > 0) {
    lines.push(`Your imported skill candidates: ${personal.slice(0, 8).join(", ")}${personal.length > 8 ? `, +${personal.length - 8} more` : ""}.`);
  }

  if (selected.length > 0) {
    lines.push(`Recommended working set: ${selected.join(", ")}.`);
    if (rec.skills?.reason) lines.push(`Why: ${rec.skills.reason}`);
  } else {
    lines.push("Recommended working set: use detected project/personal skills when their descriptions match the task; otherwise use Factory built-ins.");
  }

  return lines;
}

function isFactoryBuiltInSkill(id: string): boolean {
  return [
    "repo-interpretation",
    "architecture-planning",
    "implementation-task",
    "acceptance-review",
    "failure-triage",
    "verification-repair",
    "verification-planning",
    "factory-setup",
  ].includes(id);
}

function describeConstitution(ctx: FactorySetupContext, rec: FactorySetupRecommendation): string[] {
  const action = rec.constitution === "GENERATE"
    ? "Create"
    : rec.constitution === "REFRESH"
      ? "Refresh"
      : "Keep";
  const hasExisting = ctx.existing.constitutionExists;
  const hasMetadata = ctx.repository.factory.hasConstitutionMetadata;
  const actionMeaning = rec.constitution === "GENERATE"
    ? "Factory will scan the repo and write a new CONSTITUTION.md."
    : rec.constitution === "REFRESH"
      ? "Factory will rescan the repo and update CONSTITUTION.md with current evidence."
      : "Factory will leave the current CONSTITUTION.md in place during setup.";
  const reason = rec.constitution === "KEEP"
    ? hasExisting
      ? "A CONSTITUTION.md already exists, so setup does not need to rewrite it."
      : "No constitution change was requested during setup."
    : hasMetadata
      ? "Factory has prior scan metadata, so it can compare the current repo against the last scan."
      : "Factory needs an initial evidence-backed repo guide before agents rely on it.";

  return [
    "The constitution is Factory's repo guide for agents. It records what this project actually uses: structure, commands, tests, services, data, security, deployment, and conventions.",
    `Recommendation: ${action} the constitution.`,
    actionMeaning,
    `Current state: ${hasExisting ? "CONSTITUTION.md exists" : "no CONSTITUTION.md found"}; ${hasMetadata ? "Factory scan metadata exists" : "no Factory scan metadata found"}.`,
    `Why: ${reason}`,
    "Customize this if you want Factory to regenerate it now, refresh it from the latest repo facts, or keep the existing file unchanged.",
  ];
}
