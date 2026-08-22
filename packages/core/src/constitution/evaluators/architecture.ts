import fs from "node:fs/promises";
import path from "node:path";
import type { ConstitutionArea } from "../types.js";
import type { ConstitutionEvaluationContext } from "./shared.js";
import { buildRefreshNote, distinctRoots, makeArea } from "./shared.js";

export async function evaluateArchitectureAreas(context: ConstitutionEvaluationContext): Promise<ConstitutionArea[]> {
  const { discovery, impactedAreaIds, noChange } = context;
  const packageDirs = distinctPackageDirs(discovery.trackedFiles);
  const sharedDirs = discovery.trackedFiles.filter((file) => /(^|\/)(shared|common|core)\//i.test(file));
  const adapterDirs = discovery.trackedFiles.filter((file) => /(^|\/)(adapters?|executors?)\//i.test(file));
  const tsconfigRefs = await readTsconfigReferences(discovery.root);
  const sourceSample = discovery.sourceFiles.filter((file) => /\.tsx?$/.test(file)).slice(0, 60);
  const imports = await inspectImports(discovery.root, sourceSample);

  const crossPackageImports = imports.filter((item) => /@factory\//.test(item.specifier));
  const relativeUpwardImports = imports.filter((item) => item.specifier.startsWith("../") || item.specifier.startsWith("../../"));
  const runtimeToCoreImports = imports.filter((item) => /packages\/(adapters|executors)\//.test(item.path) && item.specifier.includes("@factory/core"));

  return [
    makeArea(32, "Overall application architecture", packageDirs.length >= 3 ? "INFERRED" : "NOT_DEFINED", `${packageDirs.length >= 3 ? `Repository is organized into multiple top-level packages such as ${packageDirs.slice(0, 6).join(", ")}, suggesting a modular package-based architecture.` : "No strong multi-module application architecture evidence detected."}${buildRefreshNote(32, impactedAreaIds, noChange)}`, packageDirs.slice(0, 8).map((dir) => ({ kind: "file" as const, path: dir, detail: "top-level package/module" })), packageDirs.length >= 3 ? "MEDIUM" : undefined),
    makeArea(33, "Module/package boundaries", packageDirs.length > 0 || tsconfigRefs.length > 0 ? "DEFINED" : "NOT_DEFINED", `${packageDirs.length > 0 || tsconfigRefs.length > 0 ? `Package/module boundaries are explicit via directories and TypeScript project references.` : "No explicit package or module boundary evidence detected."}${buildRefreshNote(33, impactedAreaIds, noChange)}`, [
      ...packageDirs.slice(0, 8).map((dir) => ({ kind: "file" as const, path: dir, detail: "package boundary" })),
      ...tsconfigRefs.slice(0, 6).map((ref) => ({ kind: "pattern" as const, detail: `tsconfig reference: ${ref}` })),
    ], packageDirs.length > 0 || tsconfigRefs.length > 0 ? "HIGH" : undefined),
    makeArea(34, "Layering/dependency direction", runtimeToCoreImports.length > 0 || crossPackageImports.length > 0 ? "INFERRED" : "NOT_DEFINED", `${runtimeToCoreImports.length > 0 ? "Adapters and executors import core packages, suggesting inward dependency direction toward shared core logic." : crossPackageImports.length > 0 ? "Cross-package imports exist, but dependency direction is only partially evident." : "No layering or dependency-direction evidence detected."}${buildRefreshNote(34, impactedAreaIds, noChange)}`, [
      ...runtimeToCoreImports.slice(0, 6).map((item) => ({ kind: "file" as const, path: item.path, detail: `imports ${item.specifier}` })),
      ...crossPackageImports.slice(0, 4).map((item) => ({ kind: "file" as const, path: item.path, detail: `cross-package import ${item.specifier}` })),
    ], runtimeToCoreImports.length > 0 ? "MEDIUM" : crossPackageImports.length > 0 ? "LOW" : undefined),
    makeArea(35, "Feature/domain organization", packageDirs.length > 0 ? "INFERRED" : "NOT_DEFINED", `${packageDirs.length > 0 ? `Code is partitioned by package/function (for example ${packageDirs.slice(0, 6).join(", ")}) more than by a single flat source tree.` : "No clear feature or domain organization evidence detected."}${buildRefreshNote(35, impactedAreaIds, noChange)}`, packageDirs.slice(0, 8).map((dir) => ({ kind: "file" as const, path: dir, detail: "feature/domain package" })), packageDirs.length > 0 ? "MEDIUM" : undefined),
    makeArea(36, "Shared/common code strategy", sharedDirs.length > 0 || discovery.trackedFiles.some((file) => file.startsWith("packages/core/")) || discovery.trackedFiles.some((file) => file.startsWith("packages/schemas/")) ? "INFERRED" : "NOT_DEFINED", `${sharedDirs.length > 0 || discovery.trackedFiles.some((file) => file.startsWith("packages/core/")) || discovery.trackedFiles.some((file) => file.startsWith("packages/schemas/")) ? "Shared logic appears centralized in reusable core/schema packages rather than duplicated per adapter." : "No explicit shared/common code strategy evidence detected."}${buildRefreshNote(36, impactedAreaIds, noChange)}`, [
      ...sharedDirs.slice(0, 6).map((file) => ({ kind: "file" as const, path: file, detail: "shared/common path" })),
      ...["packages/core", "packages/schemas"].filter((dir) => discovery.trackedFiles.some((file) => file.startsWith(`${dir}/`))).map((dir) => ({ kind: "file" as const, path: dir, detail: "shared package" })),
    ], sharedDirs.length > 0 || discovery.trackedFiles.some((file) => file.startsWith("packages/core/")) ? "MEDIUM" : undefined),
    makeArea(37, "Dependency injection/inversion approach", discovery.trackedFiles.some((file) => /factory\.ts$|sdk-factory\.ts$|fake-session-factory\.ts$/.test(file)) ? "INFERRED" : "NOT_DEFINED", `${discovery.trackedFiles.some((file) => /factory\.ts$|sdk-factory\.ts$|fake-session-factory\.ts$/.test(file)) ? "Factory/session abstractions suggest dependency injection via interchangeable factories and executors." : "No explicit dependency injection or inversion approach detected."}${buildRefreshNote(37, impactedAreaIds, noChange)}`, discovery.trackedFiles.filter((file) => /factory\.ts$|sdk-factory\.ts$|fake-session-factory\.ts$/.test(file)).slice(0, 8).map((file) => ({ kind: "file" as const, path: file, detail: "factory/injection boundary" })), discovery.trackedFiles.some((file) => /factory\.ts$|sdk-factory\.ts$|fake-session-factory\.ts$/.test(file)) ? "MEDIUM" : undefined),
    makeArea(38, "Cross-module communication rules", crossPackageImports.length > 0 ? "INFERRED" : "NOT_DEFINED", `${crossPackageImports.length > 0 ? `Cross-module communication is primarily expressed through package imports such as ${crossPackageImports.slice(0, 5).map((item) => item.specifier).join(", ")}.` : "No explicit cross-module communication rules detected."}${buildRefreshNote(38, impactedAreaIds, noChange)}`, crossPackageImports.slice(0, 8).map((item) => ({ kind: "file" as const, path: item.path, detail: `imports ${item.specifier}` })), crossPackageImports.length > 0 ? "MEDIUM" : undefined),
    makeArea(39, "Architectural boundary enforcement", tsconfigRefs.length > 0 || relativeUpwardImports.length > 0 ? "INFERRED" : "NOT_DEFINED", `${tsconfigRefs.length > 0 ? "TypeScript project references provide some structural boundary enforcement between packages." : relativeUpwardImports.length > 0 ? "Relative import patterns show boundaries exist, but explicit enforcement is weak or indirect." : "No architectural boundary enforcement evidence detected."}${buildRefreshNote(39, impactedAreaIds, noChange)}`, [
      ...tsconfigRefs.slice(0, 6).map((ref) => ({ kind: "pattern" as const, detail: `tsconfig reference: ${ref}` })),
      ...relativeUpwardImports.slice(0, 4).map((item) => ({ kind: "file" as const, path: item.path, detail: `relative boundary import ${item.specifier}` })),
    ], tsconfigRefs.length > 0 ? "MEDIUM" : relativeUpwardImports.length > 0 ? "LOW" : undefined),
  ];
}

function distinctPackageDirs(files: string[]): string[] {
  const packages = new Set<string>();
  for (const file of files) {
    const match = /^packages\/([^/]+)\//.exec(file);
    if (match?.[1]) {
      packages.add(`packages/${match[1]}`);
    }
  }
  return Array.from(packages).sort();
}

async function readTsconfigReferences(root: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(root, "tsconfig.json"), "utf8");
    const parsed = JSON.parse(raw) as { references?: Array<{ path?: string }> };
    return (parsed.references ?? []).map((item) => item.path).filter((value): value is string => Boolean(value));
  } catch {
    return [];
  }
}

async function inspectImports(root: string, files: string[]): Promise<Array<{ path: string; specifier: string }>> {
  const results = await Promise.all(files.map(async (file) => {
    try {
      const content = await fs.readFile(path.join(root, file), "utf8");
      const matches = Array.from(content.matchAll(/from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g));
      return matches.map((match) => ({ path: file, specifier: match[1] ?? match[2] ?? "" })).filter((item) => item.specifier.length > 0);
    } catch {
      return [];
    }
  }));
  return results.flat();
}
