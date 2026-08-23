import fs from "node:fs/promises";
import path from "node:path";
import type { FactorySetupPlan } from "./types.js";

export interface ApplySetupOptions {
  /** Root project dir (defaults to git root from the plan profile). */
  root?: string;
  /** Path to the installed factory extension entry (for .pi/extensions/factory). */
  extensionSource?: string;
  /** Skip gitignore wiring. */
  skipGitignore?: boolean;
}

export async function applyFactorySetup(plan: FactorySetupPlan, options: ApplySetupOptions = {}): Promise<string[]> {
  const written: string[] = [];
  for (const file of plan.proposed.files) {
    if (file.action === "unchanged") {
      continue;
    }
    await fs.mkdir(path.dirname(file.path), { recursive: true });
    await fs.writeFile(file.path, file.content, "utf8");
    written.push(file.path);
  }

  const root = options.root ?? plan.profile.gitRoot ?? path.dirname(process.cwd());

  if (!options.skipGitignore) {
    const gitignorePath = path.join(root, ".gitignore");
    const lines = await readLines(gitignorePath);
    const additions = [".factory/", ".worktrees/"];
    let changed = false;
    for (const line of additions) {
      if (!lines.includes(line)) {
        lines.push(line);
        changed = true;
      }
    }
    if (changed) {
      await fs.writeFile(gitignorePath, `${lines.join("\n")}${lines.length && !lines[lines.length - 1] ? "" : "\n"}`, "utf8");
      if (!written.includes(gitignorePath)) {
        written.push(gitignorePath);
      }
    }
  }

  if (options.extensionSource) {
    const extensionDir = path.join(root, ".pi", "extensions", "factory");
    const extensionPath = path.join(extensionDir, "index.ts");
    if (!(await exists(extensionPath))) {
      await fs.mkdir(extensionDir, { recursive: true });
      const content = [
        `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
        `import { registerFactoryPiExtension } from ${JSON.stringify(options.extensionSource)};`,
        `export default function factoryExtension(pi: ExtensionAPI): void {`,
        `  registerFactoryPiExtension(pi);`,
        `}`,
      ].join("\n");
      await fs.writeFile(extensionPath, content, "utf8");
      written.push(extensionPath);
    }
  }

  return written;
}

async function readLines(filePath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}