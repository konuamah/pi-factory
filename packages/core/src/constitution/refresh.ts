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

function routeImpactedAreas(files: string[]): number[] {
  const impacted = new Set<number>();
  for (const file of files) {
    if (/^(README|AGENTS|CLAUDE|CONTRIBUTING|DEVELOPMENT|ARCHITECTURE|SECURITY)\.md/i.test(path.basename(file)) || file.startsWith("docs/")) {
      [1, 5].forEach((id) => impacted.add(id));
    }
    if (file.startsWith(".github/") || /(^|\/)(\.gitlab-ci|azure-pipelines\.yml)$/i.test(file)) {
      [5, 87].forEach((id) => impacted.add(id));
    }
    if (/(^|\/)(package\.json|pnpm-workspace\.yaml|turbo\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/i.test(file)) {
      [2, 9, 10, 11, 20, 81, 83, 85].forEach((id) => impacted.add(id));
    }
    if (/(^|\/)(tsconfig(\.[^/]+)?\.json|pyrightconfig\.json|mypy\.ini)$/i.test(file)) {
      [2, 10, 19, 85].forEach((id) => impacted.add(id));
    }
    if (/(^|\/)(test|tests|__tests__)\//i.test(file) || /\.(test|spec)\./i.test(file)) {
      [4, 73].forEach((id) => impacted.add(id));
    }
    if (/^scripts\//.test(file) || /(^|\/)(bin|tools)\//.test(file)) {
      [6, 20].forEach((id) => impacted.add(id));
    }
    if (/^src\//.test(file) || /^app\//.test(file) || /^packages\//.test(file)) {
      [1, 2, 3].forEach((id) => impacted.add(id));
    }
    if (/^public\//.test(file) || /^static\//.test(file) || /^assets\//.test(file) || /\.(png|jpg|jpeg|gif|svg|ico|webp|css)$/.test(file)) {
      impacted.add(8);
    }
    if (/^Dockerfile$/i.test(file) || /^docker-compose\.ya?ml$/i.test(file)) {
      impacted.add(21);
    }
    if (/(^|\/)(\.env(\.[^/]+)?|env\.example|\.env\.example)$/i.test(file)) {
      [15, 16].forEach((id) => impacted.add(id));
    }
    if (/(^|\/)(eslint\.config\.(js|mjs|cjs)|\.eslintrc(\.(js|json|yml|yaml))?)$/i.test(file)) {
      impacted.add(83);
    }
    if (/(^|\/)(prettier\.config\.(js|mjs|cjs)|\.prettierrc(\.(js|json|yml|yaml))?|\.editorconfig)$/i.test(file)) {
      impacted.add(84);
    }
    if (/(^|\/)(api|routes?)\//.test(file) || /(openapi|swagger)\.(json|ya?ml)$/i.test(file)) {
      impacted.add(40);
      impacted.add(41);
    }
    if (/(^|\/)(migrations?|prisma|schema|schemas|db|database|sql)\//.test(file) || /\.(sql|prisma)$/.test(file)) {
      [48, 50, 51].forEach((id) => impacted.add(id));
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
