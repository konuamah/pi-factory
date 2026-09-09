import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ConstitutionRefreshState {
  previousScanSha?: string;
  currentScanSha?: string;
  changedFiles: string[];
  impactedAreaIds: number[];
  mode: "FAST" | "FULL";
  noChange: boolean;
}

export function hasStructuralConstitutionChanges(files: string[]): boolean {
  return files.some((file) =>
    /(^|\/)(package\.json|pnpm-workspace\.yaml|turbo\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|tsconfig(\.[^/]+)?\.json|factory\.ya?ml|config\.ya?ml|SKILL\.md|AGENTS\.md|CLAUDE\.md)$/i.test(file),
  );
}

export async function detectConstitutionRefreshState(root: string): Promise<ConstitutionRefreshState> {
  const metadataPath = path.join(root, ".factory", "constitution", "metadata.json");
  const previous = await readJson<Record<string, unknown>>(metadataPath);
  const previousScanSha = typeof previous?.scanSha === "string" ? previous.scanSha : undefined;
  const currentScanSha = await readHeadSha(root);
  const changedFiles = await detectChangedFiles(root, previousScanSha);
  const impactedAreaIds = routeImpactedAreas(changedFiles);
  const noChange = changedFiles.length === 0;

  return {
    previousScanSha,
    currentScanSha,
    changedFiles,
    impactedAreaIds,
    mode: noChange ? "FAST" : previousScanSha ? "FAST" : "FULL",
    noChange,
  };
}

async function detectChangedFiles(root: string, previousScanSha?: string): Promise<string[]> {
  const dirtyFiles = await gitStatusLines(root);
  const dirty = dirtyFiles
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  if (!previousScanSha) {
    return Array.from(new Set(dirty)).sort();
  }

  const diff = await gitLines(root, ["diff", "--name-only", `${previousScanSha}..HEAD`]);
  return Array.from(new Set([...diff, ...dirty])).sort();
}

interface ImpactRule {
  pattern: RegExp;
  areas: number[];
  /** Test against path.basename instead of the full path. */
  basename?: boolean;
}

const IMPACT_RULES: ImpactRule[] = [
  { pattern: /^(README|AGENTS|CLAUDE|CONTRIBUTING|DEVELOPMENT|ARCHITECTURE|SECURITY)\.md/i, areas: [1, 5], basename: true },
  { pattern: /^docs\//, areas: [1, 5] },
  { pattern: /^\.github\//, areas: [5, 87] },
  { pattern: /(^|\/)(\.gitlab-ci|azure-pipelines\.yml)$/i, areas: [5, 87] },
  { pattern: /(^|\/)(package\.json|pnpm-workspace\.yaml|turbo\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/i, areas: [2, 9, 10, 11, 20, 81, 83, 85] },
  { pattern: /(^|\/)(tsconfig(\.[^/]+)?\.json|pyrightconfig\.json|mypy\.ini)$/i, areas: [2, 10, 19, 85] },
  { pattern: /(^|\/)(test|tests|__tests__)\//i, areas: [4, 73] },
  { pattern: /\.(test|spec)\./i, areas: [4, 73] },
  { pattern: /^scripts\//, areas: [6, 20] },
  { pattern: /(^|\/)(bin|tools)\//, areas: [6, 20] },
  { pattern: /^src\//, areas: [1, 2, 3] },
  { pattern: /^app\//, areas: [1, 2, 3] },
  { pattern: /^packages\//, areas: [1, 2, 3] },
  { pattern: /^public\//, areas: [8] },
  { pattern: /^static\//, areas: [8] },
  { pattern: /^assets\//, areas: [8] },
  { pattern: /\.(png|jpg|jpeg|gif|svg|ico|webp|css)$/i, areas: [8] },
  { pattern: /^Dockerfile$/i, areas: [21] },
  { pattern: /^docker-compose\.ya?ml$/i, areas: [21] },
  { pattern: /(^|\/)(\.env(\.[^/]+)?|env\.example|\.env\.example)$/i, areas: [15, 16] },
  { pattern: /(^|\/)(eslint\.config\.(js|mjs|cjs)|\.eslintrc(\.(js|json|yml|yaml))?)$/i, areas: [83] },
  { pattern: /(^|\/)(prettier\.config\.(js|mjs|cjs)|\.prettierrc(\.(js|json|yml|yaml))?|\.editorconfig)$/i, areas: [84] },
  { pattern: /(^|\/)(api|routes?)\//, areas: [40, 41] },
  { pattern: /(openapi|swagger)\.(json|ya?ml)$/i, areas: [40, 41] },
  { pattern: /(^|\/)(migrations?|prisma|schema|schemas|db|database|sql)\//, areas: [48, 50, 51] },
  { pattern: /\.(sql|prisma)$/i, areas: [48, 50, 51] },
];

export function routeImpactedAreas(files: string[]): number[] {
  const impacted = new Set<number>();
  for (const file of files) {
    for (const rule of IMPACT_RULES) {
      const target = rule.basename ? path.basename(file) : file;
      if (rule.pattern.test(target)) {
        for (const id of rule.areas) impacted.add(id);
      }
    }
  }
  return Array.from(impacted).sort((a, b) => a - b);
}

async function readHeadSha(root: string): Promise<string | undefined> {
  const lines = await gitLines(root, ["rev-parse", "HEAD"]);
  return lines[0];
}

async function gitLines(root: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, windowsHide: true });
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function gitStatusLines(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd: root, windowsHide: true });
    return stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
