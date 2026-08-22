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

export interface ConstitutionArea {
  id: number;
  title: string;
  status: ConstitutionStatus;
  confidence?: ConstitutionConfidence;
  finding: string;
  evidence: ConstitutionEvidence[];
  driftWarnings?: string[];
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
  mode: "deterministic" | "hybrid";
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
  aiReasoning?: {
    enabled: boolean;
    status: "completed" | "failed" | "skipped";
    outputText?: string;
    errorMessage?: string;
    proposedAreas?: ConstitutionArea[];
  };
  constitutionPath: string;
  metadataPath: string;
}
