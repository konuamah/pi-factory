// Discovery output validation + evidence building — extracted from controller.ts
// so the runtime controller focuses on orchestration. Pure-ish: reads the
// filesystem and the discovery executor's output, returns validated contracts.

import fs from "node:fs/promises";
import path from "node:path";

export interface DiscoveryContract {
  status: "complete" | "failed";
  implementationSurface?: "identified" | "missing" | "ambiguous";
  files?: string[];
  /**
   * Files the goal requires the Builder to CREATE (they do not exist yet).
   * Kept separate from files[] (which must be observed existing files) so a
   * mixed edit+create task can be represented without failing validation.
   */
  newFiles?: string[];
  evidence?: Array<{ status: "confirmed" | "inferred" | "unknown"; file?: string; finding: string }>;
  unknowns?: string[];
  reason?: string;
}

export interface DiscoveryEvidencePacket {
  root: string;
  observedFiles: string[];
  candidateFiles: string[];
  snippets: Array<{
    file: string;
    line: number;
    text: string;
    matched: string;
  }>;
  terms: string[];
  truncated: boolean;
}

export async function validateDiscoveryOutput(value: string | undefined, cwd: string, evidencePacket: DiscoveryEvidencePacket): Promise<{ ok: true; discovery: DiscoveryContract } | { ok: false; reason: string }> {
  const text = value?.trim() ?? "";
  if (!text) {
    return { ok: false, reason: "Discovery returned no output" };
  }

  const parsed = parseDiscoveryJson(text);
  if (!parsed) {
    return { ok: false, reason: "Discovery returned invalid structured JSON" };
  }
  if (parsed.status === "failed") {
    return { ok: false, reason: parsed.reason?.trim() || "Discovery failed" };
  }
  if (parsed.status !== "complete") {
    return { ok: false, reason: "Discovery status must be complete or failed" };
  }

  const files = Array.isArray(parsed.files) ? parsed.files : [];
  const concreteFiles = files.map(normalizeDiscoveryFilePath).filter((file): file is string => Boolean(file));
  if (files.length > 0 && concreteFiles.length === 0) {
    return { ok: false, reason: "Discovery listed files, but none were concrete implementation files" };
  }
  if (concreteFiles.length > 0) {
    const missingFiles = await findMissingDiscoveryFiles(cwd, concreteFiles);
    if (missingFiles.length > 0) {
      return { ok: false, reason: `Discovery identified files that do not exist: ${missingFiles.join(", ")}` };
    }
    const unobservedFiles = findUnobservedDiscoveryFiles(concreteFiles, evidencePacket);
    if (unobservedFiles.length > 0) {
      return { ok: false, reason: `Discovery referenced files not observed by Factory evidence: ${unobservedFiles.join(", ")}` };
    }
  }

  // Files the goal requires creating. They must be concrete paths but are NOT
  // required to exist yet and are NOT in the observed evidence — the Builder
  // creates them. Normalize them so the planner/build tasks receive clean paths.
  const newFileRaw = Array.isArray(parsed.newFiles) ? parsed.newFiles : [];
  const newFiles = newFileRaw.map(normalizeDiscoveryFilePath).filter((file): file is string => Boolean(file));
  if (newFileRaw.length > 0 && newFiles.length === 0) {
    return { ok: false, reason: "Discovery listed newFiles, but none were concrete file paths" };
  }
  // A new file must not also be listed as an existing file (contradiction).
  const newFileSet = new Set(newFiles);
  const overlap = concreteFiles.filter((file) => newFileSet.has(file));
  if (overlap.length > 0) {
    return { ok: false, reason: `Discovery listed the same file in both files[] and newFiles[]: ${overlap.join(", ")}` };
  }

  const evidence = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  if (!evidence.some((item) => item?.finding?.trim()) && !parsed.unknowns?.some((item) => item.trim())) {
    return { ok: false, reason: "Discovery did not provide evidence or unknowns" };
  }
  if (concreteFiles.length > 0 && !evidence.some((item) => item?.status === "confirmed" && isConcreteFile(item.file) && item.finding?.trim())) {
    return { ok: false, reason: "Discovery did not provide confirmed evidence tied to a concrete file" };
  }
  const evidenceFiles = evidence
    .filter((item) => item?.status === "confirmed" && item.finding?.trim())
    .map((item) => item.file)
    .filter((file): file is string => isConcreteFile(file));
  // Evidence may legitimately reference a to-be-created file in its finding
  // context (e.g. "script.js must include data/schedule.js"), so exclude
  // newFiles from the must-exist evidence check.
  const evidenceFilesToCheck = evidenceFiles.filter((file) => !newFileSet.has(file));
  const missingEvidenceFiles = await findMissingDiscoveryFiles(cwd, evidenceFilesToCheck);
  if (missingEvidenceFiles.length > 0) {
    return { ok: false, reason: `Discovery evidence references files that do not exist: ${missingEvidenceFiles.join(", ")}` };
  }
  const unobservedEvidenceFiles = findUnobservedDiscoveryFiles(evidenceFilesToCheck, evidencePacket);
  if (unobservedEvidenceFiles.length > 0) {
    return { ok: false, reason: `Discovery evidence references files not observed by Factory evidence: ${unobservedEvidenceFiles.join(", ")}` };
  }

  return {
    ok: true,
    discovery: {
      ...parsed,
      implementationSurface: parsed.implementationSurface ?? (concreteFiles.length > 0 || newFiles.length > 0 ? "identified" : "missing"),
      files: concreteFiles,
      newFiles,
    },
  };
}

export function findUnobservedDiscoveryFiles(files: string[], evidencePacket: DiscoveryEvidencePacket): string[] {
  const observed = new Set(evidencePacket.observedFiles);
  return [...new Set(files
    .map(normalizeDiscoveryFilePath)
    .filter((file): file is string => Boolean(file))
    .filter((file) => !observed.has(file)))];
}

export async function buildDiscoveryEvidencePacket(cwd: string, goal: string): Promise<DiscoveryEvidencePacket> {
  const terms = extractDiscoveryTerms(goal);
  const observedFiles = await collectDiscoveryFiles(cwd);
  const scored = new Map<string, { score: number; snippets: DiscoveryEvidencePacket["snippets"] }>();

  for (const file of observedFiles) {
    const pathScore = scoreDiscoveryPath(file, terms);
    if (pathScore > 0) {
      scored.set(file, { score: pathScore, snippets: [] });
    }
  }

  for (const file of observedFiles) {
    if (!shouldInspectDiscoveryFile(file)) {
      continue;
    }
    const snippets = await collectDiscoverySnippets(path.join(cwd, file), file, terms);
    if (snippets.length === 0) {
      continue;
    }
    const existing = scored.get(file) ?? { score: 0, snippets: [] };
    existing.score += 10 + snippets.length;
    existing.snippets.push(...snippets);
    scored.set(file, existing);
  }

  const candidateFiles = [...scored.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .slice(0, 60)
    .map(([file]) => file);
  const candidateSet = new Set(candidateFiles);
  const snippets = [...scored.entries()]
    .filter(([file]) => candidateSet.has(file))
    .flatMap(([, value]) => value.snippets)
    .slice(0, 120);

  return {
    root: cwd,
    observedFiles,
    candidateFiles,
    snippets,
    terms,
    truncated: observedFiles.length >= DISCOVERY_MAX_FILES,
  };
}

const DISCOVERY_MAX_FILES = 5000;
const DISCOVERY_MAX_FILE_BYTES = 240_000;

export async function collectDiscoveryFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];
  await walk(cwd, "");
  return files.sort();

  async function walk(current: string, relativeDir: string): Promise<void> {
    if (files.length >= DISCOVERY_MAX_FILES) {
      return;
    }

    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!shouldSkipDiscoveryDirectory(entry.name, relativePath)) {
          await walk(path.join(current, entry.name), relativePath);
        }
        continue;
      }
      if (!entry.isFile() || !isConcreteFile(relativePath)) {
        continue;
      }
      files.push(relativePath);
      if (files.length >= DISCOVERY_MAX_FILES) {
        return;
      }
    }
  }
}

// Factory's run state is transient, but .factory/config.yaml is tracked project
// config that Discovery is allowed to cite, so skip the transient subpaths only.
const DISCOVERY_TRANSIENT_PATHS = new Set([
  ".factory/runs",
  ".factory/dependencies",
  ".factory/cache",
  ".factory/logs",
]);

export function shouldSkipDiscoveryDirectory(name: string, relativePath: string): boolean {
  return name === ".git"
    || name === ".worktrees"
    || name === "node_modules"
    || name === ".next"
    || name === "dist"
    || name === "build"
    || name === "coverage"
    || DISCOVERY_TRANSIENT_PATHS.has(relativePath)
    || relativePath === "vendor/pi-factory";
}

export function extractDiscoveryTerms(goal: string): string[] {
  const stopwords = new Set([
    "the", "and", "for", "with", "from", "into", "that", "this", "those", "these", "make", "add", "run", "use",
    "using", "update", "remove", "delete", "change", "fix", "create", "show", "hide", "page", "site", "app",
  ]);
  const terms = new Set<string>();
  for (const raw of goal.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < 3 || stopwords.has(raw)) {
      continue;
    }
    terms.add(raw);
    if (raw.endsWith("ies") && raw.length > 4) {
      terms.add(`${raw.slice(0, -3)}y`);
    } else if (raw.endsWith("s") && raw.length > 3) {
      terms.add(raw.slice(0, -1));
    }
  }
  return [...terms];
}

export function scoreDiscoveryPath(file: string, terms: string[]): number {
  const lower = file.toLowerCase();
  let score = /(^|\/)(package\.json|factory\.yaml|\.factory\/config\.yaml)$/.test(lower) ? 1 : 0;
  for (const term of terms) {
    if (lower.includes(term)) {
      score += lower.split("/").at(-1)?.includes(term) ? 8 : 4;
    }
  }
  return score;
}

export function shouldInspectDiscoveryFile(file: string): boolean {
  return /\.(ts|tsx|js|jsx|json|md|mdx|yaml|yml|css|scss|html)$/i.test(file);
}

export async function collectDiscoverySnippets(
  absolutePath: string,
  relativePath: string,
  terms: string[],
): Promise<DiscoveryEvidencePacket["snippets"]> {
  if (terms.length === 0) {
    return [];
  }
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile() || stat.size > DISCOVERY_MAX_FILE_BYTES) {
      return [];
    }
    const raw = await fs.readFile(absolutePath, "utf8");
    if (raw.includes("\u0000")) {
      return [];
    }
    const snippets: DiscoveryEvidencePacket["snippets"] = [];
    const lines = raw.split(/\r?\n/);
    for (let index = 0; index < lines.length && snippets.length < 4; index += 1) {
      const line = lines[index] ?? "";
      const matched = terms.find((term) => line.toLowerCase().includes(term));
      if (!matched) {
        continue;
      }
      snippets.push({
        file: relativePath,
        line: index + 1,
        text: line.trim().slice(0, 220),
        matched,
      });
    }
    return snippets;
  } catch {
    return [];
  }
}

export async function findMissingDiscoveryFiles(cwd: string, files: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const file of files) {
    const normalized = normalizeDiscoveryFilePath(file);
    if (!normalized) {
      continue;
    }
    if (!await fileExists(path.join(cwd, normalized))) {
      missing.push(normalized);
    }
  }
  return [...new Set(missing)];
}

export function normalizeDiscoveryFilePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const filePath = value.trim().replace(/`/g, "");
  if (!isConcreteFile(filePath)) {
    return undefined;
  }
  return filePath;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export function parseDiscoveryJson(text: string): DiscoveryContract | undefined {
  for (const candidate of discoveryJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as DiscoveryContract;
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {}
  }
  return undefined;
}

export function discoveryJsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim(),
  ];

  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1].trim());
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1).trim());
  }

  return [...new Set(candidates.filter(Boolean))];
}

export function shouldRetryDiscoveryJsonRepair(reason: string, outputText: string | undefined): boolean {
  const text = outputText?.trim() ?? "";
  return reason === "Discovery returned invalid structured JSON"
    && (/\{[\s\S]*\}/.test(text) || /```(?:json)?[\s\S]*?```/i.test(text));
}

export function buildDiscoveryJsonRepairPrompt(outputText: string): string {
  return [
    "Factory could not parse your previous Discovery response as strict JSON.",
    "",
    "Return only one valid JSON object that follows this exact shape:",
    "{",
    "  \"status\": \"complete\" | \"failed\",",
    "  \"implementationSurface\": \"identified\" | \"missing\" | \"ambiguous\",",
    "  \"files\": [\"relative/path.ext\"],",
    "  \"evidence\": [{ \"status\": \"confirmed\" | \"inferred\" | \"unknown\", \"file\": \"relative/path.ext\", \"finding\": \"short finding\" }],",
    "  \"unknowns\": [\"short unknown\"],",
    "  \"reason\": \"only when status is failed\"",
    "}",
    "",
    "Rules:",
    "- Do not include markdown fences or prose.",
    "- Escape every quote inside string values.",
    "- Preserve the same facts and file paths from the previous response.",
    "- Do not add new files or claims.",
    "",
    "Previous response:",
    outputText.slice(0, 20_000),
  ].join("\n");
}

export function isConcreteFile(value: string | undefined): boolean {
  if (!value) return false;
  const filePath = value.trim().replace(/`/g, "");
  if (!filePath || filePath.endsWith("/")) return false;
  if (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes("..")) return false;
  if (/^(src|components|frontend|backend|course files)$/i.test(filePath)) return false;
  if (/^(AGENTS|README|CONSTITUTION)\.md$/i.test(filePath)) return false;
  if (filePath.includes("node_modules/")) return false;
  if (filePath.includes("/AGENTS.md") || filePath.includes("/README.md") || filePath.includes("/CONSTITUTION.md")) return false;
  return /(^|\/)(package\.json|factory\.yaml|\.factory\/config\.yaml)$/.test(filePath)
    || /\.[A-Za-z0-9]+$/.test(filePath);
}

