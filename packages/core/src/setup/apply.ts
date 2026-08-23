import fs from "node:fs/promises";
import path from "node:path";
import type { FactorySetupPlan } from "./types.js";

export async function applyFactorySetup(plan: FactorySetupPlan): Promise<string[]> {
  const written: string[] = [];
  for (const file of plan.proposed.files) {
    if (file.action === "unchanged") {
      continue;
    }
    await fs.mkdir(path.dirname(file.path), { recursive: true });
    await fs.writeFile(file.path, file.content, "utf8");
    written.push(file.path);
  }
  return written;
}
