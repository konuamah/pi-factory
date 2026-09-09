import type { AgentExecutionInput, AgentExecutor } from "./interfaces.js";
import type { FailureRecoveryContext } from "./failure-recovery.js";

export type RecoveryOptionId = "retry" | "repair" | "revise" | "stop";

export interface RecoveryOptionView {
  id: RecoveryOptionId;
  label: string;
  description?: string;
}

export interface RecoveryNarration {
  title: string;
  problem: string;
  howToRecover: string;
  options: RecoveryOptionView[];
}

export interface RecoveryNarratorInput {
  runId: string;
  phase: string;
  context: FailureRecoveryContext;
  enabledOptions: ReadonlyArray<RecoveryOptionId>;
  executor?: AgentExecutor;
  model?: { provider?: string; model: string };
  limits?: AgentExecutionInput["limits"];
}

const OPTION_IDS: RecoveryOptionId[] = ["retry", "repair", "revise", "stop"];
const LIMITS = { title: 80, problem: 600, howToRecover: 240, label: 60, description: 200 };
const cache = new Map<string, RecoveryNarration>();

export function buildRecoveryNarrationPrompt(input: RecoveryNarratorInput): string {
  return [
    "Write concise English copy for a Factory runtime recovery dialog.",
    "Return strict JSON only. You may write prose and labels, but never invent option ids or actions.",
    JSON.stringify({
      title: "failure headline, 80 chars maximum",
      problem: "plain-language explanation, 600 chars maximum",
      howToRecover: "what the user can do, 240 chars maximum",
      options: [{ id: "retry", label: "short choice label", description: "optional explanation" }],
    }),
    `Allowed option ids: ${JSON.stringify(input.enabledOptions)}`,
    `Phase: ${input.phase}`,
    JSON.stringify({
      category: input.context.category,
      attempt: input.context.attempt,
      maxAttempts: input.context.maxAttempts ?? 3,
      title: input.context.title,
      reason: input.context.reason,
      evidenceRefs: (input.context.evidenceRefs ?? []).slice(0, 8),
    }, null, 2),
  ].join("\n");
}

export function fallbackRecoveryNarration(
  context: FailureRecoveryContext,
  enabledOptions: ReadonlyArray<RecoveryOptionId> = OPTION_IDS,
): RecoveryNarration {
  const copy: Record<RecoveryOptionId, RecoveryOptionView> = {
    retry: { id: "retry", label: "I fixed it; retry this phase", description: "Re-run this phase after your fix." },
    repair: { id: "repair", label: "Let Factory repair and retry", description: "Let Factory diagnose and fix the failure automatically." },
    revise: { id: "revise", label: "Revise with my guidance", description: "Re-run with your free-text guidance." },
    stop: { id: "stop", label: "Stop and preserve the failure", description: "Pause the run and keep the artifacts." },
  };
  const safeOptions: ReadonlyArray<RecoveryOptionId> = Array.isArray(enabledOptions) ? enabledOptions as RecoveryOptionId[] : ["stop"];
  const options = [...new Set(safeOptions)].filter((id) => OPTION_IDS.includes(id)).map((id) => copy[id]);
  if (!options.some((option) => option.id === "stop")) options.push(copy.stop);
  return {
    title: `Factory needs help: ${context.title}`,
    problem: context.reason,
    howToRecover: "Fix the issue if needed, then choose how Factory should continue.",
    options,
  };
}

export async function narrateRecovery(input: RecoveryNarratorInput): Promise<RecoveryNarration> {
  const enabledOptions = input.enabledOptions ?? ["stop"];
  const safeInput = { ...input, enabledOptions };
  const key = `${input.runId}::${input.phase}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const fallback = fallbackRecoveryNarration(input.context, enabledOptions);
  if (!input.executor) {
    cache.set(key, fallback);
    return fallback;
  }
  try {
    const result = await input.executor.execute({
      executionId: `recovery-narrator-${Date.now()}`,
      cwd: process.cwd(),
      prompt: buildRecoveryNarrationPrompt(safeInput),
      model: input.model,
      tools: [],
      limits: input.limits,
      metadata: { role: "reviewer", stage: "recovery-narration" },
    });
    const parsed = parseJson(result.outputText);
    const narration = sanitize(parsed, safeInput, fallback);
    cache.set(key, narration);
    return narration;
  } catch {
    cache.set(key, fallback);
    return fallback;
  }
}

function parseJson(value: string): Record<string, unknown> | undefined {
  const text = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? value;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; } catch { return undefined; }
}

function sanitize(parsed: Record<string, unknown> | undefined, input: RecoveryNarratorInput, fallback: RecoveryNarration): RecoveryNarration {
  if (!parsed) return fallback;
  const raw = Array.isArray(parsed.options) ? parsed.options : [];
  const seen = new Set<RecoveryOptionId>();
  const options: RecoveryOptionView[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    const id = typeof value.id === "string" ? value.id.toLowerCase() as RecoveryOptionId : undefined;
    if (!id || !OPTION_IDS.includes(id) || !input.enabledOptions.includes(id) || seen.has(id)) continue;
    const fallbackOption = fallback.options.find((option) => option.id === id)!;
    const label = trimText(typeof value.label === "string" ? value.label : fallbackOption.label, LIMITS.label);
    const description = typeof value.description === "string" && value.description.trim()
      ? trimText(value.description, LIMITS.description) : undefined;
    options.push(description ? { id, label, description } : { id, label });
    seen.add(id);
  }
  if (!seen.has("stop")) options.push(fallback.options.find((option) => option.id === "stop")!);
  for (const option of fallback.options) {
    if (options.length >= 2 || seen.has(option.id)) continue;
    options.push(option);
    seen.add(option.id);
  }
  if (options.length < 2) return fallback;
  return {
    title: trimText(typeof parsed.title === "string" && parsed.title.trim() ? parsed.title : fallback.title, LIMITS.title),
    problem: trimText(typeof parsed.problem === "string" && parsed.problem.trim() ? parsed.problem : fallback.problem, LIMITS.problem),
    howToRecover: trimText(typeof parsed.howToRecover === "string" && parsed.howToRecover.trim() ? parsed.howToRecover : fallback.howToRecover, LIMITS.howToRecover),
    options,
  };
}

function trimText(value: string, limit: number): string {
  return value.length <= limit ? value.trim() : `${value.trim().slice(0, limit - 1)}…`;
}

export function __resetRecoveryNarratorCacheForTests(): void { cache.clear(); }
