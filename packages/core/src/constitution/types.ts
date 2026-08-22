export type ConstitutionStatus =
  | "DEFINED"
  | "INFERRED"
  | "NOT_DEFINED"
  | "NOT_APPLICABLE"
  | "UNCERTAIN";

export type ConstitutionConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface ConstitutionEvidence {
  kind: "file" | "pattern" | "command";
  path?: string;
  detail: string;
}

export type ConstitutionClaimKind =
  | "observed"
  | "inferred"
  | "unknown"
  | "normative"
  | "conflict";

export interface ConstitutionClaim {
  statement: string;
  kind: ConstitutionClaimKind;
  confidence?: ConstitutionConfidence;
  evidence: ConstitutionEvidence[];
  criticWarnings?: string[];
}

export interface ConstitutionArea {
  id: number;
  title: string;
  status: ConstitutionStatus;
  confidence?: ConstitutionConfidence;
  finding: string;
  evidence: ConstitutionEvidence[];
  claims?: ConstitutionClaim[];
  driftWarnings?: string[];
  criticWarnings?: string[];
}

export interface ConstitutionDiscovery {
  root: string;
  trackedFiles: string[];
  instructionFiles: string[];
  manifests: string[];
  lockfiles: string[];
  ciFiles: string[];
  testFiles: string[];
  dockerFiles: string[];
  sourceFiles: string[];
  docsFiles: string[];
  scriptFiles: string[];
  generatedFiles: string[];
  assetFiles: string[];
  envFiles: string[];
  versionFiles: string[];
  lintFiles: string[];
  formatFiles: string[];
  typecheckFiles: string[];
  apiFiles: string[];
  dataFiles: string[];
  languages: string[];
  packageManagers: string[];
  commands: Record<string, string>;
}

export interface ConstitutionScanResult {
  root: string;
  mode: "single-pipeline";
  refresh: {
    mode: "FAST" | "FULL";
    noChange: boolean;
    changedFiles: string[];
    impactedAreaIds: number[];
    previousScanSha?: string;
    currentScanSha?: string;
    reusedAreaIds?: number[];
  };
  discovery: ConstitutionDiscovery;
  areas: ConstitutionArea[];
  summary: string[];
  interpreter: {
    required: true;
    status: "completed" | "failed" | "unavailable";
    outputText?: string;
    errorMessage?: string;
    proposedAreas?: ConstitutionArea[];
  };
  constitutionPath: string;
  metadataPath: string;
  factsPath: string;
  finalized: boolean;
}
