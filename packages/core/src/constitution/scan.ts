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
import { readJson, readExistingConstitutionAreas, buildDeterministicAreas, determineRefreshStrategy, buildSummary, mergeAreasWithRefresh, shouldReusePreviousArea, critiqueAreas, detectAreaContradictions, buildReasonerPrompt, mergeAiAreas, parseAiAreaProposals, extractAiAreaJson, stripAiAreaJson } from "./constitution-scan-helpers.js";

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
