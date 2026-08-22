import fs from "node:fs/promises";
import path from "node:path";
import type { ConstitutionArea } from "../types.js";
import type { ConstitutionEvaluationContext } from "./shared.js";
import { buildRefreshNote, makeArea } from "./shared.js";

export async function evaluateMaintainabilityAreas(context: ConstitutionEvaluationContext): Promise<ConstitutionArea[]> {
  const { discovery, impactedAreaIds, noChange } = context;
  const candidateFiles = dedupe([
    ...discovery.docsFiles,
    ...discovery.envFiles,
    ...discovery.ciFiles,
    ...discovery.manifests,
    ...discovery.sourceFiles,
    ...discovery.dataFiles,
  ]).filter((file) =>
    /\.(ts|tsx|md|json|ya?ml|sql|prisma)$/i.test(file) &&
    !/packages\/core\/src\/constitution\//i.test(file) &&
    !/^CONSTITUTION\.md$/i.test(file) &&
    !/^constitution_.*\.md$/i.test(file),
  ).slice(0, 80);
  const inspected = await inspectFiles(discovery.root, candidateFiles);

  const sensitiveHits = inspected.filter((file) => /(pii|personal data|sensitive data|privacy|secret|token|credential|customer data)/i.test(file.content));
  const auditHits = inspected.filter((file) => /(audit|retention|access log|event log|history|appendFactoryRunEvent|events\.jsonl)/i.test(file.content));
  const debtHits = inspected.filter((file) => /(technical debt|refactor|cleanup|debt|legacy|TODO|FIXME|HACK|duplicate)/i.test(file.content));
  const simplicityHits = inspected.filter((file) => /(minimal|simple|reuse|shared|avoid overengineering|prototype|single source of truth)/i.test(file.content));

  return [
    makeArea(117, "Sensitive/PII data handling", sensitiveHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${sensitiveHits.length > 0 ? `Sensitive-data or privacy-related language detected in ${sensitiveHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No sensitive/PII data handling evidence detected."}${buildRefreshNote(117, impactedAreaIds, noChange)}`, sensitiveHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(pii|personal data|sensitive data|privacy|secret|token|credential|customer data)/i, "sensitive-data handling") })), sensitiveHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(118, "Audit/retention/access logging controls", auditHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${auditHits.length > 0 ? `Audit, retention, or access-logging evidence detected in ${auditHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No audit, retention, or access-logging evidence detected."}${buildRefreshNote(118, impactedAreaIds, noChange)}`, auditHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(audit|retention|access log|event log|history|appendFactoryRunEvent|events\.jsonl)/i, "audit/retention/access logging") })), auditHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(119, "Complexity/duplication/technical-debt controls", debtHits.length > 0 || discovery.lintFiles.length > 0 ? (debtHits.length > 0 ? "INFERRED" : "UNCERTAIN") : "NOT_DEFINED", `${debtHits.length > 0 ? `Technical-debt or cleanup signals appear in ${debtHits.slice(0, 5).map((file) => file.path).join(", ")}.` : discovery.lintFiles.length > 0 ? "Tooling exists that may help control complexity, but explicit technical-debt policy is not documented." : "No complexity, duplication, or technical-debt control evidence detected."}${buildRefreshNote(119, impactedAreaIds, noChange)}`, [
      ...debtHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(technical debt|refactor|cleanup|debt|legacy|TODO|FIXME|HACK|duplicate)/i, "technical-debt signal") })),
      ...discovery.lintFiles.slice(0, 3).map((file) => ({ kind: "file" as const, path: file, detail: "lint/static-analysis config" })),
    ], debtHits.length > 0 ? "MEDIUM" : discovery.lintFiles.length > 0 ? "LOW" : undefined),
    makeArea(120, "Simplicity/reuse/anti-overengineering conventions", simplicityHits.length > 0 || discovery.trackedFiles.some((file) => file.startsWith("packages/core/")) ? "INFERRED" : "NOT_DEFINED", `${simplicityHits.length > 0 ? `Simplicity, reuse, or minimalism language detected in ${simplicityHits.slice(0, 5).map((file) => file.path).join(", ")}.` : discovery.trackedFiles.some((file) => file.startsWith("packages/core/")) ? "Repository structure favors shared reusable packages, which suggests some anti-duplication and reuse intent." : "No simplicity/reuse/anti-overengineering evidence detected."}${buildRefreshNote(120, impactedAreaIds, noChange)}`, [
      ...simplicityHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(minimal|simple|reuse|shared|avoid overengineering|prototype|single source of truth)/i, "simplicity/reuse signal") })),
      ...discovery.trackedFiles.some((file) => file.startsWith("packages/core/")) ? [{ kind: "file" as const, path: "packages/core", detail: "shared core package" }] : [],
    ], simplicityHits.length > 0 || discovery.trackedFiles.some((file) => file.startsWith("packages/core/")) ? "MEDIUM" : undefined),
  ];
}

async function inspectFiles(root: string, files: string[]): Promise<Array<{ path: string; content: string }>> {
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

function summarizeMatch(content: string, pattern: RegExp, fallback: string): string {
  const match = pattern.exec(content);
  return match?.[0] ?? fallback;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
