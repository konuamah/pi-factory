import type { ModelRole, ModelSelection } from "@factory/schemas";
import type { FactoryWorkflowPreset, PiModelConfigurationStatus } from "@factory/core";
import type { FactoryPiUi } from "./types.js";

export interface FactorySetupChoices {
  workflowPreset: FactoryWorkflowPreset;
  modelAssignments: Partial<Record<ModelRole, ModelSelection>>;
}

const MODEL_ROLES: ModelRole[] = ["discovery", "planner", "builder", "reviewer", "repair"];

export async function promptFactorySetupChoices(
  ui: FactoryPiUi,
  piStatus: PiModelConfigurationStatus,
): Promise<FactorySetupChoices> {
  const workflowPreset = await selectWorkflowPreset(ui);
  const modelAssignments = await selectModelAssignments(ui, piStatus);
  return { workflowPreset, modelAssignments };
}

async function selectWorkflowPreset(ui: FactoryPiUi): Promise<FactoryWorkflowPreset> {
  const options = [
    "Balanced — Standard plan, build, verify, approve, merge flow",
    "Fast — Lighter-weight plan, build, approve, merge flow",
    "Safe — Verification-first workflow for lower-risk execution",
  ];
  const selected = await ui.select?.("Factory workflow preset", options);

  if (selected?.startsWith("Fast")) {
    return "fast";
  }
  if (selected?.startsWith("Safe")) {
    return "safe";
  }
  return "balanced";
}

async function selectModelAssignments(
  ui: FactoryPiUi,
  piStatus: PiModelConfigurationStatus,
): Promise<Partial<Record<ModelRole, ModelSelection>>> {
  const defaultSelection =
    piStatus.defaultProvider && piStatus.defaultModel
      ? { provider: piStatus.defaultProvider, model: piStatus.defaultModel }
      : undefined;

  const modeOptions = [
    ...(defaultSelection
      ? [`Use Pi default for all roles — ${defaultSelection.provider}/${defaultSelection.model}`]
      : []),
    "Choose per role — Assign or skip models for discovery, planner, builder, reviewer, and repair",
    "Skip Factory role model config — Leave role models unset in project config",
  ];
  const mode = await ui.select?.("Factory role model setup", modeOptions);

  if (mode?.startsWith("Use Pi default for all roles") && defaultSelection) {
    return Object.fromEntries(MODEL_ROLES.map((role) => [role, defaultSelection]));
  }

  if (!mode?.startsWith("Choose per role")) {
    return {};
  }

  const assignments: Partial<Record<ModelRole, ModelSelection>> = {};
  for (const role of MODEL_ROLES) {
    const choiceOptions = [
      ...(defaultSelection
        ? [`Use Pi default — ${defaultSelection.provider}/${defaultSelection.model}`]
        : []),
      "Enter provider/model manually",
      "Skip this role",
    ];
    const choice = await ui.select?.(`Model for ${role}`, choiceOptions);

    if (choice?.startsWith("Use Pi default") && defaultSelection) {
      assignments[role] = defaultSelection;
      continue;
    }

    if (choice === "Enter provider/model manually") {
      const provider = (await ui.input?.(`Provider for ${role}`, "e.g. anthropic, openai, ollama"))?.trim();
      const model = (await ui.input?.(`Model for ${role}`, "e.g. claude-sonnet-4-20250514"))?.trim();
      if (provider && model) {
        assignments[role] = { provider, model };
      }
    }
  }

  return assignments;
}
