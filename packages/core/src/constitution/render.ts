import type { ConstitutionArea, ConstitutionDiscovery } from "./types.js";

export function renderConstitutionMarkdown(input: {
  discovery: ConstitutionDiscovery;
  areas: ConstitutionArea[];
  summary: string[];
  aiOutputText?: string;
}): string {
  return [
    "# Codebase Constitution",
    "",
    "## Agent Operating Summary",
    ...input.summary.map((line) => `- ${line}`),
    ...(input.aiOutputText ? ["", "### AI Reasoner Notes", input.aiOutputText.trim()] : []),
    "",
    "## Project Snapshot",
    `- Root: ${input.discovery.root}`,
    `- Languages: ${input.discovery.languages.join(", ") || "none detected"}`,
    `- Package managers: ${input.discovery.packageManagers.join(", ") || "none detected"}`,
    `- Tracked files: ${input.discovery.trackedFiles.length}`,
    `- Test files: ${input.discovery.testFiles.length}`,
    `- CI files: ${input.discovery.ciFiles.length}`,
    `- Docs files: ${input.discovery.docsFiles.length}`,
    `- Script/tool files: ${input.discovery.scriptFiles.length}`,
    `- API files: ${input.discovery.apiFiles.length}`,
    `- Data files: ${input.discovery.dataFiles.length}`,
    "",
    "## Status Legend",
    "- DEFINED",
    "- INFERRED",
    "- NOT_DEFINED",
    "- NOT_APPLICABLE",
    "- UNCERTAIN",
    "",
    "# Full Repository Constitution",
    "",
    ...input.areas.flatMap((area) => [
      `## ${area.id}. ${area.title}`,
      `- Status: ${area.status}${area.confidence ? ` (${area.confidence})` : ""}`,
      `- Finding: ${area.finding}`,
      ...(area.driftWarnings?.map((warning) => `- Drift warning: ${warning}`) ?? []),
      ...area.evidence.map((evidence) => `- Evidence: ${evidence.path ? `${evidence.path} — ` : ""}${evidence.detail}`),
      "",
    ]),
  ].join("\n");
}
