import fs from "node:fs/promises";
import path from "node:path";

export async function selectConstitutionContext(input: {
  cwd: string;
  role: "planner" | "builder" | "reviewer" | "repair";
  goal: string;
}): Promise<string | undefined> {
  const constitutionPath = path.join(input.cwd, "CONSTITUTION.md");
  const text = await readIfExists(constitutionPath);
  if (!text) {
    return undefined;
  }

  const summary = extractSection(text, "## Agent Operating Summary", "## Interpretation");
  const projectSnapshot = extractSection(text, "## Project Snapshot", "## Status Legend");
  const fullBody = extractSection(text, "# Observable Facts");

  const relevant = [
    findArea(fullBody, /Repository layout/i),
    findArea(fullBody, /Monorepo \/ single-project model/i),
    findArea(fullBody, /Package management/i),
    findArea(fullBody, /Testing approach/i),
    findArea(fullBody, /CI\/CD/i),
    findArea(fullBody, /Commands/i),
  ].filter(Boolean);

  const roleHint = buildRoleHint(input.role, input.goal);
  const compact = [
    roleHint,
    summary ? `Agent Operating Summary:\n${truncate(summary, 1200)}` : undefined,
    input.role === "planner" ? (projectSnapshot ? `Project Snapshot:\n${truncate(projectSnapshot, 600)}` : undefined) : undefined,
    relevant.length > 0 ? `Relevant Constitution Areas:\n${truncate(relevant.join("\n\n"), 1800)}` : undefined,
  ].filter(Boolean);

  return compact.length > 0 ? compact.join("\n\n") : undefined;
}

function buildRoleHint(role: "planner" | "builder" | "reviewer" | "repair", goal: string): string {
  switch (role) {
    case "planner":
      return `Use the repository constitution to plan work for: ${goal}`;
    case "builder":
      return `Use the repository constitution while implementing: ${goal}`;
    case "reviewer":
      return `Use the repository constitution while reviewing work for: ${goal}`;
    case "repair":
      return `Use the repository constitution while repairing verification failures for: ${goal}`;
  }
}

function extractSection(text: string, startHeading: string, endHeading?: string): string | undefined {
  const start = text.indexOf(startHeading);
  if (start < 0) {
    return undefined;
  }
  const from = start + startHeading.length;
  const end = endHeading ? text.indexOf(endHeading, from) : -1;
  const sliced = (end >= 0 ? text.slice(start, end) : text.slice(start)).trim();
  return sliced || undefined;
}

function findArea(body: string | undefined, title: RegExp): string | undefined {
  if (!body) {
    return undefined;
  }
  const lines = body.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^##\s+\d+\./.test(line)) {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
      }
      current = [line];
      continue;
    }
    if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push(current.join("\n"));
  }

  return blocks.find((block) => title.test(block));
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

async function readIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
