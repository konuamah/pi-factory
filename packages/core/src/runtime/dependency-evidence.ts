import fs from "node:fs/promises";
import path from "node:path";

export interface DependencyEvidence {
  rootCwd: string;
  candidateCwds: Array<{
    path: string;
    relativePath: string;
    packageManager?: string;
    scripts: string[];
    ecosystemMarkers: string[];
    dependencyMarkers: string[];
    missingDependencyMarkers: string[];
  }>;
  allowedCommands: string[];
}

const MARKERS: Record<string, string> = {
  "package.json": "node",
  "package-lock.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "pyproject.toml": "python",
  "requirements.txt": "python",
  "Cargo.toml": "rust",
  "go.mod": "go",
  "pom.xml": "java",
  "build.gradle": "java",
  "Makefile": "make",
};

export async function discoverDependencyEvidence(rootCwd: string, input: { setup?: string } = {}): Promise<DependencyEvidence> {
  const roots = [rootCwd, ...(await findRoots(rootCwd, 3))];
  const candidateCwds = [] as DependencyEvidence["candidateCwds"];
  for (const candidate of [...new Set(roots)]) {
    const entries = await fs.readdir(candidate, { withFileTypes: true }).catch(() => []);
    const names = new Set(entries.map((entry) => entry.name));
    const ecosystemMarkers = [...names].filter((name) => MARKERS[name]).map((name) => MARKERS[name]);
    const packageJson = await readJson(path.join(candidate, "package.json"));
    const scripts = packageJson?.scripts && typeof packageJson.scripts === "object" ? Object.keys(packageJson.scripts) : [];
    const packageManager = detectManager(names, input.setup);
    const dependencyMarkers = [...names].filter((name) => ["node_modules", ".venv", "target", "vendor"].includes(name));
    const missingDependencyMarkers = packageManager === "npm" && !names.has("node_modules") ? ["node_modules"] : [];
    candidateCwds.push({
      path: candidate,
      relativePath: path.relative(rootCwd, candidate).replace(/\\/g, "/") || ".",
      packageManager,
      scripts,
      ecosystemMarkers: [...new Set(ecosystemMarkers)],
      dependencyMarkers,
      missingDependencyMarkers,
    });
  }
  return { rootCwd, candidateCwds, allowedCommands: ["npm", "pnpm", "yarn", "bun", "uv", "pip", "cargo", "go", "make"] };
}

function detectManager(names: Set<string>, setup?: string): string | undefined {
  const command = setup ?? "";
  for (const manager of ["pnpm", "yarn", "bun", "npm", "uv", "pip", "cargo", "go", "make"]) if (new RegExp(`\\b${manager}\\b`).test(command)) return manager;
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("bun.lock") || names.has("bun.lockb")) return "bun";
  if (names.has("package.json") || names.has("package-lock.json")) return "npm";
  if (names.has("uv.lock")) return "uv";
  if (names.has("requirements.txt")) return "pip";
  if (names.has("Cargo.toml")) return "cargo";
  if (names.has("go.mod")) return "go";
  if (names.has("Makefile")) return "make";
  return undefined;
}

async function findRoots(root: string, depth: number): Promise<string[]> {
  if (depth <= 0) return [];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || [".git", ".factory", ".worktrees", "node_modules", "dist", "build"].includes(entry.name)) continue;
    const candidate = path.join(root, entry.name);
    const child = await fs.readdir(candidate).catch(() => []);
    if (child.some((name) => MARKERS[name])) result.push(candidate);
    result.push(...await findRoots(candidate, depth - 1));
  }
  return result;
}

async function readJson(file: string): Promise<{ scripts?: Record<string, unknown> } | undefined> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as { scripts?: Record<string, unknown> }; } catch { return undefined; }
}
