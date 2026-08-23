import type {
  ConstitutionRequirement,
  ProviderVerificationResult,
  VerificationProvider,
  VerificationProviderContext,
} from "../types.js";
import fs from "node:fs/promises";
import path from "node:path";

export const constitutionProvider: VerificationProvider = {
  type: "CONSTITUTION",
  async verify(requirement, context): Promise<ProviderVerificationResult> {
    const constitution = requirement as ConstitutionRequirement;
    const evidenceId = `EV-${++constitutionCounter}`;
    const constitutionPath = path.join(context.cwd, "CONSTITUTION.md");
    const body = await readIfExists(constitutionPath);
    const requiredStatus = constitution.requiredStatus ?? ["DEFINED", "INFERRED"];

    if (!body) {
      context.evidence[evidenceId] = {
        kind: "constitution-check",
        areas: constitution.areaIds,
        present: false,
      };
      return {
        requirementId: requirement.id,
        status: constitution.blocking ? "FAIL" : "INCONCLUSIVE",
        evidence: [{ id: evidenceId, kind: "constitution-check" }],
        reason: "No CONSTITUTION.md present; required areas cannot be confirmed.",
      };
    }

    const missingAreas: number[] = [];
    for (const areaId of constitution.areaIds) {
      const status = findAreaStatus(body, areaId) as NonNullable<ConstitutionRequirement["requiredStatus"]>[number] | undefined;
      if (!status || !requiredStatus.includes(status)) {
        missingAreas.push(areaId);
      }
    }

    context.evidence[evidenceId] = {
      kind: "constitution-check",
      areas: constitution.areaIds,
      missingAreas,
      requiredStatus,
    };

    if (missingAreas.length > 0) {
      return {
        requirementId: requirement.id,
        status: "FAIL",
        evidence: [{ id: evidenceId, kind: "constitution-check" }],
        reason: `Constitution areas not at required status: ${missingAreas.join(", ")}`,
      };
    }

    return {
      requirementId: requirement.id,
      status: "PASS",
      evidence: [{ id: evidenceId, kind: "constitution-check" }],
    };
  },
};

let constitutionCounter = 0;

function findAreaStatus(body: string, areaId: number): string | undefined {
  // Constitution areas are rendered as "## N. Title" with "- Status: XXX".
  const lines = body.split(/\r?\n/);
  let inArea = false;
  for (const line of lines) {
    if (/^##\s+\d+\./.test(line)) {
      inArea = /^##\s+(\d+)\./.test(line) && Number(line.match(/^##\s+(\d+)\./)?.[1]) === areaId;
      continue;
    }
    if (inArea && /^- Status:\s*(.+)$/.test(line)) {
      return line.match(/^- Status:\s*(.+)$/)?.[1]?.trim();
    }
    if (inArea && /^##\s+/.test(line) && !/^##\s+\d+\./.test(line)) {
      break;
    }
  }
  return undefined;
}

async function readIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}
