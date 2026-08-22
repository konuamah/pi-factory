import fs from "node:fs/promises";
import path from "node:path";
import type { ConstitutionArea, ConstitutionEvidence } from "../types.js";
import type { ConstitutionEvaluationContext } from "./shared.js";
import { buildRefreshNote, makeArea } from "./shared.js";

export async function evaluateCiCdAreas(context: ConstitutionEvaluationContext): Promise<ConstitutionArea[]> {
  const { discovery, impactedAreaIds, noChange } = context;
  if (discovery.ciFiles.length === 0) {
    return [
      makeArea(88, "Pipeline stages", "NOT_DEFINED", `No CI pipeline stages detected.${buildRefreshNote(88, impactedAreaIds, noChange)}`, []),
      makeArea(89, "Branch/PR pipeline triggers", "NOT_DEFINED", `No CI trigger configuration detected.${buildRefreshNote(89, impactedAreaIds, noChange)}`, []),
      makeArea(90, "Required quality checks", "NOT_DEFINED", `No required quality checks detected from CI configuration.${buildRefreshNote(90, impactedAreaIds, noChange)}`, []),
      makeArea(91, "Build artifact creation/retention", "NOT_DEFINED", `No build artifact or retention evidence detected.${buildRefreshNote(91, impactedAreaIds, noChange)}`, []),
      makeArea(92, "Pipeline dependency/build caching", "NOT_DEFINED", `No CI caching configuration detected.${buildRefreshNote(92, impactedAreaIds, noChange)}`, []),
      makeArea(93, "Deployment automation", "NOT_DEFINED", `No deployment automation configuration detected.${buildRefreshNote(93, impactedAreaIds, noChange)}`, []),
    ];
  }

  const workflows = await inspectWorkflowFiles(discovery.root, discovery.ciFiles.slice(0, 20));
  const jobNames = dedupe(workflows.flatMap((workflow) => extractJobNames(workflow.content)));
  const triggers = dedupe(workflows.flatMap((workflow) => extractTriggers(workflow.content)));
  const qualityCheckHits = workflows.flatMap((workflow) => extractQualityChecks(workflow.path, workflow.content));
  const artifactHits = workflows.flatMap((workflow) => extractArtifactEvidence(workflow.path, workflow.content));
  const cacheHits = workflows.flatMap((workflow) => extractCacheEvidence(workflow.path, workflow.content));
  const deployHits = workflows.flatMap((workflow) => extractDeployEvidence(workflow.path, workflow.content));

  const jobEvidence: ConstitutionEvidence[] = jobNames.slice(0, 8).map((name) => ({
    kind: "pattern",
    detail: `job: ${name}`,
  }));
  if (jobEvidence.length === 0) {
    jobEvidence.push(...workflows.slice(0, 5).map((workflow) => ({ kind: "file" as const, path: workflow.path, detail: "CI workflow file" })));
  }

  return [
    makeArea(88, "Pipeline stages", jobNames.length > 0 ? "DEFINED" : "INFERRED", `${jobNames.length > 0 ? `Detected CI pipeline jobs/stages: ${jobNames.slice(0, 8).join(", ")}.` : "Workflow files exist, but explicit pipeline stages were not confidently extracted."}${buildRefreshNote(88, impactedAreaIds, noChange)}`, jobEvidence, jobNames.length > 0 ? "HIGH" : "LOW"),
    makeArea(89, "Branch/PR pipeline triggers", triggers.length > 0 ? "DEFINED" : "NOT_DEFINED", `${triggers.length > 0 ? `Workflow triggers detected: ${triggers.slice(0, 8).join(", ")}.` : "No branch, push, pull request, or manual triggers were confidently extracted from CI files."}${buildRefreshNote(89, impactedAreaIds, noChange)}`, triggers.slice(0, 8).map((trigger) => ({ kind: "pattern", detail: `trigger: ${trigger}` })), triggers.length > 0 ? "HIGH" : undefined),
    makeArea(90, "Required quality checks", qualityCheckHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${qualityCheckHits.length > 0 ? `CI workflows include quality checks such as ${dedupe(qualityCheckHits.map((hit) => hit.detail)).slice(0, 8).join(", ")}.` : "No explicit quality checks were extracted from CI files."}${buildRefreshNote(90, impactedAreaIds, noChange)}`, qualityCheckHits.slice(0, 8), qualityCheckHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(91, "Build artifact creation/retention", artifactHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${artifactHits.length > 0 ? "Artifact upload or retention configuration is present in CI workflows." : "No artifact upload or retention configuration was detected."}${buildRefreshNote(91, impactedAreaIds, noChange)}`, artifactHits.slice(0, 8), artifactHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(92, "Pipeline dependency/build caching", cacheHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${cacheHits.length > 0 ? "Caching configuration is present in CI workflows." : "No build or dependency caching configuration was detected."}${buildRefreshNote(92, impactedAreaIds, noChange)}`, cacheHits.slice(0, 8), cacheHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(93, "Deployment automation", deployHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${deployHits.length > 0 ? `Deployment-oriented workflow evidence detected in ${dedupe(deployHits.map((hit) => hit.path ?? "")).filter(Boolean).slice(0, 5).join(", ")}.` : "No deployment automation patterns were detected in CI files."}${buildRefreshNote(93, impactedAreaIds, noChange)}`, deployHits.slice(0, 8), deployHits.length > 0 ? "MEDIUM" : undefined),
  ];
}

async function inspectWorkflowFiles(root: string, files: string[]): Promise<Array<{ path: string; content: string }>> {
  const results = await Promise.all(files.map(async (file) => {
    try {
      const content = await fs.readFile(path.join(root, file), "utf8");
      return { path: file, content };
    } catch {
      return undefined;
    }
  }));
  return results.filter((value): value is { path: string; content: string } => Boolean(value));
}

function extractJobNames(content: string): string[] {
  const match = /(?:^|\n)jobs:\s*([\s\S]*)/m.exec(content);
  if (!match) {
    return [];
  }
  const lines = match[1].split(/\r?\n/);
  const jobs: string[] = [];
  for (const line of lines) {
    if (/^\S/.test(line)) {
      break;
    }
    const job = /^\s{2,}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (job) {
      jobs.push(job[1]!);
    }
  }
  return jobs;
}

function extractTriggers(content: string): string[] {
  const triggers = new Set<string>();
  if (/\bon:\s*(\[[^\]]*push|push:|push\b)/m.test(content)) triggers.add("push");
  if (/pull_request\b/m.test(content)) triggers.add("pull_request");
  if (/workflow_dispatch\b/m.test(content)) triggers.add("workflow_dispatch");
  if (/schedule\b/m.test(content)) triggers.add("schedule");
  if (/release\b/m.test(content)) triggers.add("release");
  if (/tags?:/m.test(content)) triggers.add("tags");
  if (/branches?:/m.test(content)) triggers.add("branches");
  return Array.from(triggers);
}

function extractQualityChecks(filePath: string, content: string): ConstitutionEvidence[] {
  const hits: Array<[RegExp, string]> = [
    [/\btest\b/i, "test"],
    [/\blint\b/i, "lint"],
    [/typecheck|tsc\b/i, "typecheck"],
    [/build\b/i, "build"],
    [/coverage\b/i, "coverage"],
  ];
  return hits
    .filter(([pattern]) => pattern.test(content))
    .map(([, detail]) => ({ kind: "file" as const, path: filePath, detail: `quality check: ${detail}` }));
}

function extractArtifactEvidence(filePath: string, content: string): ConstitutionEvidence[] {
  const evidence: ConstitutionEvidence[] = [];
  if (/upload-artifact|artifacts?:/i.test(content)) {
    evidence.push({ kind: "file", path: filePath, detail: "artifact upload configuration" });
  }
  const retention = /retention-days\s*:\s*(\d+)/i.exec(content);
  if (retention) {
    evidence.push({ kind: "file", path: filePath, detail: `artifact retention: ${retention[1]} days` });
  }
  return evidence;
}

function extractCacheEvidence(filePath: string, content: string): ConstitutionEvidence[] {
  const evidence: ConstitutionEvidence[] = [];
  if (/actions\/cache|cache:\s|setup-node[\s\S]*cache:/i.test(content)) {
    evidence.push({ kind: "file", path: filePath, detail: "dependency/build cache configuration" });
  }
  return evidence;
}

function extractDeployEvidence(filePath: string, content: string): ConstitutionEvidence[] {
  const patterns: Array<[RegExp, string]> = [
    [/deploy\b/i, "deploy job or step"],
    [/release\b/i, "release workflow"],
    [/publish\b/i, "publish step"],
    [/environment\s*:/i, "deployment environment reference"],
  ];
  return patterns
    .filter(([pattern]) => pattern.test(content))
    .map(([, detail]) => ({ kind: "file" as const, path: filePath, detail }));
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
