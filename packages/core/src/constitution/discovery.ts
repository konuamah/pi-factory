import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConstitutionDiscovery } from "./types.js";

const execFileAsync = promisify(execFile);

const EXCLUDED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".worktrees",
  "worktrees",
  "vendor",
  "dist",
  "build",
  "target",
  ".next",
  ".nuxt",
  "coverage",
  ".cache",
  "tmp",
  "temp",
  "__pycache__",
  ".venv",
  "venv",
  "generated",
  "out",
]);

export async function discoverConstitutionRepository(cwd: string): Promise<ConstitutionDiscovery> {
  const root = await resolveGitRoot(cwd);
  const trackedFiles = (await gitLsFiles(root)).filter((file) => !isExcluded(file));
  const instructionFiles = trackedFiles.filter((file) =>
    /(^|\/)(AGENTS\.md|CLAUDE\.md|README\.md|CONTRIBUTING\.md|DEVELOPMENT\.md|ARCHITECTURE\.md|SECURITY\.md)$/i.test(file) ||
    file.startsWith("docs/") ||
    file.startsWith(".github/"),
  );
  const manifests = trackedFiles.filter((file) => /(^|\/)(package\.json|pnpm-workspace\.yaml|turbo\.json|tsconfig\.json|pyproject\.toml|go\.mod|Cargo\.toml)$/i.test(file));
  const lockfiles = trackedFiles.filter((file) => /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|poetry\.lock|Cargo\.lock)$/i.test(file));
  const ciFiles = trackedFiles.filter((file) => file.startsWith(".github/workflows/") || file.startsWith(".gitlab-ci") || file === "azure-pipelines.yml");
  const testFiles = trackedFiles.filter((file) => /(^|\/)(test|tests|__tests__)\//i.test(file) || /\.(test|spec)\./i.test(file));
  const dockerFiles = trackedFiles.filter((file) => /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/i.test(file));
  const sourceFiles = trackedFiles.filter((file) => /(^|\/)(src|app|packages)\//.test(file));
  const docsFiles = trackedFiles.filter((file) => file.startsWith("docs/") || /(^|\/)(README|CONTRIBUTING|ARCHITECTURE|DEVELOPMENT|SECURITY)\.md$/i.test(file));
  const scriptFiles = trackedFiles.filter((file) => /(^|\/)(scripts|bin|tools)\//.test(file));
  const generatedFiles = trackedFiles.filter((file) => /(^|\/)(dist|build|coverage|generated|out)\//.test(file));
  const assetFiles = trackedFiles.filter((file) => /(^|\/)(public|static|assets)\//.test(file) || /\.(png|jpg|jpeg|gif|svg|ico|webp|css)$/.test(file));
  const envFiles = trackedFiles.filter((file) => /(^|\/)(\.env(\.[^/]+)?|env\.example|\.env\.example)$/i.test(file));
  const versionFiles = trackedFiles.filter((file) => /(^|\/)(\.nvmrc|\.node-version|package\.json|pyproject\.toml|go\.mod)$/i.test(file));
  const lintFiles = trackedFiles.filter((file) => /(^|\/)(eslint\.config\.(js|mjs|cjs)|\.eslintrc(\.(js|json|yml|yaml))?|oxlintrc\.json)$/i.test(file));
  const formatFiles = trackedFiles.filter((file) => /(^|\/)(prettier\.config\.(js|mjs|cjs)|\.prettierrc(\.(js|json|yml|yaml))?|\.editorconfig)$/i.test(file));
  const typecheckFiles = trackedFiles.filter((file) => /(^|\/)(tsconfig(\.[^/]+)?\.json|pyrightconfig\.json|mypy\.ini)$/i.test(file));
  const apiFiles = trackedFiles.filter((file) => /(^|\/)(api|routes?)\//.test(file) || /(openapi|swagger)\.(json|ya?ml)$/i.test(file));
  const dataFiles = trackedFiles.filter((file) => /(^|\/)(migrations?|prisma|db|database|sql)\//.test(file) || /\.(sql|prisma)$/.test(file));
  const languages = detectLanguages(trackedFiles);
  const packageManagers = detectPackageManagers(manifests, lockfiles);
  const commands = await readPackageCommands(root, manifests);

  return {
    root,
    trackedFiles,
    instructionFiles,
    manifests,
    lockfiles,
    ciFiles,
    testFiles,
    dockerFiles,
    sourceFiles,
    docsFiles,
    scriptFiles,
    generatedFiles,
    assetFiles,
    envFiles,
    versionFiles,
    lintFiles,
    formatFiles,
    typecheckFiles,
    apiFiles,
    dataFiles,
    languages,
    packageManagers,
    commands,
  };
}

async function resolveGitRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, windowsHide: true });
    return stdout.trim() || cwd;
  } catch {
    return cwd;
  }
}

async function gitLsFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files"], { cwd, windowsHide: true });
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return walkFiles(cwd, cwd);
  }
}

async function walkFiles(root: string, current: string): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    const relative = path.relative(root, fullPath).replace(/\\/g, "/");
    if (isExcluded(relative)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...await walkFiles(root, fullPath));
      continue;
    }
    files.push(relative);
  }
  return files;
}

function isExcluded(file: string): boolean {
  return file.split("/").some((part) => EXCLUDED_SEGMENTS.has(part));
}

function detectLanguages(files: string[]): string[] {
  const languages = new Set<string>();
  for (const file of files) {
    if (/\.(ts|tsx)$/.test(file)) languages.add("TypeScript");
    if (/\.(js|jsx|mjs|cjs)$/.test(file)) languages.add("JavaScript");
    if (/\.py$/.test(file)) languages.add("Python");
    if (/\.go$/.test(file)) languages.add("Go");
    if (/\.rs$/.test(file)) languages.add("Rust");
    if (/\.java$/.test(file)) languages.add("Java");
    if (/\.ya?ml$/.test(file)) languages.add("YAML");
  }
  return Array.from(languages).sort();
}

function detectPackageManagers(manifests: string[], lockfiles: string[]): string[] {
  const managers = new Set<string>();
  if (lockfiles.some((file) => file.endsWith("pnpm-lock.yaml")) || manifests.some((file) => file.endsWith("pnpm-workspace.yaml"))) managers.add("pnpm");
  if (lockfiles.some((file) => file.endsWith("package-lock.json"))) managers.add("npm");
  if (lockfiles.some((file) => file.endsWith("yarn.lock"))) managers.add("yarn");
  if (manifests.some((file) => file.endsWith("pyproject.toml"))) managers.add("python");
  if (manifests.some((file) => file.endsWith("go.mod"))) managers.add("go");
  return Array.from(managers).sort();
}

async function readPackageCommands(root: string, manifests: string[]): Promise<Record<string, string>> {
  const packageJsonPath = manifests.find((file) => file === "package.json");
  if (!packageJsonPath) {
    return {};
  }
  try {
    const raw = await fs.readFile(path.join(root, packageJsonPath), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = parsed.scripts ?? {};
    // Always infer install so discoveredCommands.setup sees npm/pnpm/yarn install even without explicit setup script
    const pm = detectPackageManagers([packageJsonPath], [])[0] ?? "npm";
    const install = pm === "pnpm" ? "pnpm install" : pm === "yarn" ? "yarn install" : "npm install";
    return { ...scripts, __install: install };
  } catch {
    return {};
  }
}
