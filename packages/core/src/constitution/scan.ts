import fs from "node:fs/promises";
import path from "node:path";
import type { AgentExecutor } from "../runtime/interfaces.js";
import { CONSTITUTION_AREA_DEFINITIONS } from "./areas.js";
import { discoverConstitutionRepository } from "./discovery.js";
import { detectConstitutionRefreshState } from "./refresh.js";
import { renderConstitutionMarkdown } from "./render.js";
import type { ConstitutionArea, ConstitutionScanResult } from "./types.js";

export async function runConstitutionScan(input: {
  cwd: string;
  constitutionExecutor?: AgentExecutor;
}): Promise<ConstitutionScanResult> {
  const discovery = await discoverConstitutionRepository(input.cwd);
  const refresh = await detectConstitutionRefreshState(discovery.root);
  const constitutionDir = path.join(discovery.root, ".factory", "constitution");
  const constitutionPath = path.join(discovery.root, "CONSTITUTION.md");
  const previousAreas = await readExistingConstitutionAreas(constitutionPath);
  const evaluatedAreas = buildDeterministicAreas(discovery, refresh.impactedAreaIds, refresh.noChange);
  const areas = mergeAreasWithRefresh(previousAreas, evaluatedAreas, refresh.impactedAreaIds, refresh.noChange);
  const summary = buildSummary(discovery, areas, refresh);
  const metadataPath = path.join(constitutionDir, "metadata.json");
  await fs.mkdir(constitutionDir, { recursive: true });

  let aiReasoning: ConstitutionScanResult["aiReasoning"];
  if (input.constitutionExecutor) {
    const result = await input.constitutionExecutor.execute({
      executionId: `constitution-${Date.now()}`,
      cwd: discovery.root,
      prompt: buildReasonerPrompt(discovery, areas, refresh.impactedAreaIds),
      tools: ["read", "grep", "find", "ls"],
      metadata: { role: "constitution-reasoner" },
    });
    const proposedAreas = parseAiAreaProposals(result.outputText, areas, refresh.impactedAreaIds);
    aiReasoning = {
      enabled: true,
      status: result.status === "completed" ? "completed" : "failed",
      outputText: stripAiAreaJson(result.outputText),
      errorMessage: result.errorMessage,
      proposedAreas,
    };
  } else {
    aiReasoning = {
      enabled: false,
      status: "skipped",
    };
  }

  const finalAreas = aiReasoning?.proposedAreas && aiReasoning.proposedAreas.length > 0
    ? mergeAiAreas(areas, aiReasoning.proposedAreas, refresh.impactedAreaIds)
    : areas;

  const markdown = renderConstitutionMarkdown({
    discovery,
    areas: finalAreas,
    summary,
    aiOutputText: aiReasoning.outputText,
  });
  await fs.writeFile(constitutionPath, markdown, "utf8");
  await fs.writeFile(
    metadataPath,
    JSON.stringify(
      {
        scannedAt: new Date().toISOString(),
        mode: aiReasoning.enabled ? "hybrid" : "deterministic",
        scanSha: refresh.currentScanSha,
        previousScanSha: refresh.previousScanSha,
        refreshMode: refresh.mode,
        changedFiles: refresh.changedFiles,
        impactedAreaIds: refresh.impactedAreaIds,
        trackedFiles: discovery.trackedFiles.length,
        aiReasoning,
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    root: discovery.root,
    mode: aiReasoning.enabled ? "hybrid" : "deterministic",
    discovery,
    refresh: {
      ...refresh,
      reusedAreaIds: previousAreas
        .filter((area) => !refresh.noChange && !refresh.impactedAreaIds.includes(area.id))
        .map((area) => area.id),
    },
    areas: finalAreas,
    summary,
    aiReasoning,
    constitutionPath,
    metadataPath,
  };
}

function buildDeterministicAreas(
  discovery: ConstitutionScanResult["discovery"],
  impactedAreaIds: number[],
  noChange: boolean,
): ConstitutionArea[] {
  const implementedAreas: ConstitutionArea[] = [
    makeArea(1, "Repository layout", "DEFINED", `Tracked repository with ${discovery.trackedFiles.length} files and source roots in ${distinctRoots(discovery.sourceFiles).join(", ") || "none"}.${buildRefreshNote(1, impactedAreaIds, noChange)}`, distinctRoots(discovery.sourceFiles).map((root) => ({ kind: "file" as const, path: root, detail: "source root" }))),
    makeArea(2, "Monorepo / single-project model", discovery.trackedFiles.some((file) => file.startsWith("packages/")) ? "INFERRED" : "DEFINED", `${discovery.trackedFiles.some((file) => file.startsWith("packages/")) ? "Repository appears to use a package-based monorepo layout." : "Repository appears to be a single primary project."}${buildRefreshNote(2, impactedAreaIds, noChange)}`, discovery.manifests.map((file) => ({ kind: "file" as const, path: file, detail: "workspace/manifests" })), discovery.trackedFiles.some((file) => file.startsWith("packages/")) ? "HIGH" : undefined),
    makeArea(3, "Source directory organization", discovery.sourceFiles.length > 0 ? "DEFINED" : "NOT_DEFINED", `${distinctRoots(discovery.sourceFiles).length > 0 ? `Detected source roots: ${distinctRoots(discovery.sourceFiles).join(", ")}.` : "No source roots detected."}${buildRefreshNote(3, impactedAreaIds, noChange)}`, distinctRoots(discovery.sourceFiles).map((root) => ({ kind: "file" as const, path: root, detail: "source organization" }))),
    makeArea(4, "Test directory organization", discovery.testFiles.length > 0 ? "INFERRED" : "NOT_DEFINED", `${discovery.testFiles.length > 0 ? `Detected ${discovery.testFiles.length} test files and directories.` : "No test files detected."}${buildRefreshNote(4, impactedAreaIds, noChange)}`, discovery.testFiles.slice(0, 10).map((file) => ({ kind: "file" as const, path: file, detail: "test organization" })), discovery.testFiles.length > 0 ? "HIGH" : undefined),
    makeArea(5, "Documentation organization", discovery.docsFiles.length > 0 ? "DEFINED" : "NOT_DEFINED", `${discovery.docsFiles.length > 0 ? `Detected documentation files in ${distinctRoots(discovery.docsFiles).join(", ")}.` : "No documentation files detected beyond defaults."}${buildRefreshNote(5, impactedAreaIds, noChange)}`, discovery.docsFiles.slice(0, 10).map((file) => ({ kind: "file" as const, path: file, detail: "documentation file" }))),
    makeArea(6, "Script/tool directory organization", discovery.scriptFiles.length > 0 ? "DEFINED" : "NOT_DEFINED", `${discovery.scriptFiles.length > 0 ? `Detected script/tool directories in ${distinctRoots(discovery.scriptFiles).join(", ")}.` : "No dedicated scripts/tools directories detected."}${buildRefreshNote(6, impactedAreaIds, noChange)}`, discovery.scriptFiles.slice(0, 10).map((file) => ({ kind: "file" as const, path: file, detail: "script/tool file" }))),
    makeArea(7, "Generated/build directory handling", discovery.generatedFiles.length > 0 ? "DEFINED" : "INFERRED", `${discovery.generatedFiles.length > 0 ? `Generated/build outputs are present under ${distinctRoots(discovery.generatedFiles).join(", ")}.` : "Generated/build directories are excluded from constitution scanning by policy."}${buildRefreshNote(7, impactedAreaIds, noChange)}`, discovery.generatedFiles.slice(0, 10).map((file) => ({ kind: "file" as const, path: file, detail: "generated/build output" }))),
    makeArea(8, "Asset/static file organization", discovery.assetFiles.length > 0 ? "INFERRED" : "NOT_APPLICABLE", `${discovery.assetFiles.length > 0 ? `Detected ${discovery.assetFiles.length} asset/static files.` : "No obvious asset/static file organization detected."}${buildRefreshNote(8, impactedAreaIds, noChange)}`, discovery.assetFiles.slice(0, 10).map((file) => ({ kind: "file" as const, path: file, detail: "asset/static file" })), discovery.assetFiles.length > 0 ? "MEDIUM" : undefined),
    makeArea(9, "Package/dependency manager", discovery.packageManagers.length > 0 ? "DEFINED" : "NOT_DEFINED", `${discovery.packageManagers.length > 0 ? `Detected package managers: ${discovery.packageManagers.join(", ")}.` : "No package manager could be determined."}${buildRefreshNote(9, impactedAreaIds, noChange)}`, [...discovery.manifests, ...discovery.lockfiles].map((file) => ({ kind: "file" as const, path: file, detail: "package manager evidence" }))),
    makeArea(10, "Manifest files", discovery.manifests.length > 0 ? "DEFINED" : "NOT_DEFINED", `${discovery.manifests.length > 0 ? `Detected manifests: ${discovery.manifests.join(", ")}.` : "No manifests detected."}${buildRefreshNote(10, impactedAreaIds, noChange)}`, discovery.manifests.map((file) => ({ kind: "file" as const, path: file, detail: "manifest file" }))),
    makeArea(11, "Lockfile strategy", discovery.lockfiles.length > 0 ? "DEFINED" : "NOT_DEFINED", `${discovery.lockfiles.length > 0 ? `Detected lockfiles: ${discovery.lockfiles.join(", ")}.` : "No lockfiles detected."}${buildRefreshNote(11, impactedAreaIds, noChange)}`, discovery.lockfiles.map((file) => ({ kind: "file" as const, path: file, detail: "lockfile" }))),
    makeArea(15, "Environment separation", discovery.envFiles.length > 0 ? "INFERRED" : "NOT_DEFINED", `${discovery.envFiles.length > 0 ? `Detected environment files: ${discovery.envFiles.join(", ")}.` : "No environment separation files detected."}${buildRefreshNote(15, impactedAreaIds, noChange)}`, discovery.envFiles.map((file) => ({ kind: "file" as const, path: file, detail: "environment file" })), discovery.envFiles.length > 0 ? "MEDIUM" : undefined),
    makeArea(16, "Environment variable conventions", discovery.envFiles.length > 0 ? "INFERRED" : "NOT_DEFINED", `${discovery.envFiles.length > 0 ? "Environment variables appear to be file-driven via .env-style files." : "No environment variable convention evidence detected."}${buildRefreshNote(16, impactedAreaIds, noChange)}`, discovery.envFiles.map((file) => ({ kind: "file" as const, path: file, detail: "environment convention" })), discovery.envFiles.length > 0 ? "MEDIUM" : undefined),
    makeArea(19, "Runtime/language version pinning", discovery.versionFiles.length > 0 ? "DEFINED" : "NOT_DEFINED", `${discovery.versionFiles.length > 0 ? `Detected runtime/version pinning evidence in ${discovery.versionFiles.join(", ")}.` : "No explicit runtime/version pinning detected."}${buildRefreshNote(19, impactedAreaIds, noChange)}`, discovery.versionFiles.map((file) => ({ kind: "file" as const, path: file, detail: "runtime/version file" }))),
    makeArea(20, "Local development bootstrap", Object.keys(discovery.commands).length > 0 ? "DEFINED" : "NOT_DEFINED", `${Object.keys(discovery.commands).length > 0 ? `Repository bootstrap/developer commands are script-driven: ${Object.keys(discovery.commands).join(", ")}.` : "No local bootstrap commands detected."}${buildRefreshNote(20, impactedAreaIds, noChange)}`, Object.entries(discovery.commands).map(([name, value]) => ({ kind: "pattern" as const, detail: `${name}: ${value}` }))),
    makeArea(21, "Containerized development/runtime configuration", discovery.dockerFiles.length > 0 ? "DEFINED" : "NOT_APPLICABLE", `${discovery.dockerFiles.length > 0 ? `Detected container files: ${discovery.dockerFiles.join(", ")}.` : "No containerized runtime configuration detected."}${buildRefreshNote(21, impactedAreaIds, noChange)}`, discovery.dockerFiles.map((file) => ({ kind: "file" as const, path: file, detail: "container file" }))),
    makeArea(73, "Test framework/tooling", discovery.testFiles.length > 0 ? "INFERRED" : "NOT_DEFINED", `${discovery.testFiles.length > 0 ? "Test tooling is implied by test file presence and package scripts." : "No test framework/tooling evidence detected."}${buildRefreshNote(73, impactedAreaIds, noChange)}`, discovery.testFiles.slice(0, 10).map((file) => ({ kind: "file" as const, path: file, detail: "test framework evidence" })), discovery.testFiles.length > 0 ? "MEDIUM" : undefined),
    makeArea(81, "Build commands/tooling", discovery.commands.build ? "DEFINED" : "NOT_DEFINED", `${discovery.commands.build ? `Build command detected: ${discovery.commands.build}.` : "No build command detected."}${buildRefreshNote(81, impactedAreaIds, noChange)}`, discovery.commands.build ? [{ kind: "pattern" as const, detail: `build: ${discovery.commands.build}` }] : []),
    makeArea(83, "Linting rules/tooling", discovery.lintFiles.length > 0 || Boolean(discovery.commands.lint) ? "DEFINED" : "NOT_DEFINED", `${discovery.lintFiles.length > 0 || discovery.commands.lint ? `Linting evidence detected${discovery.commands.lint ? ` with command ${discovery.commands.lint}` : ""}.` : "No linting rules/tooling detected."}${buildRefreshNote(83, impactedAreaIds, noChange)}`, [...discovery.lintFiles.map((file) => ({ kind: "file" as const, path: file, detail: "lint config" })), ...(discovery.commands.lint ? [{ kind: "pattern" as const, detail: `lint: ${discovery.commands.lint}` }] : [])]),
    makeArea(84, "Formatting rules/tooling", discovery.formatFiles.length > 0 ? "DEFINED" : "NOT_DEFINED", `${discovery.formatFiles.length > 0 ? `Formatting configuration detected in ${discovery.formatFiles.join(", ")}.` : "No formatting rules/tooling detected."}${buildRefreshNote(84, impactedAreaIds, noChange)}`, discovery.formatFiles.map((file) => ({ kind: "file" as const, path: file, detail: "format config" }))),
    makeArea(85, "Type checking/static analysis", discovery.typecheckFiles.length > 0 || Boolean(discovery.commands.typecheck) ? "DEFINED" : "NOT_DEFINED", `${discovery.typecheckFiles.length > 0 || discovery.commands.typecheck ? `Type checking/static analysis evidence detected${discovery.commands.typecheck ? ` with command ${discovery.commands.typecheck}` : ""}.` : "No type checking/static analysis detected."}${buildRefreshNote(85, impactedAreaIds, noChange)}`, [...discovery.typecheckFiles.map((file) => ({ kind: "file" as const, path: file, detail: "typecheck config" })), ...(discovery.commands.typecheck ? [{ kind: "pattern" as const, detail: `typecheck: ${discovery.commands.typecheck}` }] : [])]),
    makeArea(87, "CI/CD platform", discovery.ciFiles.length > 0 ? "DEFINED" : "NOT_DEFINED", `${discovery.ciFiles.some((file) => file.startsWith(".github/workflows/")) ? "GitHub Actions appears to be the CI/CD platform." : discovery.ciFiles.length > 0 ? `CI/CD platform files detected: ${discovery.ciFiles.join(", ")}.` : "No CI/CD platform detected."}${buildRefreshNote(87, impactedAreaIds, noChange)}`, discovery.ciFiles.map((file) => ({ kind: "file" as const, path: file, detail: "CI/CD platform file" }))),
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
  ];
}

function makeArea(
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
  };
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
      if (previous) {
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
      }
    }

    if (current) {
      areas.push(current);
    }

    return areas;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function buildRefreshNote(areaId: number, impactedAreaIds: number[], noChange: boolean): string {
  if (noChange) {
    return " Refresh detected no file changes since the last scan.";
  }
  if (impactedAreaIds.includes(areaId)) {
    return " Refresh impact routing marked this area as affected by recent file changes.";
  }
  return "";
}

function distinctRoots(files: string[]): string[] {
  return Array.from(new Set(files.map((file) => file.split("/")[0]!).filter(Boolean))).sort();
}

function buildReasonerPrompt(
  discovery: ConstitutionScanResult["discovery"],
  areas: ConstitutionArea[],
  impactedAreaIds: number[],
): string {
  return [
    "You are a constitution reasoner.",
    "Use only the provided repository evidence.",
    `Root: ${discovery.root}`,
    `Languages: ${discovery.languages.join(", ") || "none"}`,
    `Package managers: ${discovery.packageManagers.join(", ") || "none"}`,
    `Instructions: ${discovery.instructionFiles.slice(0, 20).join(", ") || "none"}`,
    `Manifests: ${discovery.manifests.join(", ") || "none"}`,
    `Tests: ${discovery.testFiles.slice(0, 20).join(", ") || "none"}`,
    `CI: ${discovery.ciFiles.join(", ") || "none"}`,
    "Summarize actual repository architecture and conventions briefly. Mention ambiguity explicitly.",
    `Impacted areas: ${impactedAreaIds.join(", ") || "none"}`,
    `Seed findings: ${areas.map((area) => `${area.id}:${area.title}=${area.status}`).join("; ")}`,
    "After your notes, optionally emit JSON between AI_AREA_PROPOSALS_START and AI_AREA_PROPOSALS_END.",
    "JSON format: [{ id, status, confidence?, finding, driftWarnings? }].",
    "Only propose updates for impacted or uncertain areas. Do not invent evidence paths.",
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
    return {
      ...area,
      status: proposed.status,
      confidence: proposed.confidence,
      finding: proposed.finding || area.finding,
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
