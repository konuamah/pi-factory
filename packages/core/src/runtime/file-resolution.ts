import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentExecutor } from "./interfaces.js";
import { pathExists } from "./fs-utils.js";

const execFileAsync = promisify(execFile);

// ── Types ───────────────────────────────────────────────────────────────────

export interface FileReference {
  raw: string;           // "@PRODUCT_GAPS.md"
  filename: string;      // "PRODUCT_GAPS.md"
}

export interface FileResolutionEvidence {
  referencedFile: string;
  tracked: boolean;
  staged: boolean;
  untrackedExists: boolean;
  ignored: boolean;
  similarFiles: string[];
  absolutePath?: string;
  size?: number;
  lastModified?: string;
}

export interface FileResolution {
  file: string;
  action: "auto-stage" | "skip" | "block" | "use-alternative";
  alternative?: string;
  reason: string;
}

export interface FileResolutionPlan {
  resolutions: FileResolution[];
  warnings: string[];
  blockers: string[];
}

export interface FileResolutionResult {
  status: "resolved" | "blocked" | "skipped" | "no-references";
  plan?: FileResolutionPlan;
  evidence: FileResolutionEvidence[];
  appliedActions: Array<{ file: string; action: string; detail?: string }>;
  resolutionSource: "ai" | "deterministic";
  rationale?: string;
}

export class FileResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileResolutionError";
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function resolveFileReferences(input: {
  cwd: string;
  goal: string;
  executor?: AgentExecutor;
  model?: { provider?: string; model: string };
  runId?: string;
}): Promise<FileResolutionResult> {
  const refs = extractFileReferences(input.goal);
  if (refs.length === 0) {
    return {
      status: "no-references",
      evidence: [],
      appliedActions: [],
      resolutionSource: "deterministic",
    };
  }

  const evidence = await collectFileEvidence(input.cwd, refs);

  // All referenced files are tracked and exist — nothing to resolve
  if (evidence.every((e) => e.tracked)) {
    return {
      status: "resolved",
      evidence,
      appliedActions: [],
      resolutionSource: "deterministic",
      rationale: "All referenced files are already tracked.",
    };
  }

  // No executor — deterministic fallback: fail loud
  if (!input.executor) {
    const untracked = evidence.filter((e) => !e.tracked && e.untrackedExists);
    const missing = evidence.filter((e) => !e.tracked && !e.untrackedExists);
    const blockers: string[] = [];
    for (const e of untracked) {
      blockers.push(`@${e.referencedFile} is untracked. Stage it: git add ${e.referencedFile}`);
    }
    for (const e of missing) {
      blockers.push(`@${e.referencedFile} does not exist in the repository or on disk.`);
    }
    throw new FileResolutionError(
      `Cannot start run: file resolution failed.\n${blockers.join("\n")}`,
    );
  }

  // LLM resolution layer with deterministic fallback
  let plan: FileResolutionPlan;
  let resolutionSource: "ai" | "deterministic";
  try {
    plan = await planFileResolution({
      cwd: input.cwd,
      goal: input.goal,
      evidence,
      executor: input.executor,
      model: input.model,
      runId: input.runId,
    });
    resolutionSource = "ai";
  } catch {
    // LLM failed — fall back to deterministic auto-stage for safe cases
    plan = buildDeterministicFileResolutionPlan(evidence);
    resolutionSource = "deterministic";
  }

  // Sanitize and apply
  const sanitized = sanitizeResolutionPlan(plan, evidence);
  const applied = await applyResolutions(input.cwd, sanitized);

  const hasBlockers = sanitized.blockers.length > 0;
  return {
    status: hasBlockers ? "blocked" : "resolved",
    plan: sanitized,
    evidence,
    appliedActions: applied,
    resolutionSource,
    rationale: sanitized.resolutions.map((r) => `${r.file}: ${r.reason}`).join("; "),
  };
}

// ── Extraction ──────────────────────────────────────────────────────────────

export function extractFileReferences(goal: string): FileReference[] {
  const refs: FileReference[] = [];
  // Match @filename patterns: @PRODUCT_GAPS.md, @backend/src/foo.ts, etc.
  // Stop at whitespace, backtick, or end of string
  const regex = /@([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(goal)) !== null) {
    const filename = match[1]!;
    // Skip things that look like email addresses or npm scoped packages
    if (filename.includes("@") || filename.startsWith(".")) {
      continue;
    }
    refs.push({ raw: match[0], filename });
  }
  return refs;
}

// ── Evidence Collection ─────────────────────────────────────────────────────

async function collectFileEvidence(
  cwd: string,
  refs: FileReference[],
): Promise<FileResolutionEvidence[]> {
  const evidence: FileResolutionEvidence[] = [];
  for (const ref of refs) {
    evidence.push(await collectSingleFileEvidence(cwd, ref.filename));
  }
  return evidence;
}

async function collectSingleFileEvidence(
  cwd: string,
  filename: string,
): Promise<FileResolutionEvidence> {
  const absolutePath = path.resolve(cwd, filename);
  const tracked = await isTracked(cwd, filename);
  const staged = await isStaged(cwd, filename);
  const untrackedExists = await pathExists(absolutePath);
  const ignored = await isIgnored(cwd, filename);
  const similarFiles = tracked ? [] : await findSimilarFiles(cwd, filename);

  let size: number | undefined;
  let lastModified: string | undefined;
  if (untrackedExists) {
    try {
      const stat = await fs.stat(absolutePath);
      size = stat.size;
      lastModified = stat.mtime.toISOString();
    } catch {
      // best effort
    }
  }

  return {
    referencedFile: filename,
    tracked,
    staged,
    untrackedExists,
    ignored,
    similarFiles,
    absolutePath,
    size,
    lastModified,
  };
}

async function isTracked(cwd: string, filename: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", filename], {
      cwd,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function isStaged(cwd: string, filename: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--cached", "--name-only", "--", filename],
      { cwd, windowsHide: true },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}


async function isIgnored(cwd: string, filename: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["check-ignore", "-q", filename], {
      cwd,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function findSimilarFiles(cwd: string, filename: string): Promise<string[]> {
  const basename = path.basename(filename).toLowerCase();
  const similar: string[] = [];
  try {
    const { stdout } = await execFileAsync("git", ["ls-files"], {
      cwd,
      windowsHide: true,
    });
    const tracked = stdout.split(/\r?\n/).filter(Boolean);
    for (const file of tracked) {
      const fileBasename = path.basename(file).toLowerCase();
      if (fileBasename === basename) {
        similar.push(file);
      } else if (
        levenshtein(fileBasename, basename) <= 2 ||
        fileBasename.includes(basename) ||
        basename.includes(fileBasename)
      ) {
        similar.push(file);
      }
    }
  } catch {
    // best effort
  }
  return similar.slice(0, 5);
}

// ── LLM Planning ────────────────────────────────────────────────────────────

async function planFileResolution(input: {
  cwd: string;
  goal: string;
  evidence: FileResolutionEvidence[];
  executor: AgentExecutor;
  model?: { provider?: string; model: string };
  runId?: string;
}): Promise<FileResolutionPlan> {
  const result = await input.executor.execute({
    executionId: `${input.runId ?? "file-resolution"}-file-resolve`,
    cwd: input.cwd,
    prompt: buildFileResolutionPrompt(input.goal, input.evidence),
    model: input.model,
    tools: ["read", "ls"],
    metadata: {
      role: "file-resolution",
      stage: "pre-worktree",
      runId: input.runId,
    },
  });

  const parsed = parseFileResolutionPlan(result.outputText);
  if (!parsed) {
    throw new Error("File resolution planner returned invalid structured JSON.");
  }
  return parsed;
}

function buildDeterministicFileResolutionPlan(
  evidence: FileResolutionEvidence[],
): FileResolutionPlan {
  const resolutions: FileResolution[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];

  for (const ev of evidence) {
    if (ev.tracked) {
      continue; // already tracked, nothing to do
    }
    if (ev.ignored) {
      blockers.push(`@${ev.referencedFile} is in .gitignore and cannot be staged.`);
      continue;
    }
    if (ev.untrackedExists) {
      resolutions.push({
        file: ev.referencedFile,
        action: "auto-stage",
        reason: "File exists on disk, untracked. Auto-staging for worktree.",
      });
      continue;
    }
    if (ev.similarFiles.length > 0) {
      resolutions.push({
        file: ev.referencedFile,
        action: "use-alternative",
        alternative: ev.similarFiles[0],
        reason: `File not found. Using similar tracked file: ${ev.similarFiles[0]}`,
      });
      continue;
    }
    blockers.push(`@${ev.referencedFile} does not exist and no alternative was found.`);
  }

  return { resolutions, warnings, blockers };
}

function buildFileResolutionPrompt(
  goal: string,
  evidence: FileResolutionEvidence[],
): string {
  const lines = [
    `Goal: ${goal}`,
    "",
    "The goal references files with @ syntax. Some files may be untracked or missing.",
    "Decide what to do for each referenced file before the run's worktree is created.",
    "",
    "Actions available:",
    '  "auto-stage" — git add the file so the worktree includes it',
    "  \"skip\" — file is optional, proceed without it",
    '  "block" — file is required and cannot be resolved; abort the run',
    '  "use-alternative" — use a different file that already exists',
    "",
    "Rules:",
    "- Never auto-stage files in .gitignore",
    "- Never auto-stage files that don't exist on disk",
    "- If a file is already tracked, no action needed (omit from resolutions)",
    "- If similar tracked files exist, suggest them as alternatives",
    "- Block only when the file is critical to the goal and no workaround exists",
    "",
    "Evidence:",
    JSON.stringify(evidence, null, 2),
    "",
    "Return JSON only with this shape:",
    "{",
    '  "resolutions": [',
    "    {",
    '      "file": "PRODUCT_GAPS.md",',
    '      "action": "auto-stage",',
    '      "reason": "File exists on disk, untracked, directly referenced by goal."',
    "    }",
    "  ],",
    '  "warnings": ["optional warning messages"],',
    '  "blockers": ["reasons the run cannot proceed"]',
    "}",
  ];
  return lines.join("\n");
}

function parseFileResolutionPlan(outputText: string): FileResolutionPlan | undefined {
  if (!outputText || !outputText.trim()) {
    return undefined;
  }
  const fenced = outputText.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = (fenced ?? outputText).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      resolutions?: unknown;
      warnings?: unknown;
      blockers?: unknown;
    };
    // Handle single object instead of array
    let resolutions: unknown = parsed.resolutions;
    if (resolutions && typeof resolutions === "object" && !Array.isArray(resolutions)) {
      resolutions = [resolutions];
    }
    if (!Array.isArray(resolutions)) {
      return undefined;
    }
    // Validate each resolution has required fields
    const validResolutions = (resolutions as unknown[]).filter(
      (r): r is FileResolution =>
        Boolean(r) &&
        typeof r === "object" &&
        typeof (r as FileResolution).file === "string" &&
        typeof (r as FileResolution).action === "string",
    );
    if (validResolutions.length === 0 && resolutions.length > 0) {
      return undefined;
    }
    return {
      resolutions: validResolutions,
      warnings: Array.isArray(parsed.warnings) ? (parsed.warnings as string[]) : [],
      blockers: Array.isArray(parsed.blockers) ? (parsed.blockers as string[]) : [],
    };
  } catch {
    return undefined;
  }
}

// ── Sanitization ────────────────────────────────────────────────────────────

function sanitizeResolutionPlan(
  plan: FileResolutionPlan,
  evidence: FileResolutionEvidence[],
): FileResolutionPlan {
  const evidenceByFile = new Map(evidence.map((e) => [e.referencedFile, e]));
  const sanitized: FileResolutionPlan = {
    resolutions: [],
    warnings: [...plan.warnings],
    blockers: [],
  };

  for (const resolution of plan.resolutions) {
    const ev = evidenceByFile.get(resolution.file);
    if (!ev) {
      sanitized.warnings.push(
        `Resolution for unknown file ${resolution.file} ignored.`,
      );
      continue;
    }

    switch (resolution.action) {
      case "auto-stage": {
        if (ev.ignored) {
          sanitized.blockers.push(
            `Cannot auto-stage ${resolution.file}: file is in .gitignore.`,
          );
          break;
        }
        if (!ev.untrackedExists) {
          sanitized.blockers.push(
            `Cannot auto-stage ${resolution.file}: file does not exist on disk.`,
          );
          break;
        }
        if (ev.tracked) {
          // Already tracked, no action needed
          break;
        }
        sanitized.resolutions.push(resolution);
        break;
      }
      case "use-alternative": {
        if (!resolution.alternative) {
          sanitized.warnings.push(
            `use-alternative for ${resolution.file} has no alternative specified; skipping.`,
          );
          break;
        }
        if (!ev.similarFiles.includes(resolution.alternative)) {
          sanitized.warnings.push(
            `Alternative ${resolution.alternative} not in similar files for ${resolution.file}; skipping.`,
          );
          break;
        }
        sanitized.resolutions.push(resolution);
        break;
      }
      case "skip": {
        sanitized.resolutions.push(resolution);
        break;
      }
      case "block": {
        sanitized.blockers.push(
          resolution.reason || `Blocked: ${resolution.file}`,
        );
        break;
      }
      default: {
        sanitized.warnings.push(
          `Unknown action "${resolution.action}" for ${resolution.file}; skipping.`,
        );
      }
    }
  }

  // Catch files the LLM didn't address
  for (const ev of evidence) {
    if (ev.tracked) continue;
    const addressed = plan.resolutions.some((r) => r.file === ev.referencedFile);
    if (!addressed) {
      if (ev.untrackedExists && !ev.ignored) {
        sanitized.resolutions.push({
          file: ev.referencedFile,
          action: "auto-stage",
          reason: "Unreferenced by planner but exists untracked; auto-staging.",
        });
      } else if (!ev.untrackedExists && ev.similarFiles.length === 0) {
        sanitized.blockers.push(
          `@${ev.referencedFile} does not exist and no alternative was found.`,
        );
      }
    }
  }

  return sanitized;
}

// ── Apply ───────────────────────────────────────────────────────────────────

async function applyResolutions(
  cwd: string,
  plan: FileResolutionPlan,
): Promise<Array<{ file: string; action: string; detail?: string }>> {
  const applied: Array<{ file: string; action: string; detail?: string }> = [];

  for (const resolution of plan.resolutions) {
    switch (resolution.action) {
      case "auto-stage": {
        try {
          await execFileAsync("git", ["add", resolution.file], {
            cwd,
            windowsHide: true,
          });
          applied.push({
            file: resolution.file,
            action: "auto-staged",
          });
        } catch (error) {
          applied.push({
            file: resolution.file,
            action: "auto-stage-failed",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }
      case "use-alternative": {
        applied.push({
          file: resolution.file,
          action: "using-alternative",
          detail: resolution.alternative,
        });
        break;
      }
      case "skip": {
        applied.push({
          file: resolution.file,
          action: "skipped",
          detail: resolution.reason,
        });
        break;
      }
    }
  }

  return applied;
}

// ── Utils ───────────────────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}
