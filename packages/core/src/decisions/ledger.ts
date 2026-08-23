import fs from "node:fs/promises";
import path from "node:path";
import type { DecisionRequest, DecisionResult } from "./types.js";

export type DecisionLedgerEntry =
  | { type: "request"; request: DecisionRequest }
  | { type: "resolution"; result: DecisionResult };

export async function appendDecisionLedgerEntry(
  runDir: string,
  entry: DecisionLedgerEntry,
): Promise<string> {
  const filePath = path.join(runDir, "decisions.jsonl");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  return filePath;
}

export async function readDecisionLedger(runDir: string): Promise<DecisionLedgerEntry[]> {
  try {
    const raw = await fs.readFile(path.join(runDir, "decisions.jsonl"), "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DecisionLedgerEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function findPendingDecision(runDir: string): Promise<DecisionRequest | undefined> {
  const entries = await readDecisionLedger(runDir);
  const requests = entries.filter((entry): entry is { type: "request"; request: DecisionRequest } => entry.type === "request");
  const request = requests[requests.length - 1];
  if (!request) {
    return undefined;
  }
  const resolved = entries.some(
    (entry) => entry.type === "resolution" && entry.result.requestId === request.request.id,
  );
  return resolved ? undefined : request.request;
}
