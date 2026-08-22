import fs from "node:fs/promises";
import path from "node:path";
import type { PrototypeTaskArtifact } from "./artifacts.js";

export async function updatePrototypeTaskArtifact(input: {
  runDir: string;
  taskId: string;
  patch: Partial<Pick<PrototypeTaskArtifact, "status" | "workspacePath" | "workspaceMode" | "workspaceBranch">>;
}): Promise<PrototypeTaskArtifact> {
  const filePath = path.join(input.runDir, "tasks", `${input.taskId}.json`);
  const raw = await fs.readFile(filePath, "utf8");
  const current = JSON.parse(raw) as PrototypeTaskArtifact;
  const next: PrototypeTaskArtifact = {
    ...current,
    ...input.patch,
  };
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), "utf8");
  return next;
}
