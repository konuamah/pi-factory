// Constitution scan helpers — extracted from scan.ts.

import fs from "node:fs/promises";
import path from "node:path";
import { CONSTITUTION_AREA_DEFINITIONS } from "./areas.js";
import { evaluateFoundationAreas } from "./evaluators/foundation.js";
import { evaluateToolingAreas } from "./evaluators/tooling.js";
import { evaluateApiAreas } from "./evaluators/api.js";
import { evaluateDataAreas } from "./evaluators/data.js";
import { evaluateCiCdAreas } from "./evaluators/cicd.js";
import { evaluateGovernanceAreas } from "./evaluators/governance.js";
import { evaluateSecurityAreas } from "./evaluators/security.js";
import { evaluateTestingAreas } from "./evaluators/testing.js";
import { evaluateDependencyAndConfigAreas } from "./evaluators/dependencies.js";
import { evaluateStyleAreas } from "./evaluators/style.js";
import { evaluateArchitectureAreas } from "./evaluators/architecture.js";
import { evaluateReliabilityAreas } from "./evaluators/reliability.js";
import { evaluateObservabilityAreas } from "./evaluators/observability.js";
import { evaluateMaintainabilityAreas } from "./evaluators/maintainability.js";
import { buildRefreshNote, claimKindForStatus, distinctRoots, makeArea } from "./evaluators/shared.js";
import { hasStructuralConstitutionChanges } from "./refresh.js";
import type { ConstitutionArea, ConstitutionScanResult } from "./types.js";
import { looksPlaceholder, looksGeneric } from "./constitution-critique.js";

export async function buildDeterministicAreas(
  discovery: ConstitutionScanResult["discovery"],
  impactedAreaIds: number[],
  noChange: boolean,
): Promise<ConstitutionArea[]> {
  const context = { discovery, impactedAreaIds, noChange };
  const implementedAreas: ConstitutionArea[] = [
    ...evaluateFoundationAreas(context),
    ...await evaluateDependencyAndConfigAreas(context),
    ...await evaluateStyleAreas(context),
    ...await evaluateArchitectureAreas(context),
    ...await evaluateApiAreas(context),
    ...await evaluateDataAreas(context),
    ...await evaluateReliabilityAreas(context),
    ...await evaluateSecurityAreas(context),
    ...await evaluateTestingAreas(context),
    ...evaluateToolingAreas(context),
    ...await evaluateCiCdAreas(context),
    ...await evaluateObservabilityAreas(context),
    ...await evaluateGovernanceAreas(context),
    ...await evaluateMaintainabilityAreas(context),
  ];

  const implementedById = new Map(implementedAreas.map((area) => [area.id, area]));
  return CONSTITUTION_AREA_DEFINITIONS.map((definition) => {
    const existing = implementedById.get(definition.id);
    if (existing) {
      return existing;
    }

    const apiRelated = definition.id >= 40 && definition.id <= 47;
    const dataRelated = definition.id >= 48 && definition.id <= 55;
    const ciRelated = definition.id >= 88 && definition.id <= 93;
    const hasRelevantEvidence =
      (apiRelated && discovery.apiFiles.length > 0) ||
      (dataRelated && discovery.dataFiles.length > 0) ||
      (ciRelated && discovery.ciFiles.length > 0);

    return makeArea(
      definition.id,
      definition.title,
      hasRelevantEvidence ? "UNCERTAIN" : "NOT_DEFINED",
      `${hasRelevantEvidence ? "Repository evidence exists for this area, but deterministic evaluation is not implemented yet." : "Full deterministic evaluation for this area is not implemented yet."}${buildRefreshNote(definition.id, impactedAreaIds, noChange)}`,
      [],
      hasRelevantEvidence ? "LOW" : undefined,
    );
  });
}

export function determineRefreshStrategy(
  refresh: ConstitutionScanResult["refresh"],
  hasFinalizedConstitution: boolean,
): ConstitutionScanResult["refreshStrategy"] {
  if (refresh.noChange && hasFinalizedConstitution) {
    return "reuse-finalized";
  }
  if (
    hasFinalizedConstitution &&
    refresh.impactedAreaIds.length > 0 &&
    refresh.impactedAreaIds.length <= 12 &&
    !hasStructuralConstitutionChanges(refresh.changedFiles)
  ) {
    return "targeted-interpretation";
  }
  return "full-interpretation";
}

export function buildSummary(
  discovery: ConstitutionScanResult["discovery"],
  areas: ConstitutionArea[],
  refresh: ConstitutionScanResult["refresh"],
): string[] {
  return [
    `Repository root: ${discovery.root}`,
    `Languages: ${discovery.languages.join(", ") || "none detected"}`,
    `Package managers: ${discovery.packageManagers.join(", ") || "none detected"}`,
    `Source roots: ${distinctRoots(discovery.sourceFiles).join(", ") || "none detected"}`,
    `Docs roots: ${distinctRoots(discovery.docsFiles).join(", ") || "none detected"}`,
    `API files: ${discovery.apiFiles.length}`,
    `Data files: ${discovery.dataFiles.length}`,
    `Tests: ${discovery.testFiles.length}`,
    `CI: ${discovery.ciFiles.length > 0 ? discovery.ciFiles.join(", ") : "not detected"}`,
    `Deterministic areas evaluated: ${areas.length}`,
    `Refresh mode: ${refresh.mode}`,
    `Changed files: ${refresh.changedFiles.length}`,
    `Impacted areas: ${refresh.impactedAreaIds.join(", ") || "none"}`,
    `Reused areas: ${refresh.reusedAreaIds?.join(", ") || "none"}`,
    `Critic warnings: ${areas.reduce((count, area) => count + (area.criticWarnings?.length ?? 0), 0)}`,
  ];
}

export function mergeAreasWithRefresh(
  previousAreas: ConstitutionArea[],
  evaluatedAreas: ConstitutionArea[],
  impactedAreaIds: number[],
  noChange: boolean,
): ConstitutionArea[] {
  const previousById = new Map(previousAreas.map((area) => [area.id, area]));
  return evaluatedAreas.map((area) => {
    if (!noChange && !impactedAreaIds.includes(area.id)) {
      const previous = previousById.get(area.id);
      if (previous && shouldReusePreviousArea(previous, area)) {
        return {
          ...previous,
          title: area.title,
        };
      }
    }

    const previous = previousById.get(area.id);
    if (!previous) {
      return area;
    }

    const driftWarnings: string[] = [];
    if (previous.status !== area.status) {
      driftWarnings.push(`Status changed from ${previous.status} to ${area.status} based on current repository evidence.`);
    }
    if (previous.finding !== area.finding && impactedAreaIds.includes(area.id)) {
      driftWarnings.push("Finding changed for this impacted area during refresh.");
    }

    return {
      ...area,
      driftWarnings: driftWarnings.length > 0 ? driftWarnings : undefined,
    };
  });
}

export async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export interface AreaLineRule {
  pattern: RegExp;
  /** Apply the match to the current area; return true if handled. */
  apply: (match: RegExpExecArray, current: ConstitutionArea, line: string) => boolean;
}

const AREA_LINE_RULES: AreaLineRule[] = [
  {
    pattern: /^- Status:\s+([A-Z_]+)(?:\s+\((HIGH|MEDIUM|LOW)\))?$/,
    apply: (match, current) => {
      current.status = match[1] as ConstitutionArea["status"];
      current.confidence = match[2] as ConstitutionArea["confidence"] | undefined;
      return true;
    },
  },
  {
    pattern: /^- Finding:\s+(.+)$/,
    apply: (match, current) => {
      current.finding = match[1] ?? "";
      return true;
    },
  },
  {
    pattern: /^- Evidence:\s+(?:(.+?)\s+—\s+)?(.+)$/,
    apply: (match, current) => {
      current.evidence.push({
        kind: "file",
        path: match[1] || undefined,
        detail: match[2] ?? "",
      });
      return true;
    },
  },
  {
    pattern: /^- Claim:\s+\[([a-z]+)(?:\/(HIGH|MEDIUM|LOW))?\]\s+(.+)$/,
    apply: (match, current) => {
      current.claims ??= [];
      current.claims.push({
        kind: match[1] as NonNullable<ConstitutionArea["claims"]>[number]["kind"],
        confidence: match[2] as ConstitutionArea["confidence"] | undefined,
        statement: match[3] ?? "",
        evidence: [],
      });
      return true;
    },
  },
  {
    pattern: /^\s+- Claim evidence:\s+(?:(.+?)\s+—\s+)?(.+)$/,
    apply: (match, current) => {
      if (current.claims && current.claims.length > 0) {
        current.claims[current.claims.length - 1]!.evidence.push({
          kind: "file",
          path: match[1] || undefined,
          detail: match[2] ?? "",
        });
      }
      return true;
    },
  },
];

export async function readExistingConstitutionAreas(filePath: string): Promise<ConstitutionArea[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/);
    const areas: ConstitutionArea[] = [];
    let current: ConstitutionArea | undefined;

    for (const line of lines) {
      const heading = /^##\s+(\d+)\.\s+(.+)$/.exec(line);
      if (heading) {
        if (current) {
          areas.push(current);
        }
        current = {
          id: Number.parseInt(heading[1] ?? "0", 10),
          title: heading[2] ?? "Unknown",
          status: "UNCERTAIN",
          finding: "",
          evidence: [],
        };
        continue;
      }
      if (!current) {
        continue;
      }
      for (const rule of AREA_LINE_RULES) {
        const match = rule.pattern.exec(line);
        if (match && rule.apply(match, current, line)) {
          break;
        }
      }
    }

    if (current) {
      areas.push(current);
    }

    for (const area of areas) {
      if ((!area.claims || area.claims.length === 0) && area.finding) {
        area.claims = [{
          statement: area.finding,
          kind: claimKindForStatus(area.status),
          confidence: area.confidence,
          evidence: area.evidence,
        }];
      }
    }

    return areas;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function shouldReusePreviousArea(previous: ConstitutionArea, current: ConstitutionArea): boolean {
  const previousPlaceholder = looksPlaceholder(previous.finding);
  const currentPlaceholder = looksPlaceholder(current.finding);
  if (previousPlaceholder && !currentPlaceholder) {
    return false;
  }
  if (!currentPlaceholder && previous.status !== current.status) {
    return false;
  }
  if ((previous.evidence.length === 0 && current.evidence.length > 0) || (previous.status === "NOT_DEFINED" && current.status !== "NOT_DEFINED")) {
    return false;
  }
  const previousEvidenceKey = previous.evidence.map((item) => `${item.path ?? ""}:${item.detail}`).join("|");
  const currentEvidenceKey = current.evidence.map((item) => `${item.path ?? ""}:${item.detail}`).join("|");
  if (!currentPlaceholder && currentEvidenceKey && previousEvidenceKey !== currentEvidenceKey) {
    return false;
  }
  return true;
}
