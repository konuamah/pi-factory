import path from "node:path";
import type {
  FactoryPiEventContext,
  FactoryPiExtensionApiLike,
  FactoryPiToolEvent,
} from "./types.js";

export type SupervisoryPiTurnKind =
  | "inspect"
  | "plan"
  | "implement"
  | "verify"
  | "repair"
  | "review"
  | "general";

export interface SupervisoryPiDecision {
  kind: SupervisoryPiTurnKind;
  modelRole: "discovery" | "planner" | "builder" | "reviewer" | "repair";
  skillHints: string[];
  verificationHints: string[];
  reminders: string[];
}

export interface SupervisoryPiSessionState {
  lastInput?: string;
  lastDecision?: SupervisoryPiDecision;
  selectedModel?: string;
  touchedFiles: string[];
  observedChecks: string[];
  failures: string[];
}

const IMPLEMENT_RE = /\b(add|build|create|implement|change|update|wire|fix|remove|refactor|edit)\b/i;
const VERIFY_RE = /\b(test|verify|check|lint|build|typecheck|smoke|e2e|failing|failure|failed|broken)\b/i;
const PLAN_RE = /\b(plan|design|approach|architecture|strategy|how should|what should)\b/i;
const REVIEW_RE = /\b(review|audit|inspect diff|find bugs|risk)\b/i;
const INSPECT_RE = /\b(check|inspect|look at|why|diagnose|status|logs?)\b/i;

export function createSupervisoryPiSessionState(): SupervisoryPiSessionState {
  return {
    touchedFiles: [],
    observedChecks: [],
    failures: [],
  };
}

export function decideSupervisoryPiTurn(input: string): SupervisoryPiDecision {
  const normalized = input.trim();
  const kind = classifyTurn(normalized);
  const modelRole = roleForKind(kind);
  return {
    kind,
    modelRole,
    skillHints: skillHintsFor(kind, normalized),
    verificationHints: verificationHintsFor(kind, normalized),
    reminders: remindersFor(kind),
  };
}

export function buildSupervisoryTurnContract(decision: SupervisoryPiDecision, state: SupervisoryPiSessionState): string {
  const lines = [
    "Pi supervisory guidance:",
    `- Turn kind: ${decision.kind}`,
    `- Suggested model role: ${decision.modelRole}`,
  ];

  if (decision.skillHints.length > 0) {
    lines.push(`- Relevant skill hints: ${decision.skillHints.join(", ")}`);
  }
  if (decision.verificationHints.length > 0) {
    lines.push(`- Verification hints: ${decision.verificationHints.join(", ")}`);
  }
  if (state.touchedFiles.length > 0) {
    lines.push(`- Files touched this session: ${state.touchedFiles.slice(-8).join(", ")}`);
  }
  for (const reminder of decision.reminders) {
    lines.push(`- ${reminder}`);
  }

  return lines.join("\n");
}

export function observeSupervisoryToolCall(state: SupervisoryPiSessionState, event: FactoryPiToolEvent): void {
  const name = event.toolName ?? event.name ?? "";
  const command = event.command ?? stringFromInputCommand(event.input);
  if (name.includes("write") || name.includes("edit")) {
    const file = fileFromEvent(event);
    if (file) addUnique(state.touchedFiles, file);
  }
  if (command && looksLikeCheck(command)) {
    addUnique(state.observedChecks, command);
  }
}

export function observeSupervisoryToolResult(state: SupervisoryPiSessionState, event: FactoryPiToolEvent): void {
  const failed = event.status === "failed" || event.isError === true || Boolean(event.error);
  if (!failed) return;
  const label = event.command ?? stringFromInputCommand(event.input) ?? event.toolName ?? event.name ?? "tool";
  addUnique(state.failures, String(label));
}

export function renderSupervisoryPiStatus(state: SupervisoryPiSessionState): string {
  const decision = state.lastDecision;
  return [
    "Pi supervisor status",
    `turn: ${decision?.kind ?? "none"}`,
    `model role: ${decision?.modelRole ?? "none"}`,
    `selected model: ${state.selectedModel ?? "current Pi model"}`,
    `skill hints: ${decision?.skillHints.join(", ") || "none"}`,
    `verification hints: ${decision?.verificationHints.join(", ") || "none"}`,
    `touched files: ${state.touchedFiles.join(", ") || "none"}`,
    `observed checks: ${state.observedChecks.join(", ") || "none"}`,
    `failures: ${state.failures.join(", ") || "none"}`,
  ].join("\n");
}

export function registerSupervisoryPiHooks(
  pi: FactoryPiExtensionApiLike,
  options: { cwd?: string } = {},
): SupervisoryPiSessionState {
  assertSupervisoryPiApi(pi);
  const state = createSupervisoryPiSessionState();

  pi.registerCommand("supervisor", {
    description: "Inspect Pi supervisor session state",
    handler: async (_args, ctx) => {
      ctx.ui.notify(renderSupervisoryPiStatus(state), "info");
    },
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    const decision = decideSupervisoryPiTurn(event.text);
    state.lastInput = event.text;
    state.lastDecision = decision;
    const modelSelection = await resolveSuggestedModel(options.cwd ?? ctx.cwd ?? process.cwd(), decision.modelRole);
    const model = resolvePiModel(ctx, modelSelection);
    if (model) {
      const switched = await pi.setModel(model);
      state.selectedModel = switched ? `${modelSelection?.provider}/${modelSelection?.model}` : "switch failed";
    }
    return {
      action: "transform",
      text: `${event.text}\n\n${buildSupervisoryTurnContract(decision, state)}`,
      images: event.images,
    };
  });

  pi.on("before_agent_start", (_event, ctx) => {
    const decision = state.lastDecision;
    if (!decision) return;
    ctx.ui.notify(`Supervisor: ${decision.kind} turn using ${decision.modelRole} guidance`, "info");
  });

  pi.on("tool_call", (event) => observeSupervisoryToolCall(state, event));
  pi.on("tool_result", (event) => observeSupervisoryToolResult(state, event));
  pi.on("agent_end", (_event, ctx) => {
    if (state.failures.length === 0) return;
    ctx.ui.notify(`Supervisor observed ${state.failures.length} failing tool result(s)`, "warning");
  });

  return state;
}

function classifyTurn(input: string): SupervisoryPiTurnKind {
  if (REVIEW_RE.test(input)) return "review";
  if (VERIFY_RE.test(input)) return input.match(/\bfix|repair|failed|failure|broken\b/i) ? "repair" : "verify";
  if (IMPLEMENT_RE.test(input)) return "implement";
  if (PLAN_RE.test(input)) return "plan";
  if (INSPECT_RE.test(input)) return "inspect";
  return "general";
}

function roleForKind(kind: SupervisoryPiTurnKind): SupervisoryPiDecision["modelRole"] {
  switch (kind) {
    case "inspect":
      return "discovery";
    case "plan":
    case "verify":
    case "general":
      return "planner";
    case "implement":
      return "builder";
    case "repair":
      return "repair";
    case "review":
      return "reviewer";
  }
}

function skillHintsFor(kind: SupervisoryPiTurnKind, input: string): string[] {
  const hints: string[] = [];
  if (kind === "implement" || kind === "repair") hints.push("repo-specific implementation guidance");
  if (kind === "verify" || kind === "repair") hints.push("test and failure-classification guidance");
  if (/\bsecurity|auth|token|permission|secret\b/i.test(input)) hints.push("security guidance");
  if (/\bfrontend|ui|navbar|page|component|css\b/i.test(input)) hints.push("frontend guidance");
  return hints.slice(0, 3);
}

function verificationHintsFor(kind: SupervisoryPiTurnKind, input: string): string[] {
  const hints: string[] = [];
  if (/\bfrontend|ui|navbar|page|component|css\b/i.test(input)) hints.push("prefer lint/typecheck/build before browser smoke");
  if (/\bpython|pytest|django|flask|fastapi\b/i.test(input)) hints.push("prefer targeted Python tests with hard timeouts");
  if (kind === "implement") hints.push("defer authoritative verification until edits settle");
  if (kind === "repair") hints.push("re-run only the failed or directly affected checks first");
  return hints;
}

function remindersFor(kind: SupervisoryPiTurnKind): string[] {
  if (kind === "implement") {
    return [
      "Implement the requested change, then report the narrow checks that should prove it.",
      "Do not start persistent servers unless the session will manage cleanup.",
    ];
  }
  if (kind === "verify") {
    return ["Classify each check as passed, failed, timed out, or blocked by environment."];
  }
  if (kind === "repair") {
    return ["Repair should respond to concrete failing evidence and keep the retry scoped."];
  }
  return [];
}

function assertSupervisoryPiApi(pi: FactoryPiExtensionApiLike): void {
  const missing = [
    "setModel",
    "on",
  ].filter((name) => typeof (pi as unknown as Record<string, unknown>)[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`Pi supervisory extension requires lifecycle hooks: missing ${missing.join(", ")}`);
  }
}

async function resolveSuggestedModel(
  cwd: string,
  role: SupervisoryPiDecision["modelRole"],
): Promise<{ provider?: string; model: string } | undefined> {
  try {
    const core = (await import("@factory/core")) as unknown as {
      loadEffectiveConfig: (o: { cwd: string }) => Promise<{ effectiveConfig: unknown }>;
      resolveModelForRole: (
        config: unknown,
        role: SupervisoryPiDecision["modelRole"],
        taskType?: string,
      ) => { provider?: string; model: string };
    };
    const loaded = await core.loadEffectiveConfig({ cwd });
    return core.resolveModelForRole({ config: loaded.effectiveConfig, role, taskType: "general" }).model;
  } catch {
    // No model configured for this role (or no config): stay on the current
    // Pi model per the supervisory plan (warn, never block). The caller warns.
    return undefined;
  }
}

function resolvePiModel(
  ctx: FactoryPiEventContext,
  selection: { provider?: string; model: string } | undefined,
): unknown {
  if (!selection?.provider) return undefined;
  return ctx.modelRegistry?.find(selection.provider, selection.model);
}

function fileFromEvent(event: FactoryPiToolEvent): string | undefined {
  const input = event.input;
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const candidate = record.path ?? record.file ?? record.filePath;
  return typeof candidate === "string" ? candidate : undefined;
}

function stringFromInputCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}

function looksLikeCheck(command: string): boolean {
  return /\b(test|lint|typecheck|tsc|pytest|vitest|jest|playwright|build)\b/.test(command);
}

function addUnique(values: string[], value: string): void {
  const normalized = normalizePathish(value);
  if (!values.includes(normalized)) values.push(normalized);
}

function normalizePathish(value: string): string {
  return value.includes(path.sep) ? path.normalize(value) : value.trim();
}
