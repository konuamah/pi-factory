// Area critique + contradiction detection — extracted from
// constitution-scan-helpers.ts.

import type { ConstitutionArea } from "./types.js";

export function critiqueAreas(areas: ConstitutionArea[]): ConstitutionArea[] {
  return areas.map((area) => {
    const criticWarnings = critiqueArea(area);
    const claims = (area.claims ?? []).map((claim) => ({
      ...claim,
      criticWarnings: critiqueClaim(claim.statement, claim.evidence, claim.kind),
    }));
    return {
      ...area,
      claims,
      criticWarnings: criticWarnings.length > 0 ? criticWarnings : undefined,
    };
  });
}

export function detectAreaContradictions(areas: ConstitutionArea[]): ConstitutionArea[] {
  const byId = new Map(areas.map((area) => [area.id, area]));
  const updates = new Map<number, { warnings: string[]; claims: NonNullable<ConstitutionArea["claims"]> }>();

  const addConflict = (ids: number[], message: string) => {
    for (const id of ids) {
      const area = byId.get(id);
      if (!area) {
        continue;
      }
      const existing = updates.get(id) ?? { warnings: [], claims: [] };
      existing.warnings.push(message);
      existing.claims.push({
        statement: message,
        kind: "conflict",
        confidence: "MEDIUM",
        evidence: area.evidence,
      });
      updates.set(id, existing);
    }
  };

  const envArea = byId.get(15);
  const envConventionArea = byId.get(16);
  const secretsArea = byId.get(17);
  const secretScanningArea = byId.get(68);
  if ((envArea?.status === "INFERRED" || envArea?.status === "DEFINED" || envConventionArea?.status === "INFERRED")
    && (secretsArea?.status === "NOT_DEFINED" || secretsArea?.status === "UNCERTAIN" || secretScanningArea?.status === "NOT_DEFINED" || secretScanningArea?.status === "UNCERTAIN")) {
    addConflict([15, 16, 17, 68], "Environment-file usage is evident, but explicit secrets handling/scanning controls are weak or absent.");
  }

  const ciPlatform = byId.get(87);
  const qualityChecks = byId.get(90);
  const artifactArea = byId.get(91);
  const cacheArea = byId.get(92);
  const deployAutomation = byId.get(93);
  if (ciPlatform?.status === "NOT_DEFINED" && [qualityChecks, artifactArea, cacheArea, deployAutomation].some((area) => area?.status === "INFERRED" || area?.status === "DEFINED")) {
    addConflict([87, 90, 91, 92, 93], "CI/CD sub-findings imply workflow behavior, but no CI/CD platform was confidently identified.");
  }

  const apiStyle = byId.get(40);
  const validation = byId.get(43);
  const responseContracts = byId.get(44);
  const errorFormat = byId.get(45);
  if ((apiStyle?.status === "DEFINED" || apiStyle?.status === "INFERRED")
    && validation?.status === "NOT_DEFINED"
    && responseContracts?.status === "NOT_DEFINED"
    && errorFormat?.status === "NOT_DEFINED") {
    addConflict([40, 43, 44, 45], "API surface is present, but validation and contract-format evidence remain absent.");
  }

  const reviewArea = byId.get(109);
  const protectedBranchArea = byId.get(110);
  const codeownersArea = byId.get(111);
  if ((reviewArea?.status === "DEFINED" || reviewArea?.status === "INFERRED")
    && protectedBranchArea?.status === "NOT_DEFINED"
    && codeownersArea?.status === "NOT_DEFINED") {
    addConflict([109, 110, 111], "Review/approval expectations exist, but branch protection and code ownership enforcement are not evident.");
  }

  const deploymentModel = byId.get(112);
  if ((deployAutomation?.status === "DEFINED" || deployAutomation?.status === "INFERRED") && deploymentModel?.status === "NOT_DEFINED") {
    addConflict([93, 112], "Deployment automation is implied, but the deployment model itself is not yet clearly described by repository evidence.");
  }

  return areas.map((area) => {
    const update = updates.get(area.id);
    if (!update) {
      return area;
    }
    return {
      ...area,
      criticWarnings: [...new Set([...(area.criticWarnings ?? []), ...update.warnings])],
      claims: [...(area.claims ?? []), ...update.claims],
    };
  });
}

export function critiqueArea(area: ConstitutionArea): string[] {
  const warnings: string[] = [];
  if ((area.status === "DEFINED" || area.status === "INFERRED") && area.evidence.length === 0) {
    warnings.push("Area makes a concrete claim without supporting evidence.");
  }
  if (looksGeneric(area.finding) && area.status !== "NOT_DEFINED" && area.status !== "NOT_APPLICABLE") {
    warnings.push("Finding is generic or placeholder-like; deepen evidence before trusting this area.");
  }
  return warnings;
}

export function critiqueClaim(statement: string, evidence: ConstitutionArea["evidence"], kind: NonNullable<ConstitutionArea["claims"]>[number]["kind"]): string[] {
  const warnings: string[] = [];
  if ((kind === "observed" || kind === "inferred") && evidence.length === 0) {
    warnings.push("Claim lacks direct evidence references.");
  }
  if (looksGeneric(statement)) {
    warnings.push("Claim appears generic enough to fit unrelated repositories.");
  }
  return warnings;
}

export function looksPlaceholder(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized.includes("not implemented yet") || normalized.includes("repository evidence exists for this area");
}

export function looksGeneric(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return [
    "not implemented yet",
    "repository evidence exists for this area",
    "appears to use",
    "appears to be",
    "is implied by",
    "could be determined",
    "no evidence detected",
  ].some((phrase) => normalized.includes(phrase));
}

