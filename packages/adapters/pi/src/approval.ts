import type { PlanApprovalDecision, PlanApprovalResult } from "@factory/core";
import type { FactoryPiUi } from "./types.js";

export interface PlanApprovalPreviewInput {
  runId: string;
  goal: string;
  planPath: string;
  taskCount: number;
  workflowStages: string[];
  summary: string;
  planText?: string;
  tasks: Array<{ title: string; stage: string }>;
}

export function buildPlanApprovalPreviewLines(input: PlanApprovalPreviewInput): string[] {
  const planLines = sanitizePlanText(input.planText).split(/\r?\n/).filter(Boolean).slice(0, 16);
  const summaryLines = input.summary.split(/\r?\n/).filter(Boolean).slice(0, 6);
  const taskLines = input.tasks.slice(0, 6).map((task) => `- [${task.stage}] ${task.title}`);
  const remainingTasks = Math.max(0, input.taskCount - taskLines.length);

  return [
    "Factory plan approval",
    `Run: ${input.runId}`,
    `Goal: ${input.goal}`,
    `Tasks: ${input.taskCount}`,
    `Stages: ${input.workflowStages.join(" -> ")}`,
    `Plan artifact: ${input.planPath}`,
    "",
    "Decision options",
    "- Approve: continue to implementation",
    "- Request revisions: pause before implementation",
    "- Reject: cancel this run",
    "",
    "Feature plan",
    ...(planLines.length > 0 ? planLines : ["(planner output unavailable; showing fallback summary below)"]),
    "",
    "Runtime summary",
    ...(summaryLines.length > 0 ? summaryLines : ["(no summary)"]),
    "",
    "Workflow tasks",
    ...(taskLines.length > 0 ? taskLines : ["- (no tasks)"]),
    ...(remainingTasks > 0 ? [`- ... and ${remainingTasks} more`] : []),
  ];
}

export async function requestPlanApprovalDecision(
  ui: FactoryPiUi,
  input: PlanApprovalPreviewInput,
): Promise<PlanApprovalResult> {
  if (ui.custom) {
    const selected = await ui.custom<PlanApprovalDecision | undefined>((tui, _theme, _keybindings, done) => {
      const dialog = new PlanApprovalDialog(input, (decision) => done(decision), () => done(undefined), () => tui.requestRender());
      return {
        render: (width) => dialog.render(width),
        handleInput: (data) => dialog.handleInput(data),
        invalidate: () => dialog.invalidate(),
      };
    });

    if (selected === "approve") {
      return { decision: "approve" };
    }
    if (selected === "revise" || selected === "reject") {
      const feedback = await ui.input?.(
        selected === "revise" ? "Revision feedback" : "Rejection feedback",
        "Optional short feedback",
      );
      return { decision: selected, feedback: normalizeFeedback(feedback) };
    }
    return {
      decision: "revise",
      feedback: "Plan decision dismissed; leaving run paused for human follow-up.",
    };
  }

  if (ui.select) {
    const selected = await ui.select("Factory plan decision", [
      "Approve — Continue to implementation",
      "Request revisions — Pause before implementation and record feedback",
      "Reject — Cancel the run before implementation",
    ]);

    if (selected?.startsWith("Approve")) {
      return { decision: "approve" };
    }

    if (selected?.startsWith("Request revisions") || selected?.startsWith("Reject")) {
      const feedback = await ui.input?.(
        selected.startsWith("Request revisions") ? "Revision feedback" : "Rejection feedback",
        "Optional short feedback",
      );
      return {
        decision: selected.startsWith("Request revisions") ? "revise" : "reject",
        feedback: normalizeFeedback(feedback),
      };
    }

    return {
      decision: "revise",
      feedback: "Plan decision dismissed; leaving run paused for human follow-up.",
    };
  }

  if (ui.confirm) {
    const approved = await ui.confirm(
      "Approve Factory plan?",
      [
        `Run: ${input.runId}`,
        `Goal: ${input.goal}`,
        `Tasks: ${input.taskCount}`,
        `Stages: ${input.workflowStages.join(" -> ")}`,
        `Plan: ${input.planPath}`,
        "",
        ...sanitizePlanText(input.planText).split(/\r?\n/).filter(Boolean).slice(0, 8),
        "",
        "Approve to continue to implementation.",
        "Reject to cancel this run.",
      ].join("\n"),
    );
    return { decision: approved ? "approve" : "reject" };
  }

  return { decision: "approve" };
}

class PlanApprovalDialog {
  private readonly lines: string[];
  private readonly options: Array<{ label: string; decision: PlanApprovalDecision }> = [
    { label: "Approve — Continue to implementation", decision: "approve" },
    { label: "Request revisions — Pause before implementation", decision: "revise" },
    { label: "Reject — Cancel the run", decision: "reject" },
  ];
  private selectedIndex = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    input: PlanApprovalPreviewInput,
    private readonly onSelect: (decision: PlanApprovalDecision) => void,
    private readonly onCancel: () => void,
    private readonly onChange: () => void,
  ) {
    this.lines = buildPlanApprovalPreviewLines(input);
  }

  handleInput(data: string): void {
    if (data === "\u001b[A") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.invalidateAndRender();
      return;
    }
    if (data === "\u001b[B") {
      this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
      this.invalidateAndRender();
      return;
    }
    if (data === "\r") {
      this.onSelect(this.options[this.selectedIndex]!.decision);
      return;
    }
    if (data === "a") {
      this.onSelect("approve");
      return;
    }
    if (data === "r") {
      this.onSelect("revise");
      return;
    }
    if (data === "x") {
      this.onSelect("reject");
      return;
    }
    if (data === "\u001b" || data === "\u0003") {
      this.onCancel();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const rendered = [
      ...this.lines.flatMap((line) => wrap(line, width)),
      "",
      "Decision",
      ...this.options.map((option, index) => `${index === this.selectedIndex ? ">" : " "} ${option.label}`),
      "",
      "↑↓ navigate  enter select  a approve  r revise  x reject  esc cancel",
    ].map((line) => truncate(line, width));
    this.cachedLines = rendered;
    this.cachedWidth = width;
    return rendered;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private invalidateAndRender(): void {
    this.invalidate();
    this.onChange();
  }
}

function sanitizePlanText(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\bWAITING_FOR_APPROVAL\b\s*$/m, "").trim();
}

function normalizeFeedback(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function isPlanApprovalDecision(value: string | undefined): value is PlanApprovalDecision {
  return value === "approve" || value === "reject" || value === "revise";
}

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  if (width <= 1) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 1)}…`;
}

function wrap(value: string, width: number): string[] {
  if (width <= 0) {
    return [""];
  }
  const results: string[] = [];
  let remaining = value;
  while (remaining.length > width) {
    results.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }
  results.push(remaining);
  return results;
}
