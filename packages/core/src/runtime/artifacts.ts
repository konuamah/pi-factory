import fs from "node:fs/promises";
import path from "node:path";

export interface PrototypePlanArtifact {
  goal: string;
  tasks: Array<{
    id: string;
    title: string;
    status: "pending" | "done";
  }>;
}

export interface PrototypeVerificationArtifact {
  commands: Array<{
    name: string;
    command: string;
    status: "configured" | "missing";
  }>;
  overallStatus: "passed" | "incomplete";
}

export async function writePrototypePlanArtifact(
  runDir: string,
  artifact: PrototypePlanArtifact,
): Promise<string> {
  const filePath = path.join(runDir, "plan.json");
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

export async function writePrototypeVerificationArtifact(
  runDir: string,
  artifact: PrototypeVerificationArtifact,
): Promise<string> {
  const filePath = path.join(runDir, "verification.json");
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}
