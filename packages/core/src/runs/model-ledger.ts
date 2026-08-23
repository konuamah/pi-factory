import fs from "node:fs/promises";
import path from "node:path";

export interface ModelLedgerEntry {
  timestamp: string;
  operationId: string;
  taskId?: string;
  nodeId?: string;
  role: string;
  taskType: string;
  taskTypeSource: string;
  taskTypeConfidence?: number;
  requestedModel: string;
  resolvedModel: string;
  provider?: string;
  modelSource: string;
}

export async function appendModelLedgerEntry(
  runDir: string,
  entry: Omit<ModelLedgerEntry, "timestamp">,
): Promise<string> {
  const filePath = path.join(runDir, "model-ledger.jsonl");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const full: ModelLedgerEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };
  await fs.appendFile(filePath, `${JSON.stringify(full)}\n`, "utf8");
  return filePath;
}

export async function readModelLedger(runDir: string): Promise<ModelLedgerEntry[]> {
  try {
    const raw = await fs.readFile(path.join(runDir, "model-ledger.jsonl"), "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ModelLedgerEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
