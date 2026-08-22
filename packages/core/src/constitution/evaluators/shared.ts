import type { ConstitutionArea, ConstitutionScanResult } from "../types.js";

export interface ConstitutionEvaluationContext {
  discovery: ConstitutionScanResult["discovery"];
  impactedAreaIds: number[];
  noChange: boolean;
}

export function makeArea(
  id: number,
  title: string,
  status: ConstitutionArea["status"],
  finding: string,
  evidence: ConstitutionArea["evidence"],
  confidence?: ConstitutionArea["confidence"],
): ConstitutionArea {
  return {
    id,
    title,
    status,
    confidence,
    finding,
    evidence,
    claims: [
      {
        statement: finding,
        kind: claimKindForStatus(status),
        confidence,
        evidence,
      },
    ],
  };
}

export function buildRefreshNote(areaId: number, impactedAreaIds: number[], noChange: boolean): string {
  if (noChange) {
    return " Refresh detected no file changes since the last scan.";
  }
  if (impactedAreaIds.includes(areaId)) {
    return " Refresh impact routing marked this area as affected by recent file changes.";
  }
  return "";
}

export function distinctRoots(files: string[]): string[] {
  return Array.from(new Set(files.map((file) => file.split("/")[0]!).filter(Boolean))).sort();
}

export function claimKindForStatus(status: ConstitutionArea["status"]): NonNullable<ConstitutionArea["claims"]>[number]["kind"] {
  switch (status) {
    case "DEFINED":
      return "observed";
    case "INFERRED":
      return "inferred";
    case "UNCERTAIN":
      return "unknown";
    case "NOT_DEFINED":
    case "NOT_APPLICABLE":
    default:
      return "unknown";
  }
}
