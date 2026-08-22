import fs from "node:fs/promises";
import path from "node:path";
import type { ConstitutionArea } from "../types.js";
import type { ConstitutionEvaluationContext } from "./shared.js";
import { buildRefreshNote, makeArea } from "./shared.js";

export async function evaluateStyleAreas(context: ConstitutionEvaluationContext): Promise<ConstitutionArea[]> {
  const { discovery, impactedAreaIds, noChange } = context;
  const sourceFiles = discovery.sourceFiles.filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)).slice(0, 80);
  const inspected = await inspectFiles(discovery.root, sourceFiles);

  const kebabFileNames = sourceFiles.filter((file) => /(^|\/)[a-z0-9]+(?:-[a-z0-9]+)+\.[^.]+$/.test(file));
  const camelOrPascalFileNames = sourceFiles.filter((file) => /(^|\/)([a-z]+[A-Z]|[A-Z][a-zA-Z0-9]*)\.[^.]+$/.test(file));
  const interfaceHits = inspected.filter((file) => /\binterface\s+[A-Z][A-Za-z0-9]*/.test(file.content));
  const classHits = inspected.filter((file) => /\bclass\s+[A-Z][A-Za-z0-9]*/.test(file.content));
  const functionHits = inspected.filter((file) => /\bfunction\s+[a-z][A-Za-z0-9]*|const\s+[a-z][A-Za-z0-9]*\s*=\s*(async\s*)?\(/.test(file.content));
  const constantHits = inspected.filter((file) => /\bconst\s+[A-Z][A-Z0-9_]*\b/.test(file.content));
  const importExportHits = inspected.filter((file) => /\bimport\b[\s\S]*?from\s+['"][^'"]+['"]|\bexport\s+(?:type|interface|class|function|const|\{)/.test(file.content));
  const commentHits = inspected.filter((file) => /\/\*\*|\/\/|README|@param|@returns/.test(file.content));
  const todoHits = inspected.filter((file) => /TODO|FIXME|HACK/.test(file.content));

  const fileNamingStatus = kebabFileNames.length > 0 || camelOrPascalFileNames.length > 0 ? "INFERRED" : "NOT_DEFINED";
  const fileNamingFinding = kebabFileNames.length >= camelOrPascalFileNames.length && kebabFileNames.length > 0
    ? `File names commonly use kebab-case patterns such as ${kebabFileNames.slice(0, 5).join(", ")}.`
    : camelOrPascalFileNames.length > 0
      ? `File names commonly use camelCase or PascalCase patterns such as ${camelOrPascalFileNames.slice(0, 5).join(", ")}.`
      : "No strong file naming convention evidence detected.";

  return [
    makeArea(22, "File naming conventions", fileNamingStatus, `${fileNamingFinding}${buildRefreshNote(22, impactedAreaIds, noChange)}`, [
      ...kebabFileNames.slice(0, 4).map((file) => ({ kind: "file" as const, path: file, detail: "kebab-case file name" })),
      ...camelOrPascalFileNames.slice(0, 4).map((file) => ({ kind: "file" as const, path: file, detail: "camelCase/PascalCase file name" })),
    ], fileNamingStatus === "INFERRED" ? "MEDIUM" : undefined),
    makeArea(23, "Type/class/component naming", interfaceHits.length > 0 || classHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${interfaceHits.length > 0 || classHits.length > 0 ? "Types, interfaces, or classes commonly use PascalCase identifiers." : "No clear type/class/component naming convention evidence detected."}${buildRefreshNote(23, impactedAreaIds, noChange)}`, [
      ...interfaceHits.slice(0, 4).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /\binterface\s+[A-Z][A-Za-z0-9]*/i, "interface naming") })),
      ...classHits.slice(0, 4).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /\bclass\s+[A-Z][A-Za-z0-9]*/i, "class naming") })),
    ], interfaceHits.length > 0 || classHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(24, "Variable/function naming", functionHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${functionHits.length > 0 ? "Functions and local identifiers commonly use camelCase names." : "No clear variable/function naming convention evidence detected."}${buildRefreshNote(24, impactedAreaIds, noChange)}`, functionHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /\bfunction\s+[a-z][A-Za-z0-9]*|const\s+[a-z][A-Za-z0-9]*\s*=\s*(async\s*)?\(/i, "function/variable naming") })), functionHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(25, "Constant naming", constantHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${constantHits.length > 0 ? "Some constants use SCREAMING_SNAKE_CASE identifiers." : "No strong constant naming convention evidence detected."}${buildRefreshNote(25, impactedAreaIds, noChange)}`, constantHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /\bconst\s+[A-Z][A-Z0-9_]*\b/i, "constant naming") })), constantHits.length > 0 ? "LOW" : undefined),
    makeArea(26, "Import/export conventions", importExportHits.length > 0 ? "DEFINED" : "NOT_DEFINED", `${importExportHits.length > 0 ? "Modules consistently use ES module import/export syntax." : "No import/export convention evidence detected."}${buildRefreshNote(26, impactedAreaIds, noChange)}`, importExportHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /\bimport\b[\s\S]*?from\s+['"][^'"]+['"]|\bexport\s+(?:type|interface|class|function|const|\{)/i, "import/export convention") })), importExportHits.length > 0 ? "HIGH" : undefined),
    makeArea(27, "In-file organization", importExportHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${importExportHits.length > 0 ? "Files typically start with imports and expose named exports, suggesting conventional in-file organization." : "No in-file organization evidence detected."}${buildRefreshNote(27, impactedAreaIds, noChange)}`, importExportHits.slice(0, 6).map((file) => ({ kind: "file" as const, path: file.path, detail: "imports/exports present" })), importExportHits.length > 0 ? "LOW" : undefined),
    makeArea(28, "File size conventions", sourceFiles.length > 0 ? "INFERRED" : "NOT_DEFINED", `${sourceFiles.length > 0 ? "Repository appears to prefer multiple smaller source files over a single monolithic entrypoint, but explicit file size limits are not enforced." : "No file size convention evidence detected."}${buildRefreshNote(28, impactedAreaIds, noChange)}`, sourceFiles.slice(0, 6).map((file) => ({ kind: "file" as const, path: file, detail: "source file sample" })), sourceFiles.length > 0 ? "LOW" : undefined),
    makeArea(29, "Function/method size conventions", functionHits.length > 0 ? "UNCERTAIN" : "NOT_DEFINED", `${functionHits.length > 0 ? "Functions are present, but deterministic function-size enforcement is not explicitly detectable from current heuristics." : "No function or method size convention evidence detected."}${buildRefreshNote(29, impactedAreaIds, noChange)}`, functionHits.slice(0, 4).map((file) => ({ kind: "file" as const, path: file.path, detail: "function sample" })), functionHits.length > 0 ? "LOW" : undefined),
    makeArea(30, "Comment/documentation conventions", commentHits.length > 0 || discovery.docsFiles.length > 0 ? "INFERRED" : "NOT_DEFINED", `${commentHits.length > 0 || discovery.docsFiles.length > 0 ? "Repository uses inline comments and/or markdown documentation files for developer guidance." : "No comment or documentation convention evidence detected."}${buildRefreshNote(30, impactedAreaIds, noChange)}`, [
      ...commentHits.slice(0, 6).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /\/\*\*|\/\/|@param|@returns/i, "comment/documentation pattern") })),
      ...discovery.docsFiles.slice(0, 3).map((file) => ({ kind: "file" as const, path: file, detail: "markdown documentation file" })),
    ], commentHits.length > 0 || discovery.docsFiles.length > 0 ? "MEDIUM" : undefined),
    makeArea(31, "TODO/FIXME/HACK conventions", todoHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${todoHits.length > 0 ? `TODO/FIXME/HACK markers are used in files such as ${todoHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No TODO/FIXME/HACK convention evidence detected."}${buildRefreshNote(31, impactedAreaIds, noChange)}`, todoHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /TODO|FIXME|HACK/i, "TODO/FIXME/HACK marker") })), todoHits.length > 0 ? "MEDIUM" : undefined),
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
