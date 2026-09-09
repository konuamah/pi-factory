// Pure render + diagnostic line builders — extracted from gateway.ts so the
// command handlers stay focused on orchestration.

import type { FactoryPiCommandContext } from "./types.js";
import { runFactoryDoctor } from "@factory/core";
import type { WorkflowStage } from "@factory/schemas";

export const FACTORY_WIDGET_ID = "factory-status";

export function buildDecisionLines(
  decisions: Array<{ type: "request" | "resolution"; requestId?: string; question?: string; optionId?: string; feedback?: string }> | undefined,
): string[] {
  if (!decisions?.length) {
    return [];
  }
  const lines = ["", "Decisions:"];
  for (const decision of decisions) {
    if (decision.type === "request") {
      lines.push(`  ? ${decision.requestId ?? "?"}: ${decision.question ?? ""}`);
    } else {
      lines.push(`  ✓ ${decision.requestId ?? "?"} → ${decision.optionId ?? "?"}${decision.feedback ? ` (${decision.feedback})` : ""}`);
    }
  }
  return lines;
}

export function buildGuidanceDiagnosticLines(guidance:
  | {
      plannerInstructionFiles: string[];
      builderInstructionFiles: string[];
      repairInstructionFiles: string[];
      reviewerInstructionFiles: string[];
      plannerInstructionDetails?: Array<{ path: string; score: number; reason: string }>;
      builderInstructionDetails?: Array<{ path: string; score: number; reason: string }>;
      repairInstructionDetails?: Array<{ path: string; score: number; reason: string }>;
      reviewerInstructionDetails?: Array<{ path: string; score: number; reason: string }>;
      plannerHasConstitution: boolean;
      builderHasConstitution: boolean;
      repairHasConstitution: boolean;
      reviewerHasConstitution: boolean;
      plannerUsedConstitution: boolean;
      builderUsedConstitution: boolean;
      repairUsedConstitution: boolean;
      reviewerUsedConstitution: boolean;
      plannerGuidanceChars: number;
      builderGuidanceChars: number;
      repairGuidanceChars: number;
      reviewerGuidanceChars: number;
    }
  | undefined,
): string[] {
  if (!guidance) {
    return [];
  }

  return [
    `planner guidance files: ${guidance.plannerInstructionFiles.join(", ") || "none"}`,
    ...((guidance.plannerInstructionDetails ?? []).slice(0, 3).map((detail) => `  planner reason: ${detail.path} (score ${detail.score}) - ${detail.reason}`)),
    `builder guidance files: ${guidance.builderInstructionFiles.join(", ") || "none"}`,
    `repair guidance files: ${guidance.repairInstructionFiles.join(", ") || "none"}`,
    `reviewer guidance files: ${guidance.reviewerInstructionFiles.join(", ") || "none"}`,
    `planner constitution used: ${guidance.plannerUsedConstitution ? "yes" : "no"}`,
    `builder constitution used: ${guidance.builderUsedConstitution ? "yes" : "no"}`,
    `repair constitution used: ${guidance.repairUsedConstitution ? "yes" : "no"}`,
    `reviewer constitution used: ${guidance.reviewerUsedConstitution ? "yes" : "no"}`,
    `planner guidance chars: ${guidance.plannerGuidanceChars}`,
    `builder guidance chars: ${guidance.builderGuidanceChars}`,
    `repair guidance chars: ${guidance.repairGuidanceChars}`,
    `reviewer guidance chars: ${guidance.reviewerGuidanceChars}`,
  ];
}

export function buildVerificationDiagnosticLines(
  verificationContext:
    | {
        cwd?: string;
        cwdResolution?: string;
        selectionSource?: string;
        rationale?: string;
        failureKind?: string;
        failureReason?: string;
      }
    | undefined,
  verification: Record<string, unknown> | undefined,
): string[] {
  if (!verificationContext && !verification) {
    return [];
  }

  const commands = Array.isArray(verification?.commands)
    ? verification.commands.filter((item): item is { name?: unknown; status?: unknown } => Boolean(item) && typeof item === "object")
    : [];
  const commandLines = commands.slice(0, 5).map((item) => `  command ${String(item.name ?? "?")}: ${String(item.status ?? "unknown")}`);
  const verificationEvidence = verification?.evidence && typeof verification.evidence === "object"
    ? verification.evidence as { commandDecisions?: unknown }
    : undefined;
  const decisionLines = Array.isArray(verificationEvidence?.commandDecisions)
    ? (verificationEvidence.commandDecisions as Array<{ name?: unknown; selected?: unknown; reason?: unknown }>)
        .slice(0, 5)
        .map((item) => `  selection ${String(item.name ?? "?")}: ${Boolean(item.selected) ? "run" : "skip"} - ${String(item.reason ?? "unknown")}`)
    : [];

  return [
    `verification cwd: ${verificationContext?.cwd ?? String(verification?.cwd ?? "none")}`,
    `verification cwd reason: ${verificationContext?.cwdResolution ?? String(verification?.cwdResolution ?? "none")}`,
    `verification selection source: ${verificationContext?.selectionSource ?? String(verification?.selectionSource ?? "none")}`,
    `verification rationale: ${verificationContext?.rationale ?? String(verification?.rationale ?? "none")}`,
    `verification failure class: ${verificationContext?.failureKind ?? String((verification?.failureClassification as { kind?: unknown } | undefined)?.kind ?? "none")}`,
    `verification failure reason: ${verificationContext?.failureReason ?? String((verification?.failureClassification as { reason?: unknown } | undefined)?.reason ?? "none")}`,
    ...decisionLines,
    ...commandLines,
  ];
}

export function buildIntegrationFailureLines(
  integrationFailure:
    | {
        reason?: string;
        conflictingFiles: string[];
        mergeInProgress: boolean;
      }
    | undefined,
): string[] {
  if (!integrationFailure) {
    return [];
  }

  return [
    `integration failure: ${integrationFailure.reason ?? "unknown"}`,
    `integration conflicts: ${integrationFailure.conflictingFiles.join(", ") || "none"}`,
    `merge in progress: ${integrationFailure.mergeInProgress ? "yes" : "no"}`,
  ];
}


export function renderLines(ctx: FactoryPiCommandContext, lines: string[]): void {
  ctx.ui.setWidget(FACTORY_WIDGET_ID, lines);
}

export function clearFactoryWidget(ctx: FactoryPiCommandContext): void {
  ctx.ui.setWidget(FACTORY_WIDGET_ID, undefined);
}

export function renderIntro(ctx: FactoryPiCommandContext, lines: string[]): void {
  renderLines(ctx, ["Factory", "", ...lines]);
}

export function doctorWidgetLines(result: Awaited<ReturnType<typeof runFactoryDoctor>>): string[] {
  const failed = result.checks.filter((check) => !check.ok);
  const passed = result.checks.filter((check) => check.ok);
  const lines = [
    "Factory doctor",
    `summary: ${passed.length} ok, ${failed.length} failed`,
  ];

  if (failed.length > 0) {
    lines.push("", "Failures");
    const visibleFailures = failed.slice(0, 6);
    for (const check of visibleFailures) {
      lines.push(`FAIL ${check.name}: ${check.detail}`);
    }
    if (failed.length > visibleFailures.length) {
      lines.push(`... ${failed.length - visibleFailures.length} more failure(s). Run /factory models for deeper detail.`);
    }
  }

  if (passed.length > 0) {
    lines.push("", "OK checks");
    const chunks = chunkNames(passed.map((check) => check.name), 4);
    for (const chunk of chunks) {
      lines.push(chunk.join(", "));
    }
  }

  return lines;
}

export function chunkNames(values: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

