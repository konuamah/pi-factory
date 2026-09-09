import type { FactorySetupContext, FactorySetupRecommendation } from "@factory/schemas";
import { describeWorkflow, describeWorkflowLines, describeModelLines, describeCommandLines, describeGitLines, describeDependencyLines, describeCapabilityLines, describeDashboardLines, describeTaskRouting, describeSkills, describeConstitution } from "./setup-tui-describe.js";

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
