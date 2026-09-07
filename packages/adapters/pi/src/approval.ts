import type { PlanApprovalDecision, PlanApprovalResult } from "@factory/core";
import { charWidth } from "./types.js";
import type { FactoryPiUi } from "./types.js";

type PiThemeLike = {
  fg?: (color: string, text: string) => string;
  bg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
};

export interface PlanApprovalPreviewInput {
  runId: string;
  goal: string;
  planPath: string;
  taskCount: number;
  workflowStages: string[];
  summary: string;
  discoveryText?: string;
  planText?: string;
  tasks: Array<{ title: string; stage: string }>;
}

export function buildPlanApprovalPreviewLines(input: PlanApprovalPreviewInput): string[] {
  const discoveryLines = sanitizePlanText(input.discoveryText).split(/\r?\n/).filter(Boolean).slice(0, 18);
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
    "Discovery report",
    ...(discoveryLines.length > 0 ? discoveryLines : ["(discovery output unavailable)"]),
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
    const selected = await ui.custom<PlanApprovalDecision | undefined>((tui, theme, _keybindings, done) => {
      const dialog = new PlanApprovalDialog(input, theme, (decision) => done(decision), () => done(undefined), () => tui.requestRender());
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
    private readonly theme: unknown,
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
      ...this.lines.flatMap((line) => wrapStyledLine(styleApprovalLine(line, this.theme), width)),
      "",
      styleHeading("Decision", this.theme),
      ...this.options.map((option, index) => styleDecisionOption(option, index === this.selectedIndex, this.theme)),
      "",
      color(this.theme, "dim", "↑↓ navigate  enter select  a approve  r revise  x reject  esc cancel"),
    ].map((line) => truncateStyledLine(line, width));
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

function styleApprovalLine(line: string, theme: unknown): string {
  if (!line) {
    return line;
  }

  if (line === "Factory plan approval") {
    return color(theme, "accent", bold(theme, line));
  }
  if (["Decision options", "Discovery report", "Feature plan", "Runtime summary", "Workflow tasks"].includes(line)) {
    return styleHeading(line, theme);
  }

  const keyValue = /^([^:]{2,24}):\s*(.+)$/.exec(line);
  if (keyValue) {
    return `${color(theme, "muted", `${keyValue[1]}:`)} ${keyValue[2]}`;
  }

  if (line.startsWith("- Approve:")) {
    return color(theme, "success", line);
  }
  if (line.startsWith("- Request revisions:")) {
    return color(theme, "warning", line);
  }
  if (line.startsWith("- Reject:")) {
    return color(theme, "error", line);
  }
  if (line.startsWith("- [")) {
    const match = /^- \[([^\]]+)\]\s*(.+)$/.exec(line);
    if (match) {
      return `${color(theme, "dim", "-")} ${color(theme, "accent", `[${match[1]}]`)} ${match[2]}`;
    }
  }
  if (line.startsWith("- ")) {
    return `${color(theme, "dim", "-")} ${line.slice(2)}`;
  }
  if (/^\d+\.\s/.test(line)) {
    return color(theme, "accent", bold(theme, line));
  }
  return line;
}

function styleHeading(line: string, theme: unknown): string {
  return color(theme, "accent", bold(theme, line));
}

function styleDecisionOption(
  option: { label: string; decision: PlanApprovalDecision },
  selected: boolean,
  theme: unknown,
): string {
  const token = option.decision === "approve" ? "success" : option.decision === "revise" ? "warning" : "error";
  const marker = selected ? ">" : " ";
  const label = selected ? bold(theme, option.label) : option.label;
  const line = `${marker} ${label}`;
  return selected ? color(theme, token, line) : color(theme, "muted", line);
}

function color(theme: unknown, token: string, value: string): string {
  const piTheme = theme as PiThemeLike | undefined;
  return typeof piTheme?.fg === "function" ? piTheme.fg(token, value) : value;
}

function bold(theme: unknown, value: string): string {
  const piTheme = theme as PiThemeLike | undefined;
  return typeof piTheme?.bold === "function" ? piTheme.bold(value) : value;
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

export interface FinalApprovalReviewerVerdict {
  verdict: "block" | "pass" | "unknown";
  summary: string;
}

/**
 * Lines rendered at the final approval gate when a reviewer verdict exists.
 * A blocking verdict is called out explicitly so approving is an override.
 */
export function buildReviewerFindingLines(reviewerVerdict?: FinalApprovalReviewerVerdict): string[] {
  if (!reviewerVerdict) return [];
  const summaryLines = (reviewerVerdict.summary ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 14);
  return [
    "Factory approval — reviewer finding",
    `reviewer verdict: ${reviewerVerdict.verdict}`,
    "",
    ...summaryLines,
    "",
    reviewerVerdict.verdict === "block"
      ? "The reviewer is NOT ready for approval. Approving overrides that finding."
      : "The reviewer text above is provided for your decision.",
  ];
}

/**
 * Confirm prompt/body for the final approval gate. A blocking reviewer verdict
 * takes precedence over baseline-debt and scope warnings so the human is asked
 * to explicitly override it.
 */
export function resolveFinalApprovalConfirm(
  input: { runId: string; goal: string; hasBaselineDebt: boolean; hasScopeWarnings: boolean },
  reviewerVerdict?: FinalApprovalReviewerVerdict,
): { prompt: string; body: string } {
  const block = reviewerVerdict?.verdict === "block";
  const prompt = block
    ? "Approve candidate despite the reviewer blocking verdict?"
    : input.hasBaselineDebt
      ? "Approve candidate despite baseline debt?"
      : input.hasScopeWarnings
        ? "Approve candidate despite scope warnings?"
        : "Approve Factory candidate?";
  const body = [
    `Approve prototype run ${input.runId} for goal: ${input.goal}`,
    block ? "\n\nThe reviewer is NOT ready for approval. Only approve with explicit override intent." : "",
    input.hasBaselineDebt ? "\n\nBaseline debt shown above is NOT resolved by this run." : "",
    input.hasScopeWarnings ? "\n\nScope warnings shown above are NOT resolved by approving." : "",
  ].join("");
  return { prompt, body };
}

/**
 * Default when no confirm UI exists: never silently auto-approve past a
 * blocking reviewer verdict. "pass", "unknown", and absent verdicts keep the
 * historical auto-approve default for headless/benchmark flows.
 */
export function defaultFinalApproval(reviewerVerdict?: FinalApprovalReviewerVerdict): boolean {
  return reviewerVerdict?.verdict !== "block";
}

export function isPlanApprovalDecision(value: string | undefined): value is PlanApprovalDecision {
  return value === "approve" || value === "reject" || value === "revise";
}

function truncateStyledLine(value: string, width: number): string {
  if (visibleWidth(value) <= width) {
    return value;
  }
  if (width <= 1) {
    return sliceStyledLine(value, width).text;
  }
  return `${sliceStyledLine(value, width - 1).text}…${resetAnsi(value)}`;
}

function wrapStyledLine(value: string, width: number): string[] {
  if (width <= 0) {
    return [""];
  }
  const results: string[] = [];
  let remaining = value;
  while (visibleWidth(remaining) > width) {
    const sliced = sliceStyledLine(remaining, width);
    results.push(`${sliced.text}${resetAnsi(remaining)}`);
    remaining = sliced.remaining;
  }
  results.push(remaining);
  return results;
}

function sliceStyledLine(value: string, maxWidth: number): { text: string; remaining: string } {
  let width = 0;
  let index = 0;
  for (const part of ansiAwareParts(value)) {
    if (part.ansi) {
      index += part.text.length;
      continue;
    }
    for (const char of part.text) {
      const nextWidth = width + charWidth(char);
      if (nextWidth > maxWidth) {
        return { text: value.slice(0, index), remaining: value.slice(index) };
      }
      width = nextWidth;
      index += char.length;
    }
  }
  return { text: value, remaining: "" };
}

function visibleWidth(value: string): number {
  let width = 0;
  for (const part of ansiAwareParts(value)) {
    if (part.ansi) {
      continue;
    }
    for (const char of part.text) {
      width += charWidth(char);
    }
  }
  return width;
}

function ansiAwareParts(value: string): Array<{ text: string; ansi: boolean }> {
  const parts: Array<{ text: string; ansi: boolean }> = [];
  const ansiPattern = /\u001b\[[0-?]*[ -/]*[@-~]/g;
  let lastIndex = 0;
  for (const match of value.matchAll(ansiPattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push({ text: value.slice(lastIndex, index), ansi: false });
    }
    parts.push({ text: match[0], ansi: true });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < value.length) {
    parts.push({ text: value.slice(lastIndex), ansi: false });
  }
  return parts;
}

function resetAnsi(value: string): string {
  return /\u001b\[[0-?]*[ -/]*m/.test(value) ? "\u001b[0m" : "";
}

