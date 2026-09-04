// Pillar scorers. Each returns score + components + warnings, and score is null
// when the run artifacts cannot prove the pillar — a null is excluded from the
// weighted overall (weights renormalize) rather than counted as zero, per
// docs/factory/bombsite-benchmark-plan.md.

import type { RunArtifacts } from "../runs/artifacts-read.js";
import type { BenchmarkTaskSpec, PillarResult } from "./types.js";
import type { RunTiming } from "./types.js";

const clamp = (value: number): number => Math.max(0, Math.min(1, value));

const average = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

const numeric = (components: Record<string, number | null>): number[] =>
  Object.values(components).filter((value): value is number => typeof value === "number");

function interviewDecisionAnswerText(round: RunArtifacts["interviewDecisions"][number]): string {
  if (round.questions?.length) {
    return round.questions.map((question) => question.finalAnswer).join(" ");
  }
  return round.answer ?? "";
}

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((word) => word.length >= 4);
}

/** Fraction of expected topics that appear in the haystack (case-insensitive). */
function topicCoverage(topics: string[], haystack: string): number {
  if (topics.length === 0) {
    return 1;
  }
  const lower = haystack.toLowerCase();
  const hits = topics.filter((topic) => lower.includes(topic.toLowerCase())).length;
  return hits / topics.length;
}

export function scoreInterview(artifacts: RunArtifacts, spec: BenchmarkTaskSpec): PillarResult {
  const warnings: string[] = [];
  const rounds = artifacts.interviewDecisions;
  const roundCount = rounds.length;
  const required = spec.interviewRequired;

  if (!required) {
    return { score: null, components: { roundCount, required: 0 }, warnings: ["task does not require an interview; pillar not measured"] };
  }

  // presence
  const presence = roundCount > 0 ? 1 : 0;
  if (roundCount === 0) {
    warnings.push("workflow requires an interview but no interview decisions were recorded");
  }

  // relevance: did the round ask about the topics the task says are open questions?
  // Questions are matched on topic words, answers are excluded here to avoid
  // rewarding an answer that merely echoed the question text.
  const questions = rounds.map((round) => round.question).join("\n");
  const relevance = spec.expectedTopics && spec.expectedTopics.length > 0
    ? topicCoverage(spec.expectedTopics, questions)
    : null;
  if (relevance === null) {
    warnings.push("no expectedTopics in the task spec; interview relevance not measurable");
  }

  // efficiency: rounds inside the expected band, penalizing both directions.
  const bounds = spec.expectedInterviewRounds ?? {};
  const min = bounds.min ?? 1;
  const max = bounds.max ?? 2;
  let efficiency: number;
  if (roundCount === 0) {
    efficiency = 0;
  } else if (roundCount < min) {
    efficiency = clamp(roundCount / min);
    warnings.push(`interview asked ${roundCount} round(s); expected at least ${min}`);
  } else if (roundCount > max) {
    efficiency = clamp(max / roundCount);
    warnings.push(`interview ran ${roundCount} round(s); expected at most ${max}`);
  } else {
    efficiency = 1;
  }

  // scope control: an answer stating a non-goal should survive.
  const answers = rounds.map((round) => interviewDecisionAnswerText(round)).join("\n");
  const scopeControl = spec.expectedTopics && spec.expectedTopics.length > 0
    ? topicCoverage(spec.expectedTopics, answers)
    : null;

  const components: Record<string, number | null> = { roundCount, required: 1, presence, relevance, efficiency, scopeControl };
  const measurable = numeric(components);
  const score = measurable.length === 0 ? null : average(measurable);
  if (score === null) {
    warnings.push("no interview signals were derivable");
  }
  return { score, components, warnings };
}

export function scoreHandoff(artifacts: RunArtifacts, spec: BenchmarkTaskSpec): PillarResult {
  const warnings: string[] = [];
  const components: Record<string, number | null> = {};
  const plan = artifacts.plan;

  if (!plan) {
    return { score: null, components: {}, warnings: ["plan.json missing; handoff quality not measurable"] };
  }

  // discovery -> interview: did discovery evidence exist before interviewing?
  components.discoveryToInterview = artifacts.discoveryExecution?.status === "completed" ? 1 : 0;

  // interview -> plan: do chosen answers reappear in plan text? Round-level only.
  const planText = [plan.summary, plan.planText ?? ""].join("\n");
  const answers = artifacts.interviewDecisions.map((round) => interviewDecisionAnswerText(round));
  const answerWords = answers.join(" ");
  const questionWords = artifacts.interviewDecisions.map((round) => round.question).join(" ");
  // Distinctive words are those in the answer that are NOT in the question; an
  // answer that merely echoed the question contributes nothing (verified field
  // behavior: the human pasted the questions back with "A1: yes").
  const questionTokenSet = new Set(tokens(questionWords));
  const distinctive = tokens(answerWords).filter((word) => !questionTokenSet.has(word));
  if (!spec.interviewRequired || artifacts.interviewDecisions.length === 0) {
    components.interviewToPlan = null;
    warnings.push(spec.interviewRequired ? "no interview decisions recorded" : "no interview for this task");
  } else if (distinctive.length === 0) {
    // Observed in the field: an interviewee who accepts every recommendation answers
    // "A1: yes" after echoing the question, so no distinctive token survives. Content
    // overlap cannot prove continuity here, and "a plan exists" would be a fake pass -
    // report unmeasurable and let the weight renormalize.
    components.interviewToPlan = null;
    warnings.push("interview answers were confirmations only (no content beyond the questions); interview-to-plan continuity not measurable");
  } else {
    const carried = distinctive.filter((word) => planText.toLowerCase().includes(word)).length;
    components.interviewToPlan = clamp(carried / distinctive.length);
  }

  // plan -> builder: were the plan's build-stage tasks actually executed?
  // The plan artifact's task statuses are never updated after planning (build
  // /verify/review/approval stay "pending" even on success) — execution lives
  // in completed-tasks.json, so measure execution, not plan status. A plan
  // task is "carried" when a completed task with the same id exists.
  const tasks = plan.tasks ?? [];
  const executedTaskIds = new Set(artifacts.completedTasks.map((task) => task.taskId));
  const buildTasks = tasks.filter((task) => task.stage === "build" || task.type === "builder" || task.role === "builder");
  const executedBuild = buildTasks.length > 0
    ? clamp(buildTasks.filter((task) => executedTaskIds.has(task.id)).length / buildTasks.length)
    : tasks.length === 0
      ? 0
      : artifacts.completedTasks.length > 0 ? 1 : 0;
  components.planToBuilder = tasks.length === 0 ? 0 : executedBuild;
  if (buildTasks.length > 0 && executedBuild < 1 && artifacts.completedTasks.length === 0) {
    warnings.push("plan declared build tasks but no completed task records execution");
  }

  // landing scope: did the landing plan ship files the task marked as
  // forbidden (interview/plan non-goals), and did it ship exactly what was
  // built? Both are null when there is no landing evidence, never coerced to 0.
  const landingPlan = artifacts.landingPlan;
  const landingExpected = landingPlan?.expectedFiles ?? [];
  if (!landingPlan) {
    components.nonGoalsSurviveToLanding = null;
    components.landingMatchesBuild = null;
    warnings.push("landing-plan.json missing; landing scope not measurable");
  } else {
    const forbidden = (spec.forbiddenFiles ?? []).map((file) => file.replace(/\\/g, "/"));
    if (forbidden.length === 0) {
      components.nonGoalsSurviveToLanding = null;
      warnings.push("no forbiddenFiles in the task spec; non-goal survival not measurable");
    } else {
      const forbiddenHits = landingExpected.filter((file) =>
        forbidden.some((forbiddenFile) => file === forbiddenFile || file.startsWith(`${forbiddenFile}/`)),
      );
      components.nonGoalsSurviveToLanding = forbiddenHits.length === 0 ? 1 : 0;
      if (forbiddenHits.length) {
        warnings.push(`landing planned files outside forbidden set: ${forbiddenHits.join(", ")}`);
      }
    }
    const builtFiles = new Set(artifacts.completedTasks.flatMap((task) => task.changedFiles ?? []).map((file) => file.replace(/\\/g, "/")));
    if (landingExpected.length === 0 || builtFiles.size === 0) {
      components.landingMatchesBuild = null;
      warnings.push("no landing expectedFiles or no built files; landing-build match not measurable");
    } else {
      const outside = landingExpected.filter((file) => !builtFiles.has(file));
      components.landingMatchesBuild = outside.length === 0 ? 1 : 0;
      if (outside.length) {
        warnings.push(`landing planned files not in the built set: ${outside.join(", ")}`);
      }
    }
  }

  // verification context completeness — contract PASS on zero requirements is
  // explicitly NOT treated as evidence.
  const verification = artifacts.verification ?? {};
  const contract = verification.contract as { requirements?: unknown[]; results?: unknown[]; overallStatus?: string } | undefined;
  const requirementCount = contract?.requirements?.length ?? 0;
  const commandList = (verification.commands ?? []) as Array<{ status?: string }>;
  const ranCommands = commandList.filter((command) => command.status === "passed" || command.status === "failed").length;
  if (requirementCount === 0 && ranCommands === 0) {
    components.verificationContext = 0;
    warnings.push("verification had no requirements and no executed commands (contract status ignored as non-evidence)");
  } else {
    components.verificationContext = 1;
  }

  // approval clarity: did the approval gate see the same picture the controller did?
  const approvalSeen = artifacts.events.some((event) => event.type === "approval.required");
  components.approvalClarity = approvalSeen ? 1 : artifacts.summary?.status === "COMPLETED" ? 0 : null;

  // reviewer/controller disagreement — judge the verdict's CONCLUSION, not
  // mid-transcript mentions of "block"/"fail" (e.g. "the form block",
  // "would fail if"). The reviewer writes a prose verdict + tool-call
  // transcript; the final stance is where "ready" vs "needs work" lives.
  const reviewerText = (artifacts.reviewerExecution?.outputText ?? "").toLowerCase();
  const reviewerConclusion = reviewerText.slice(-600);
  // Positive markers must not fire when negated ("not ready for approval",
  // "cannot approve"). The (?<!\bnot ) lookbehind guards the main forms.
  const reviewerPositive = /(?<!\bnot )(?<!\bcannot )(?<!\bcan't )(?<!\bcan not )\b(ready for approval|looks? ready|accepted|all checks? pass|no issues?|satisfies (all|every|the)|good to merge|ship it|no problems?|approve)\b/.test(reviewerConclusion);
  const reviewerNegative = /\b(not ready|must fix|cannot approve|can't approve|blocked pending|needs (work|changes|fixes|rework)|reject|do not merge|does not (look )?ready|fails? (the )?(checks?|review|verification)|not satisfied|unacceptable)\b/.test(reviewerConclusion);
  const controllerPositive = artifacts.summary?.status === "COMPLETED";
  if (!artifacts.reviewerExecution) {
    components.reviewerAgreement = null;
  } else {
    // A reviewer that explicitly blocks while the controller completed is a
    // disagreement. A reviewer that concludes positively agrees. When the
    // conclusion is ambiguous (neither explicit marker), treat as agreement.
    const disagreement = reviewerNegative && !reviewerPositive && controllerPositive;
    components.reviewerAgreement = disagreement ? 0 : 1;
    if (disagreement) {
      warnings.push("reviewer reported a problem while the controller reported COMPLETED");
    }
  }

  const measurable = numeric(components);
  if (measurable.length === 0) {
    return { score: null, components, warnings: [...warnings, "no handoff signals derivable"] };
  }
  return { score: average(measurable), components, warnings };
}

export function scoreExecution(artifacts: RunArtifacts, spec: BenchmarkTaskSpec): PillarResult {
  const warnings: string[] = [];
  const components: Record<string, number | null> = {};
  const status = artifacts.summary?.status;

  components.finalStatus = status === "COMPLETED" ? 1 : status === "BLOCKED" ? 0.3 : status ? 0 : null;
  const verificationStatus = artifacts.summary?.verificationStatus ?? (artifacts.verification?.overallStatus as string | undefined);
  if (spec.expectedVerificationStatus) {
    components.verificationOutcome = verificationStatus === spec.expectedVerificationStatus ? 1 : 0;
    if (components.verificationOutcome === 0) {
      warnings.push(`verification status ${String(verificationStatus)} != expected ${spec.expectedVerificationStatus}`);
    }
  } else {
    components.verificationOutcome = verificationStatus === "passed" ? 1 : verificationStatus === "incomplete" ? 0.5 : verificationStatus ? 0 : null;
  }

  const maxAttempts = spec.maxRepairAttempts ?? 3;
  const repairs = artifacts.repairExecutions.length;
  components.repairEfficiency = repairs === 0 ? 1 : clamp(1 - (repairs - 1) / Math.max(1, maxAttempts));

  const reviewerText = (artifacts.reviewerExecution?.outputText ?? "").toLowerCase();
  components.reviewOutcome = reviewerText ? (/\bnot ready\b|\bblock(ed)?\b/.test(reviewerText) ? 0 : 1) : null;

  return {
    score: numeric(components).length ? average(numeric(components)) : null,
    components,
    warnings,
  };
}

export function scoreMerge(artifacts: RunArtifacts, spec: BenchmarkTaskSpec): PillarResult {
  const warnings: string[] = [];
  const components: Record<string, number | null> = {};
  const merge = artifacts.finalMerge;

  if (!merge) {
    return { score: null, components, warnings: ["final-merge.json missing; landing not measurable"] };
  }

  // Era detection: pre-runLandingFlow artifacts carry no outcome/strategy and can
  // record a git failure as "skipped". Score them, but say so.
  const legacy = merge.outcome === undefined && merge.strategy === undefined;
  if (legacy) {
    warnings.push("final-merge.json predates landing outcomes (no outcome/strategy); status may mislabel a failed merge as skipped");
  }

  const landed = merge.status === "landed" || merge.status === "skipped";
  components.landed = landed ? 1 : 0;

  // A merge that actually failed inside a "skipped" status is not a landing win.
  if (/command failed|error:|conflict/i.test(merge.reason ?? "")) {
    components.landed = 0;
    if (merge.status === "skipped") {
      warnings.push("final-merge status is skipped but the reason records a failed git merge");
    }
  }

  if (artifacts.landingPlan) {
    const verdict = artifacts.landingPlan.guardVerdict;
    components.guardRan = verdict ? 1 : 0;
    if (verdict && !verdict.ok) {
      // A guard block is only correct if the reason is a real blocker. Absent
      // verification commands used to be treated as one (fixed in abea07c).
      const bogus = verdict.reasons.filter((reason) => /verification is incomplete/i.test(reason));
      components.guardCorrectness = bogus.length ? 0 : 1;
      if (bogus.length) {
        warnings.push("guard blocked on incomplete verification, which is not a landing blocker");
      }
    } else if (verdict?.ok) {
      components.guardCorrectness = landed ? 1 : 0;
    }
    const diagnosis = artifacts.landingDiagnoses.at(-1);
    if (diagnosis && verdict && !verdict.ok) {
      const citesDirty = /dirty|uncommitted/i.test(verdict.reasons.join(" "));
      const mismatch = diagnosis.kind === "dirty-target" && !citesDirty;
      components.diagnosisAccuracy = mismatch ? 0 : 1;
      if (mismatch) {
        warnings.push(`diagnosis kind ${diagnosis.kind} does not match the guard reasons (mislabeled cause)`);
      }
      components.recoveryActionable = diagnosis.recoveryHint?.trim() ? 1 : 0;
    }
  }

  const attempts = artifacts.landingAttempts.length;
  const maxAttempts = spec.maxRepairAttempts ?? 3;
  components.attemptEfficiency = attempts === 0 ? 1 : clamp(1 - Math.max(0, attempts - 1) / Math.max(1, maxAttempts));

  const measurable = numeric(components);
  return {
    score: measurable.length ? average(measurable) : null,
    components,
    warnings,
  };
}

export function scoreAdaptation(artifacts: RunArtifacts, spec: BenchmarkTaskSpec): PillarResult {
  const verification = artifacts.verification as
    | {
        cwd?: string;
        cwdResolution?: string;
        selectionSource?: string;
        evidence?: { selectedCandidate?: { path?: string }; commandDecisions?: Array<{ name: string; configured: boolean; selected: boolean }> };
        commands?: Array<{ name: string; command?: string; status?: string }>;
      }
    | undefined;

  if (!verification) {
    return { score: null, components: {}, warnings: ["verification.json missing"] };
  }

  const warnings: string[] = [];
  const components: Record<string, number | null> = {};
  const evidence = verification.evidence as
    | { selectedCandidate?: { path?: string }; allowedCommands?: string[]; commandDecisions?: Array<{ name: string; configured: boolean; selected: boolean }> }
    | undefined;
  const decisions = evidence?.commandDecisions ?? [];
  const commands = verification.commands ?? [];

  const nothingToAdapt = decisions.every((decision) => !decision.configured) && (evidence?.allowedCommands?.length ?? 0) === 0;
  if (nothingToAdapt) {
    return {
      score: null,
      components: { adaptable: 0 },
      warnings: ["workspace exposed no configured or discovered commands; adaptation is not measurable (scoring it would fake a pass)"],
    };
  }

  if (spec.expectedVerificationCwd) {
    const chosen = verification.evidence?.selectedCandidate?.path ?? verification.cwd ?? "";
    components.cwdSelection = chosen.replace(/\\/g, "/").endsWith(spec.expectedVerificationCwd.replace(/\\/g, "/")) ? 1 : 0;
    if (components.cwdSelection === 0) {
      warnings.push(`verification cwd ${chosen} != expected ${spec.expectedVerificationCwd}`);
    }
  }

  if (spec.staleCommands?.length) {
    const ran = commands.map((command) => command.command ?? "").join(" ");
    components.staleHandling = spec.staleCommands.some((stale) => ran.includes(stale)) ? 0 : 1;
    if (components.staleHandling === 0) {
      warnings.push(`stale command still executed: ${spec.staleCommands.join(", ")}`);
    }
  }

  // Invented commands: anything run that is neither configured nor allowed.
  if (spec.allowedCommands?.length) {
    const allowed = new Set(spec.allowedCommands);
    const invented = commands.filter((command) => command.command && !allowed.has(command.command));
    components.inventionDiscipline = invented.length === 0 ? 1 : 0;
    if (invented.length) {
      warnings.push(`commands executed outside the allowed set: ${invented.map((command) => command.command).join(", ")}`);
    }
  }

  components.omissionDiscipline = commands.some((command) => command.status === "missing" && command.command) ? 0 : 1;
  components.selectionSource = verification.selectionSource === "configured" || verification.selectionSource === "ai" ? 1 : 0.5;

  const measurable = numeric(components);
  return {
    score: measurable.length ? average(measurable) : null,
    components,
    warnings,
  };
}

export function scoreScope(artifacts: RunArtifacts, spec: BenchmarkTaskSpec): PillarResult {
  const changed = [...new Set(artifacts.completedTasks.flatMap((task) => task.changedFiles ?? []))];
  const warnings: string[] = [];
  const components: Record<string, number | null> = {};

  if (!spec.expectedFiles?.length) {
    return { score: null, components: { changedFileCount: changed.length }, warnings: ["no expectedFiles in task spec; scope drift is not measurable"] };
  }
  components.changedFileCount = changed.length;

  const expected = new Set(spec.expectedFiles);
  const outside = changed.filter((file) => !expected.has(file));
  components.scopeDiscipline = changed.length === 0 ? 0 : clamp(1 - outside.length / changed.length);
  if (outside.length) {
    warnings.push(`changed outside expected surface: ${outside.join(", ")}`);
  }

  if (spec.forbiddenFiles?.length) {
    const violated = changed.filter((file) => spec.forbiddenFiles?.some((forbidden) => file === forbidden || file.startsWith(`${forbidden}/`)));
    components.nonGoalsRespected = violated.length === 0 ? 1 : 0;
    if (violated.length) {
      warnings.push(`interview/plan non-goals violated by: ${violated.join(", ")}`);
    }
  }

  const targetFiles = artifacts.plan?.implementationContract?.targetFiles ?? [];
  if (targetFiles.length && changed.length) {
    const declared = new Set(targetFiles);
    const undeclared = changed.filter((file) => ![...declared].some((target) => file === target || file.endsWith(target)));
    components.planSurfaceMatch = clamp(1 - undeclared.length / changed.length);
  }

  const ratios = ["scopeDiscipline", "nonGoalsRespected", "planSurfaceMatch"]
    .map((key) => components[key])
    .filter((value): value is number => typeof value === "number");
  return {
    score: ratios.length ? average(ratios) : null,
    components,
    warnings,
  };
}

export function scoreTime(timing: RunTiming, spec: BenchmarkTaskSpec): PillarResult {
  const warnings: string[] = [];
  if (!spec.agentTimeBudgetMs) {
    return { score: null, components: { agentMs: timing.agentMs }, warnings: ["no agentTimeBudgetMs in task spec; efficiency not measurable"] };
  }
  const ratio = timing.agentMs / spec.agentTimeBudgetMs;
  if (ratio > 1) {
    warnings.push(`agent time ${Math.round(timing.agentMs / 1000)}s exceeded budget ${Math.round(spec.agentTimeBudgetMs / 1000)}s`);
  }
  const humanShare = timing.totalMs > 0 ? timing.humanWaitMs / timing.totalMs : 0;
  if (humanShare > 0.5) {
    warnings.push(`more than half of wall clock was human wait (${Math.round(humanShare * 100)}%) - excluded from agent time`);
  }
  // Under budget scores 1; over budget decays as budget/agentMs.
  return {
    score: clamp(Math.min(1, spec.agentTimeBudgetMs / Math.max(1, timing.agentMs))),
    components: { agentMs: timing.agentMs, humanWaitMs: timing.humanWaitMs, totalMs: timing.totalMs, budgetRatio: Number(ratio.toFixed(3)) },
    warnings,
  };
}
