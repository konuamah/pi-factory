import fs from "node:fs/promises";
import path from "node:path";
import type { AgentExecutor } from "../runtime/interfaces.js";
import { CONSTITUTION_AREA_DEFINITIONS } from "./areas.js";
import { discoverConstitutionRepository } from "./discovery.js";
import { detectConstitutionRefreshState, hasStructuralConstitutionChanges } from "./refresh.js";
import { renderConstitutionMarkdown } from "./render.js";
import type { ConstitutionArea, ConstitutionScanResult } from "./types.js";
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

export async function runConstitutionScan(input: {
  cwd: string;
  constitutionExecutor?: AgentExecutor;
}): Promise<ConstitutionScanResult> {
  const discovery = await discoverConstitutionRepository(input.cwd);
  const refresh = await detectConstitutionRefreshState(discovery.root);
  const constitutionDir = path.join(discovery.root, ".factory", "constitution");
  const constitutionPath = path.join(discovery.root, "CONSTITUTION.md");
  const factsPath = path.join(constitutionDir, "facts.json");
  const metadataPath = path.join(constitutionDir, "metadata.json");
  await fs.mkdir(constitutionDir, { recursive: true });

  const previousMetadata = await readJson<{
    finalized?: boolean;
    interpreter?: ConstitutionScanResult["interpreter"];
  }>(metadataPath);
  const previousFacts = await readJson<{
    discovery?: ConstitutionScanResult["discovery"];
    summary?: string[];
    areas?: ConstitutionArea[];
  }>(factsPath);

  if (
    refresh.noChange &&
    previousMetadata?.finalized === true &&
    Array.isArray(previousFacts?.areas) &&
    previousFacts.areas.length > 0
  ) {
    return {
      root: discovery.root,
      mode: "single-pipeline",
      refreshStrategy: "reuse-finalized",
      discovery: previousFacts.discovery ?? discovery,
      refresh: {
        ...refresh,
        reusedAreaIds: previousFacts.areas.map((area) => area.id),
      },
      areas: previousFacts.areas,
      summary: previousFacts.summary ?? buildSummary(discovery, previousFacts.areas, refresh),
      interpreter: previousMetadata.interpreter ?? {
        required: true,
        status: "completed",
      },
      constitutionPath,
      metadataPath,
      factsPath,
      finalized: true,
    };
  }

  const refreshStrategy = determineRefreshStrategy(refresh, previousMetadata?.finalized === true);

  const previousAreas = await readExistingConstitutionAreas(constitutionPath);
  const evaluatedAreas = await buildDeterministicAreas(discovery, refresh.impactedAreaIds, refresh.noChange);
  const areas = mergeAreasWithRefresh(previousAreas, evaluatedAreas, refresh.impactedAreaIds, refresh.noChange);
  const summary = buildSummary(discovery, areas, refresh);

  let interpreter: ConstitutionScanResult["interpreter"];
  if (input.constitutionExecutor) {
    const result = await input.constitutionExecutor.execute({
      executionId: `constitution-${Date.now()}`,
      cwd: discovery.root,
      prompt: buildReasonerPrompt({
        discovery,
        areas,
        impactedAreaIds: refresh.impactedAreaIds,
        changedFiles: refresh.changedFiles,
        strategy: refreshStrategy,
      }),
      tools: ["read", "grep", "find", "ls"],
      metadata: { role: "constitution-reasoner" },
    });
    const proposedAreas = parseAiAreaProposals(result.outputText, areas, refresh.impactedAreaIds);
    interpreter = {
      required: true,
      status: result.status === "completed" ? "completed" : "failed",
      outputText: stripAiAreaJson(result.outputText),
      errorMessage: result.errorMessage,
      proposedAreas,
    };
  } else {
    interpreter = {
      required: true,
      status: "unavailable",
      errorMessage: "No constitution interpreter executor was available.",
    };
  }

  const interpretedAreas = interpreter.proposedAreas && interpreter.proposedAreas.length > 0
    ? mergeAiAreas(areas, interpreter.proposedAreas, refresh.impactedAreaIds)
    : areas;
  const critiquedAreas = critiqueAreas(interpretedAreas);
  const finalAreas = detectAreaContradictions(critiquedAreas);
  const preservedAreas = Array.isArray(previousFacts?.areas) && previousFacts.areas.length > 0
    ? previousFacts.areas
    : undefined;
  const preservedFinalizedConstitution =
    interpreter.status !== "completed" &&
    previousMetadata?.finalized === true &&
    Array.isArray(preservedAreas) &&
    preservedAreas.length > 0;
  const activeAreas = preservedFinalizedConstitution && preservedAreas ? preservedAreas : finalAreas;
  const activeSummary = preservedFinalizedConstitution && preservedAreas
    ? (previousFacts?.summary ?? buildSummary(discovery, preservedAreas, refresh))
    : summary;
  const finalized = interpreter.status === "completed" || preservedFinalizedConstitution;

  await fs.writeFile(
    factsPath,
    JSON.stringify(
      {
        scannedAt: new Date().toISOString(),
        root: discovery.root,
        mode: "single-pipeline",
        refreshStrategy,
        refresh,
        summary,
        discovery,
        areas: finalAreas,
      },
      null,
      2,
    ),
    "utf8",
  );

  if (interpreter.status === "completed") {
    const markdown = renderConstitutionMarkdown({
      discovery,
      areas: finalAreas,
      summary,
      interpreterOutputText: interpreter.outputText,
    });
    await fs.writeFile(constitutionPath, markdown, "utf8");
  }

  await fs.writeFile(
    metadataPath,
    JSON.stringify(
      {
        scannedAt: new Date().toISOString(),
        mode: "single-pipeline",
        refreshStrategy,
        scanSha: refresh.currentScanSha,
        previousScanSha: refresh.previousScanSha,
        refreshMode: refresh.mode,
        changedFiles: refresh.changedFiles,
        impactedAreaIds: refresh.impactedAreaIds,
        trackedFiles: discovery.trackedFiles.length,
        interpreter,
        finalized,
        preservedFinalizedConstitution,
        factsPath,
        constitutionPath,
        criticWarnings: finalAreas.reduce((count, area) => count + (area.criticWarnings?.length ?? 0), 0),
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    root: discovery.root,
    mode: "single-pipeline",
    refreshStrategy,
    discovery,
    refresh: {
      ...refresh,
      reusedAreaIds: preservedFinalizedConstitution && preservedAreas
        ? preservedAreas.map((area) => area.id)
        : previousAreas
            .filter((area) => !refresh.noChange && !refresh.impactedAreaIds.includes(area.id))
            .map((area) => area.id),
    },
    areas: activeAreas,
    summary: activeSummary,
    interpreter,
    constitutionPath,
    metadataPath,
    factsPath,
    finalized,
  };
}

async function buildDeterministicAreas(
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

function determineRefreshStrategy(
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

function buildSummary(
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

function mergeAreasWithRefresh(
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

async function readJson<T>(filePath: string): Promise<T | undefined> {
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

async function readExistingConstitutionAreas(filePath: string): Promise<ConstitutionArea[]> {
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
      const status = /^- Status:\s+([A-Z_]+)(?:\s+\((HIGH|MEDIUM|LOW)\))?$/.exec(line);
      if (status) {
        current.status = status[1] as ConstitutionArea["status"];
        current.confidence = status[2] as ConstitutionArea["confidence"] | undefined;
        continue;
      }
      const finding = /^- Finding:\s+(.+)$/.exec(line);
      if (finding) {
        current.finding = finding[1] ?? "";
        continue;
      }
      const evidence = /^- Evidence:\s+(?:(.+?)\s+—\s+)?(.+)$/.exec(line);
      if (evidence) {
        current.evidence.push({
          kind: "file",
          path: evidence[1] || undefined,
          detail: evidence[2] ?? "",
        });
        continue;
      }
      const claim = /^- Claim:\s+\[([a-z]+)(?:\/(HIGH|MEDIUM|LOW))?\]\s+(.+)$/.exec(line);
      if (claim) {
        current.claims ??= [];
        current.claims.push({
          kind: claim[1] as NonNullable<ConstitutionArea["claims"]>[number]["kind"],
          confidence: claim[2] as ConstitutionArea["confidence"] | undefined,
          statement: claim[3] ?? "",
          evidence: [],
        });
        continue;
      }
      const claimEvidence = /^\s+- Claim evidence:\s+(?:(.+?)\s+—\s+)?(.+)$/.exec(line);
      if (claimEvidence && current.claims && current.claims.length > 0) {
        current.claims[current.claims.length - 1]!.evidence.push({
          kind: "file",
          path: claimEvidence[1] || undefined,
          detail: claimEvidence[2] ?? "",
        });
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

function shouldReusePreviousArea(previous: ConstitutionArea, current: ConstitutionArea): boolean {
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

function critiqueAreas(areas: ConstitutionArea[]): ConstitutionArea[] {
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

function detectAreaContradictions(areas: ConstitutionArea[]): ConstitutionArea[] {
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

function critiqueArea(area: ConstitutionArea): string[] {
  const warnings: string[] = [];
  if ((area.status === "DEFINED" || area.status === "INFERRED") && area.evidence.length === 0) {
    warnings.push("Area makes a concrete claim without supporting evidence.");
  }
  if (looksGeneric(area.finding) && area.status !== "NOT_DEFINED" && area.status !== "NOT_APPLICABLE") {
    warnings.push("Finding is generic or placeholder-like; deepen evidence before trusting this area.");
  }
  return warnings;
}

function critiqueClaim(statement: string, evidence: ConstitutionArea["evidence"], kind: NonNullable<ConstitutionArea["claims"]>[number]["kind"]): string[] {
  const warnings: string[] = [];
  if ((kind === "observed" || kind === "inferred") && evidence.length === 0) {
    warnings.push("Claim lacks direct evidence references.");
  }
  if (looksGeneric(statement)) {
    warnings.push("Claim appears generic enough to fit unrelated repositories.");
  }
  return warnings;
}

function looksPlaceholder(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized.includes("not implemented yet") || normalized.includes("repository evidence exists for this area");
}

function looksGeneric(text: string): boolean {
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

function buildReasonerPrompt(input: {
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

function mergeAiAreas(
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

function parseAiAreaProposals(
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

function extractAiAreaJson(outputText: string): string | undefined {
  const match = /AI_AREA_PROPOSALS_START\s*([\s\S]*?)\s*AI_AREA_PROPOSALS_END/.exec(outputText);
  return match?.[1]?.trim() || undefined;
}

function stripAiAreaJson(outputText: string): string {
  return outputText.replace(/AI_AREA_PROPOSALS_START[\s\S]*?AI_AREA_PROPOSALS_END/g, "").trim();
}

function isValidStatus(value: string): value is ConstitutionArea["status"] {
  return value === "DEFINED" || value === "INFERRED" || value === "NOT_DEFINED" || value === "NOT_APPLICABLE" || value === "UNCERTAIN";
}

function isValidConfidence(value: string): value is NonNullable<ConstitutionArea["confidence"]> {
  return value === "HIGH" || value === "MEDIUM" || value === "LOW";
}
