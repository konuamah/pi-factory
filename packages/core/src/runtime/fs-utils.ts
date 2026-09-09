import fs from "node:fs/promises";

/** True if the path is accessible (exists). Shared by runtime modules. */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
