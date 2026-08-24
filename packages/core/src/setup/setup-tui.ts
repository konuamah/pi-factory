import type { FactorySetupContext, FactorySetupRecommendation } from "@factory/schemas";

export type StewardSlideId =
  | "understanding"
  | "workflow"
  | "models"
  | "commands"
  | "runtime"
  | "git"
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
  const wfLabel = wf
    ? wf.kind === "custom"
      ? `Custom: ${wf.workflow.stages.map((s) => s.name).join(" → ")}`
      : `${wf.preset} (${wf.workflowId})`
    : "balanced (default)";

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
      lines: [
        `I recommend: ${wfLabel}`,
        ...(rec.workflow?.reason ? [`Why: ${rec.workflow.reason}`] : []),
        ...(wf?.kind === "custom" ? [(wf as { reason: string }).reason ? `Reason: ${(wf as { reason: string }).reason}` : undefined].filter(Boolean) as string[] : []),
        ...(rec.whyNot?.filter((w) => w.area.toLowerCase().includes("workflow")).map((w) => `Not recommended: ${w.area} — ${w.reason}`) ?? []),
      ].filter(Boolean) as string[],
      details: wf?.kind === "custom" ? [`Stages: ${(wf as { workflow: { stages: Array<{ name: string }> } }).workflow.stages.map((s) => s.name).join(", ")}`] : undefined,
    },
    {
      id: "models",
      title: "3. Models",
      simpleTitle: "Which AI models Factory will use",
      kind: "recommendation",
      recommended: rec.models,
      lines: [
        ...(rec.models
          ? Object.entries(rec.models).map(([role, v]) => `${role}: ${v!.value.provider ? `${v!.value.provider}/` : ""}${v!.value.model} — ${v!.reason}`)
          : ["No model overrides — using Factory defaults (opus/sonnet)."]),
        "",
        "Why: Planning and review need more reasoning; most implementation is handled well by Sonnet.",
      ],
    },
    {
      id: "commands",
      title: "4. Commands and verification",
      simpleTitle: "How Factory checks the work",
      kind: "recommendation",
      recommended: rec.commands,
      lines: [
        ...Object.entries(rec.commands ?? {}).map(([k, v]) => {
          if (!v) return `${k}: none`;
          const flag = v.source === "DISCOVERED" ? "✓" : v.source === "AI_SUGGESTED" ? "?" : "·";
          return `${flag} ${k}: ${v.value} [${v.source}] — ${v.reason}${v.requiresConfirmation ? " (needs confirmation)" : ""}`;
        }),
        ...(rec.whyNot?.filter((w) => w.area.toLowerCase().includes("verification")).map((w) => `Skipped: ${w.area} — ${w.reason}`) ?? []),
      ],
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
      lines: [
        `Base branch: ${rec.git?.baseBranch?.value ?? ctx.effective?.git.baseBranch ?? "main"}`,
        `Worktrees: ${rec.git?.allowWorktrees?.value ?? ctx.effective?.git.allowWorktrees ? "Enabled" : "Disabled"} — keeps parallel work isolated`,
        `Keep completed workspaces: ${rec.git?.cleanup?.retainRuns?.value ?? ctx.effective?.git.cleanup.retainRuns ?? 10} runs`,
      ],
    },
    {
      id: "repair",
      title: "7. Repair",
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
      title: "8. Approvals — final merge",
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
      title: "9. Capabilities",
      simpleTitle: "What Factory is allowed to do",
      kind: "preference",
      recommended: rec.capabilities,
      lines: [
        ...(rec.capabilities?.allow?.length ? [`Allowed: ${rec.capabilities.allow.join(", ")}`] : ["Allowed: default (repo read/write, shell)"]),
        ...(rec.capabilities?.deny?.length ? [`Denied: ${rec.capabilities.deny.join(", ")}`] : []),
        ...(rec.whyNot?.filter((w) => w.area.toLowerCase().includes("production")).map((w) => `${w.area}: ${w.reason}${w.howToEnable ? ` — ${w.howToEnable}` : ""}`) ?? []),
      ],
    },
    {
      id: "taskRouting",
      title: "10. Task routing",
      simpleTitle: "How different kinds of work are routed",
      kind: "recommendation",
      recommended: rec.taskTypes,
      lines: rec.taskTypes?.length
        ? rec.taskTypes.map((t) => `• ${t.id} — ${t.reason}`)
        : ["Default routing (task type inferred from goal/files)."],
    },
    {
      id: "skills",
      title: "11. Skills",
      simpleTitle: "Extra capabilities for this project",
      kind: "recommendation",
      recommended: rec.skills,
      lines: rec.skills?.ids.length ? [`Skills: ${rec.skills.ids.join(", ")} — ${rec.skills.reason}`] : ["No extra skills recommended."],
    },
    {
      id: "dashboard",
      title: "12. Dashboard",
      simpleTitle: "Live progress dashboard",
      kind: "recommendation",
      recommended: rec.dashboard,
      lines: [
        `Dashboard: ${rec.dashboard?.enabled?.value ?? ctx.effective?.dashboard.enabled ? "Enabled" : "Disabled"}${rec.dashboard?.port?.value ? ` on :${rec.dashboard.port.value}` : ""}`,
        ...(rec.dashboard?.enabled?.reason ? [`Why: ${rec.dashboard.enabled.reason}`] : []),
      ],
    },
    {
      id: "constitution",
      title: "13. Constitution — living understanding",
      simpleTitle: "How Factory remembers this repo",
      kind: "recommendation",
      lines: [
        `${rec.constitution === "GENERATE" ? "Generate" : rec.constitution === "REFRESH" ? "Refresh" : "Keep"} the repository constitution (evidence-backed, not hand-written).`,
        "After setup, Factory keeps it healthy — Observe → Understand → Recommend → Ask → Record → Work → Refresh.",
        ...(rec.explanation.slice(0, 2).map((e) => `Why: ${e}`)),
      ],
    },
    {
      id: "finalReview",
      title: "14. Final review",
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

export function simpleEnglishLabel(field: string): string {
  const map: Record<string, string> = {
    "approval.finalMerge": "Ask before merging completed work?",
    "runtime.maxParallelAgents": "How many AI workers may work at once?",
    "git.cleanup.retainRuns": "How many completed run workspaces should Factory keep?",
    "git.allowWorktrees": "Isolate work with git worktrees?",
    "repair.maxAttempts": "How many repair attempts after verification fails?",
  };
  return map[field] ?? field;
}
