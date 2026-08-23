import fs from "node:fs/promises";
import path from "node:path";

export interface RepoLearningEntry {
  timestamp: string;
  category: string;
  summary: string;
  data?: Record<string, unknown>;
}

export async function appendRepoLearning(input: {
  projectRoot: string;
  category: string;
  summary: string;
  data?: Record<string, unknown>;
}): Promise<string> {
  const filePath = path.join(input.projectRoot, ".factory", "learnings.jsonl");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const entry: RepoLearningEntry = {
    timestamp: new Date().toISOString(),
    category: input.category,
    summary: input.summary,
    data: input.data,
  };
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  return filePath;
}
