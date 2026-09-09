import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentExecutor, AgentExecutionInput } from "./interfaces.js";
import { pathExists } from "./fs-utils.js";
import { collectFileEvidence } from "./file-evidence.js";
import { planFileResolution, buildDeterministicFileResolutionPlan } from "./file-planning.js";
import { sanitizeResolutionPlan, applyResolutions } from "./file-apply.js";

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
  limits?: AgentExecutionInput["limits"];
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
      limits: input.limits,
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
