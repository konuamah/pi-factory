// File resolution planning + prompt/parse — extracted from file-resolution.ts.
import type { FileResolutionPlan, FileResolutionEvidence, FileResolution } from "./file-resolution.js";
import type { AgentExecutor } from "./interfaces.js";
export async function planFileResolution(input: {
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

export function buildDeterministicFileResolutionPlan(
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

export function buildFileResolutionPrompt(
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

export function parseFileResolutionPlan(outputText: string): FileResolutionPlan | undefined {
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

