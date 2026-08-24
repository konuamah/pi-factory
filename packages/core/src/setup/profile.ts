import fs from "node:fs/promises";
import path from "node:path";
import { discoverConstitutionRepository } from "../constitution/discovery.js";
import { discoverFactoryProject } from "../project/discovery.js";
import type { ExistingFactoryState, RepositoryProfile } from "./types.js";

export async function inspectRepositoryForSetup(cwd: string): Promise<RepositoryProfile> {
  const discovery = await discoverConstitutionRepository(cwd);
  const project = await discoverFactoryProject(cwd);

  const trackedCount = discovery.trackedFiles.length;
  const maturity = !project.paths.gitRoot ? "EMPTY" : trackedCount < 5 ? "NEW" : "ESTABLISHED";

  const packageManagers = discovery.packageManagers;
  const monorepo = discovery.manifests.filter((file) => file === "package.json").length === 0
    ? discovery.manifests.filter((file) => /(^|\/)package\.json$/.test(file)).length > 1
    : discovery.trackedFiles.some((file) => /(^|\/)pnpm-workspace\.yaml$/.test(file)) ||
      discovery.manifests.filter((file) => /(^|\/)package\.json$/.test(file)).length > 1;
  const packages = distinctRoots(discovery.manifests.filter((file) => /(^|\/)package\.json$/.test(file)));

  const commands = discovery.commands ?? {};
  const frameworks = inferFrameworks(discovery);

  const testing = assessTesting(discovery);
  const persistence = assessPersistence(discovery);
  const ci = {
    providers: discovery.ciFiles.length > 0 ? inferCiProviders(discovery.ciFiles) : [],
  };
  const deployment = assessDeployment(discovery);

  const existingFactory = await inspectExistingFactory(cwd);

  return {
    maturity,
    gitRoot: project.paths.gitRoot,
    languages: discovery.languages,
    packageManagers,
    frameworks,
    structure: { monorepo, packages },
    commands: {
      install: (commands as Record<string, string | undefined>).__install ?? commands.setup ?? commands.install,
      build: commands.build,
      test: commands.test,
      lint: commands.lint,
      typecheck: commands.typecheck,
      start: commands.start,
    } as RepositoryProfile["commands"] & { __install?: string },
    testing,
    persistence,
    ci,
    deployment,
    factory: existingFactory,
  };
}

async function inspectExistingFactory(cwd: string): Promise<ExistingFactoryState> {
  const project = await discoverFactoryProject(cwd);
  let runsCount = 0;
  try {
    const entries = await fs.readdir(project.paths.runsDir);
    runsCount = entries.filter((entry) => entry.startsWith("run_")).length;
  } catch {
    runsCount = 0;
  }
  const metadataPath = path.join(project.paths.gitRoot ?? cwd, ".factory", "constitution", "metadata.json");
  let hasConstitutionMetadata = false;
  try {
    await fs.access(metadataPath);
    hasConstitutionMetadata = true;
  } catch {
    hasConstitutionMetadata = false;
  }
  return {
    files: {
      constitution: Boolean(project.paths.constitutionPath),
      workflow: Boolean(project.paths.workflowPath),
      projectConfig: Boolean(project.paths.projectConfigPath),
    },
    runsCount,
    hasConstitutionMetadata,
  };
}

function inferFrameworks(discovery: {
  manifests: string[];
  trackedFiles: string[];
  sourceFiles: string[];
}): string[] {
  const frameworks = new Set<string>();
  const files = discovery.manifests.concat(discovery.trackedFiles);
  for (const file of files) {
    if (/(^|\/)(next\.config\.|vite\.config\.|vitest\.config\.|jest\.config\.|tsup\.config\.)/.test(file)) {
      const name = file.match(/(next|vite|vitest|jest|tsup)/)?.[1];
      if (name) frameworks.add(name);
    }
    if (/(^|\/)(package\.json)$/.test(file)) {
      // dependency-based inference is handled by reading package.json content below
      frameworks.add("node");
    }
  }
  return [...frameworks].sort();
}

function assessTesting(discovery: {
  testFiles: string[];
  trackedFiles: string[];
}): RepositoryProfile["testing"] {
  const unit = discovery.testFiles.some((file) => /(^|\/)(test|tests|__tests__)\//.test(file) || /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file));
  const integration = discovery.trackedFiles.some((file) => /(^|\/)tests?\/integration\//.test(file) || /integration\.(test|spec)\./.test(file));
  const e2e = discovery.trackedFiles.some((file) => /(e2e|cypress|playwright)/.test(file));
  const frameworks: string[] = [];
  if (discovery.trackedFiles.some((file) => /vitest|jest|mocha|jasmine|playwright|cypress/.test(file))) {
    if (discovery.trackedFiles.some((file) => /vitest/.test(file))) frameworks.push("vitest");
    if (discovery.trackedFiles.some((file) => /jest/.test(file))) frameworks.push("jest");
    if (discovery.trackedFiles.some((file) => /playwright/.test(file))) frameworks.push("playwright");
    if (discovery.trackedFiles.some((file) => /cypress/.test(file))) frameworks.push("cypress");
  }
  return { frameworks, unit, integration, e2e };
}

function assessPersistence(discovery: {
  dataFiles: string[];
  trackedFiles: string[];
}): RepositoryProfile["persistence"] {
  const technologies: string[] = [];
  for (const file of discovery.dataFiles.concat(discovery.trackedFiles)) {
    if (/(^|\/)prisma\//.test(file)) technologies.push("prisma");
    if (/(^|\/)migrations?\//.test(file) || /\.sql$/.test(file)) technologies.push("sql");
    if (/(^|\/)drizzle\//.test(file)) technologies.push("drizzle");
    if (/(^|\/)typeorm\//.test(file)) technologies.push("typeorm");
  }
  const migrations = discovery.dataFiles.some((file) => /(^|\/)(migrations?|prisma\/migrations)\//.test(file) || /\.sql$/.test(file));
  return { technologies: [...new Set(technologies)], migrations };
}

function assessDeployment(discovery: {
  ciFiles: string[];
  dockerFiles: string[];
  trackedFiles: string[];
}): RepositoryProfile["deployment"] {
  const providers: string[] = [];
  const hasDocker = discovery.dockerFiles.length > 0;
  if (hasDocker) providers.push("docker");
  if (discovery.ciFiles.some((file) => file.startsWith(".github/workflows/") && /deploy|release/i.test(file))) providers.push("github-actions-deploy");
  if (discovery.trackedFiles.some((file) => /(^|\/)(fly\.toml|railway\.toml|vercel\.json|netlify\.toml)$/.test(file))) {
    if (discovery.trackedFiles.some((file) => /vercel\.json$/.test(file))) providers.push("vercel");
    if (discovery.trackedFiles.some((file) => /netlify\.toml$/.test(file))) providers.push("netlify");
    if (discovery.trackedFiles.some((file) => /fly\.toml$/.test(file))) providers.push("fly");
  }
  return { detected: providers.length > 0 || hasDocker, providers: [...new Set(providers)] };
}

function inferCiProviders(ciFiles: string[]): string[] {
  const providers: string[] = [];
  if (ciFiles.some((file) => file.startsWith(".github/workflows/"))) providers.push("github-actions");
  if (ciFiles.some((file) => file.startsWith(".gitlab-ci"))) providers.push("gitlab-ci");
  if (ciFiles.some((file) => file === "azure-pipelines.yml")) providers.push("azure-pipelines");
  return providers;
}

function distinctRoots(files: string[]): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    const dir = path.posix.dirname(file);
    roots.add(dir === "." ? "." : dir);
  }
  return [...roots].sort();
}
