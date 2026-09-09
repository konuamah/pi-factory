// Shared guidance-summary extraction, used by both show.ts and logs-by-id.ts.
// Keep the shape in sync with the `guidance` fields on FactoryRunShowResult and
// FactoryRunLogsByIdResult.

export interface GuidanceSummary {
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

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function detailArray(value: unknown): Array<{ path: string; score: number; reason: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is { path?: unknown; score?: unknown; reason?: unknown } => Boolean(item) && typeof item === "object")
    .map((item) => ({
      path: typeof item.path === "string" ? item.path : "unknown",
      score: numberValue(item.score),
      reason: typeof item.reason === "string" ? item.reason : "",
    }));
}

export function summarizeGuidanceEvents(events: Array<{ type?: string; data?: Record<string, unknown> }>): GuidanceSummary | undefined {
  for (const event of events) {
    if (event.type !== "guidance.context_selected") {
      continue;
    }
    return {
      plannerInstructionFiles: stringArray(event.data?.plannerInstructionFiles),
      builderInstructionFiles: stringArray(event.data?.builderInstructionFiles),
      repairInstructionFiles: stringArray(event.data?.repairInstructionFiles),
      reviewerInstructionFiles: stringArray(event.data?.reviewerInstructionFiles),
      plannerInstructionDetails: detailArray(event.data?.plannerInstructionDetails),
      builderInstructionDetails: detailArray(event.data?.builderInstructionDetails),
      repairInstructionDetails: detailArray(event.data?.repairInstructionDetails),
      reviewerInstructionDetails: detailArray(event.data?.reviewerInstructionDetails),
      plannerHasConstitution: Boolean(event.data?.plannerHasConstitution),
      builderHasConstitution: Boolean(event.data?.builderHasConstitution),
      repairHasConstitution: Boolean(event.data?.repairHasConstitution),
      reviewerHasConstitution: Boolean(event.data?.reviewerHasConstitution),
      plannerUsedConstitution: Boolean(event.data?.plannerUsedConstitution),
      builderUsedConstitution: Boolean(event.data?.builderUsedConstitution),
      repairUsedConstitution: Boolean(event.data?.repairUsedConstitution),
      reviewerUsedConstitution: Boolean(event.data?.reviewerUsedConstitution),
      plannerGuidanceChars: numberValue(event.data?.plannerGuidanceChars),
      builderGuidanceChars: numberValue(event.data?.builderGuidanceChars),
      repairGuidanceChars: numberValue(event.data?.repairGuidanceChars),
      reviewerGuidanceChars: numberValue(event.data?.reviewerGuidanceChars),
    };
  }
  return undefined;
}
