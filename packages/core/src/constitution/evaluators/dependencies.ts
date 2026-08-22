import fs from "node:fs/promises";
import path from "node:path";
import type { ConstitutionArea } from "../types.js";
import type { ConstitutionEvaluationContext } from "./shared.js";
import { buildRefreshNote, makeArea } from "./shared.js";

export async function evaluateDependencyAndConfigAreas(context: ConstitutionEvaluationContext): Promise<ConstitutionArea[]> {
  const { discovery, impactedAreaIds, noChange } = context;
  const manifestFiles = dedupe([
    ...discovery.manifests,
    ...discovery.lockfiles,
    ...discovery.envFiles,
    ...discovery.docsFiles,
    ...discovery.ciFiles,
    ...discovery.trackedFiles.filter((file) => /(^|\/)(\.npmrc|\.yarnrc|\.pnpmrc|dependabot\.yml|dependabot\.yaml)$/i.test(file)),
  ]).slice(0, 40);
  const inspected = await inspectFiles(discovery.root, manifestFiles);

  const versionPolicyHits = inspected.filter((file) => /(\^\d|~\d|workspace:|pinned|lockfile|package-lock|pnpm-lock|yarn\.lock)/i.test(file.content) || /package-lock\.json|pnpm-lock\.yaml|yarn\.lock/i.test(file.path));
  const privateRegistryHits = inspected.filter((file) =>
    ((/(registry=|authToken|_authToken|scope=)/i.test(file.content) && !/registry\.npmjs\.org/i.test(file.content)) ||
    /(^|\/)(\.npmrc|\.yarnrc|\.pnpmrc)$/i.test(file.path)) &&
    !/package-lock\.json$/i.test(file.path),
  );
  const vulnLicenseHits = inspected.filter((file) => /(dependabot|npm audit|snyk|osv|trivy|dependency review)/i.test(file.content) || /dependabot\.ya?ml/i.test(file.path));
  const secretsHandlingHits = inspected.filter((file) =>
    /(secret|token|credential|vault|environment variables)/i.test(file.content) &&
    !/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(file.path),
  );
  const configHierarchyHits = inspected.filter((file) => /(built-ins < global defaults < project config < run overrides|global defaults|project config|run overrides|override)/i.test(file.content));

  return [
    makeArea(12, "Dependency version policy", versionPolicyHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${versionPolicyHits.length > 0 ? `Dependency versioning policy is implied by lockfiles and/or manifest version expressions in ${versionPolicyHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No dependency version policy evidence detected."}${buildRefreshNote(12, impactedAreaIds, noChange)}`, versionPolicyHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(\^\d|~\d|workspace:|pinned|lockfile|package-lock|pnpm-lock|yarn\.lock)/i, "dependency version policy") })), versionPolicyHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(13, "Private registry/package source usage", privateRegistryHits.length > 0 ? "UNCERTAIN" : "NOT_DEFINED", `${privateRegistryHits.length > 0 ? `Registry or package-source configuration exists in ${privateRegistryHits.slice(0, 5).map((file) => file.path).join(", ")}, but private registry usage is not yet conclusively distinguished from public npm defaults.` : "No private registry or package-source override evidence detected."}${buildRefreshNote(13, impactedAreaIds, noChange)}`, privateRegistryHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(registry=|npmrc|yarnrc|pnpmrc|authToken|_authToken|scope=|registry\.npmjs\.org)/i, "registry/package source config") })), privateRegistryHits.length > 0 ? "LOW" : undefined),
    makeArea(14, "Dependency vulnerability/licensing controls", vulnLicenseHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${vulnLicenseHits.length > 0 ? `Dependency vulnerability controls are referenced in ${vulnLicenseHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No dependency vulnerability or licensing control evidence detected."}${buildRefreshNote(14, impactedAreaIds, noChange)}`, vulnLicenseHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(dependabot|npm audit|snyk|osv|trivy|dependency review)/i, "dependency vulnerability control") })), vulnLicenseHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(17, "Secrets handling", secretsHandlingHits.length > 0 || discovery.envFiles.length > 0 ? (secretsHandlingHits.length > 0 ? "INFERRED" : "UNCERTAIN") : "NOT_DEFINED", `${secretsHandlingHits.length > 0 ? `Secrets or credentials handling is referenced in ${secretsHandlingHits.slice(0, 5).map((file) => file.path).join(", ")}.` : discovery.envFiles.length > 0 ? `Environment files exist (${discovery.envFiles.slice(0, 5).join(", ")}), but explicit secrets handling guidance is limited.` : "No secrets handling evidence detected."}${buildRefreshNote(17, impactedAreaIds, noChange)}`, [
      ...secretsHandlingHits.slice(0, 6).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(secret|token|credential|vault|environment variables)/i, "secrets handling") })),
      ...discovery.envFiles.slice(0, 3).map((file) => ({ kind: "file" as const, path: file, detail: "environment file" })),
    ], secretsHandlingHits.length > 0 ? "MEDIUM" : discovery.envFiles.length > 0 ? "LOW" : undefined),
    makeArea(18, "Configuration hierarchy", configHierarchyHits.length > 0 || discovery.trackedFiles.some((file) => file === "factory.yaml" || file === ".factory/config.yaml") ? "INFERRED" : "NOT_DEFINED", `${configHierarchyHits.length > 0 ? `Configuration precedence or override layering is documented in ${configHierarchyHits.slice(0, 5).map((file) => file.path).join(", ")}.` : discovery.trackedFiles.some((file) => file === "factory.yaml" || file === ".factory/config.yaml") ? "Repository uses multiple authoritative config files, suggesting an explicit configuration hierarchy." : "No configuration hierarchy evidence detected."}${buildRefreshNote(18, impactedAreaIds, noChange)}`, [
      ...configHierarchyHits.slice(0, 6).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(built-ins < global defaults < project config < run overrides|global defaults|project config|run overrides|override)/i, "configuration hierarchy") })),
      ...["factory.yaml", ".factory/config.yaml"].filter((file) => discovery.trackedFiles.includes(file)).map((file) => ({ kind: "file" as const, path: file, detail: "authoritative config file" })),
    ], configHierarchyHits.length > 0 || discovery.trackedFiles.some((file) => file === "factory.yaml" || file === ".factory/config.yaml") ? "MEDIUM" : undefined),
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
