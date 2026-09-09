// AI-area reasoning helpers — extracted from constitution-scan-helpers.ts.

import type { ConstitutionArea, ConstitutionScanResult } from "./types.js";
import type { AgentExecutor } from "../runtime/interfaces.js";
import { claimKindForStatus } from "./evaluators/shared.js";

export function buildReasonerPrompt(input: {
  discovery: ConstitutionScanResult["discovery"];
  areas: ConstitutionArea[];
  impactedAreaIds: number[];
  changedFiles: string[];
  strategy: ConstitutionScanResult["refreshStrategy"];
}): string {
  const focusAreas = input.strategy === "targeted-interpretation"
    ? input.areas.filter((area) => input.impactedAreaIds.includes(area.id))
    : input.areas;

  return [
    "You are a constitution reasoner.",
    "Use only the provided repository evidence.",
    "Do not invent evidence paths or repository rules.",
    `Refresh strategy: ${input.strategy}`,
    `Root: ${input.discovery.root}`,
    `Languages: ${input.discovery.languages.join(", ") || "none"}`,
    `Package managers: ${input.discovery.packageManagers.join(", ") || "none"}`,
    `Instructions: ${input.discovery.instructionFiles.slice(0, 20).join(", ") || "none"}`,
    `Manifests: ${input.discovery.manifests.join(", ") || "none"}`,
    `Tests: ${input.discovery.testFiles.slice(0, 20).join(", ") || "none"}`,
    `CI: ${input.discovery.ciFiles.join(", ") || "none"}`,
    `Changed files: ${input.changedFiles.slice(0, 40).join(", ") || "none"}`,
    `Impacted areas: ${input.impactedAreaIds.join(", ") || "none"}`,
    input.strategy === "targeted-interpretation"
      ? "Interpret only the impacted areas and their immediate architectural implications. Keep output concise."
      : "Summarize actual repository architecture and conventions briefly. Mention ambiguity explicitly.",
    `Seed findings: ${focusAreas.map((area) => `${area.id}:${area.title}=${area.status} :: ${area.finding}`).join("; ")}`,
    "After your notes, optionally emit JSON between AI_AREA_PROPOSALS_START and AI_AREA_PROPOSALS_END.",
    "JSON format: [{ id, status, confidence?, finding, driftWarnings? }].",
    "For targeted interpretation, only propose updates for impacted areas. For full interpretation, still avoid changing unrelated areas unless clearly warranted.",
  ].join("\n");
}

export function mergeAiAreas(
  areas: ConstitutionArea[],
  proposedAreas: ConstitutionArea[],
  impactedAreaIds: number[],
): ConstitutionArea[] {
  const proposedById = new Map(
    proposedAreas
      .filter((area) => impactedAreaIds.includes(area.id) || area.status === "UNCERTAIN")
      .map((area) => [area.id, area]),
  );

  return areas.map((area) => {
    const proposed = proposedById.get(area.id);
    if (!proposed) {
      return area;
    }
    const finding = proposed.finding || area.finding;
    const confidence = proposed.confidence;
    const status = proposed.status;
    return {
      ...area,
      status,
      confidence,
      finding,
      claims: [
        {
          statement: finding,
          kind: claimKindForStatus(status),
          confidence,
          evidence: area.evidence,
        },
      ],
      driftWarnings: proposed.driftWarnings,
    };
  });
}

export function parseAiAreaProposals(
  outputText: string,
  baseAreas: ConstitutionArea[],
  impactedAreaIds: number[],
): ConstitutionArea[] {
  const jsonText = extractAiAreaJson(outputText);
  if (!jsonText) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonText) as Array<Record<string, unknown>>;
    const baseById = new Map(baseAreas.map((area) => [area.id, area]));
    return parsed
      .map((item) => {
        const id = typeof item.id === "number" ? item.id : Number.parseInt(String(item.id ?? ""), 10);
        if (!Number.isFinite(id) || !impactedAreaIds.includes(id)) {
          return undefined;
        }
        const base = baseById.get(id);
        if (!base) {
          return undefined;
        }
        const status = typeof item.status === "string" ? item.status : base.status;
        if (!isValidStatus(status)) {
          return undefined;
        }
        const confidence = typeof item.confidence === "string" && isValidConfidence(item.confidence)
          ? item.confidence
          : base.confidence;
        const finding = typeof item.finding === "string" ? item.finding : base.finding;
        const driftWarnings = Array.isArray(item.driftWarnings)
          ? item.driftWarnings.filter((value): value is string => typeof value === "string")
          : undefined;
        return {
          ...base,
          status,
          confidence,
          finding,
          driftWarnings,
        } as ConstitutionArea;
      })
      .filter((area): area is ConstitutionArea => Boolean(area));
  } catch {
    return [];
  }
}

export function extractAiAreaJson(outputText: string): string | undefined {
  const match = /AI_AREA_PROPOSALS_START\s*([\s\S]*?)\s*AI_AREA_PROPOSALS_END/.exec(outputText);
  return match?.[1]?.trim() || undefined;
}

export function stripAiAreaJson(outputText: string): string {
  return outputText.replace(/AI_AREA_PROPOSALS_START[\s\S]*?AI_AREA_PROPOSALS_END/g, "").trim();
}

export function isValidStatus(value: string): value is ConstitutionArea["status"] {
  return value === "DEFINED" || value === "INFERRED" || value === "NOT_DEFINED" || value === "NOT_APPLICABLE" || value === "UNCERTAIN";
}

export function isValidConfidence(value: string): value is NonNullable<ConstitutionArea["confidence"]> {
  return value === "HIGH" || value === "MEDIUM" || value === "LOW";
}


