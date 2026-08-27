import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModelSelection } from "@factory/schemas";

export interface PiModelConfigurationStatus {
  agentDir: string;
  globalSettingsPath: string;
  projectSettingsPath: string;
  authPath: string;
  modelsPath: string;
  modelsStorePath: string;
  commandCodeModelsPath: string;
  defaultProvider?: string;
  defaultModel?: string;
  enabledModels: string[];
  configuredModels: ModelSelection[];
  authProviders: string[];
  customProviderCount: number;
  customModelCount: number;
  hasModelSelection: boolean;
  hasAuth: boolean;
}

export async function detectPiModelConfiguration(
  cwd: string,
  options?: { agentDir?: string },
): Promise<PiModelConfigurationStatus> {
  const agentDir = options?.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const globalSettingsPath = path.join(agentDir, "settings.json");
  const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
  const authPath = path.join(agentDir, "auth.json");
  const modelsPath = path.join(agentDir, "models.json");
  const modelsStorePath = path.join(agentDir, "models-store.json");
  const commandCodeModelsPath = path.join(agentDir, "commandcode-models.json");

  const globalSettings = (await readJsonFile<Record<string, unknown>>(globalSettingsPath)) ?? {};
  const projectSettings = (await readJsonFile<Record<string, unknown>>(projectSettingsPath)) ?? {};
  const auth = (await readJsonFile<Record<string, unknown>>(authPath)) ?? {};
  const models = (await readJsonFile<Record<string, unknown>>(modelsPath)) ?? {};
  const modelsStore = (await readJsonFile<Record<string, unknown>>(modelsStorePath)) ?? {};
  const commandCodeModels = (await readJsonFile<Record<string, unknown>>(commandCodeModelsPath)) ?? {};

  const defaultProvider =
    readString(projectSettings.defaultProvider) ?? readString(globalSettings.defaultProvider);
  const defaultModel = readString(projectSettings.defaultModel) ?? readString(globalSettings.defaultModel);
  const enabledModels =
    readStringArray(projectSettings.enabledModels) ?? readStringArray(globalSettings.enabledModels) ?? [];
  const authProviders = Object.entries(auth)
    .filter(([, value]) => value && typeof value === "object")
    .map(([key]) => key)
    .sort();

  const providersRecord = asRecord(models.providers);
  const customProviders: Record<string, unknown>[] = providersRecord
    ? Object.values(providersRecord).filter(
        (value): value is Record<string, unknown> => Boolean(value) && typeof value === "object",
      )
    : [];
  const customModelCount = customProviders.reduce<number>((count, provider) => {
    const modelsValue = provider.models;
    return count + (Array.isArray(modelsValue) ? modelsValue.length : 0);
  }, 0);
  const configuredModels = collectConfiguredModels({
    defaultProvider,
    defaultModel,
    enabledModels,
    authProviders,
    models,
    modelsStore,
    commandCodeModels,
  });

  return {
    agentDir,
    globalSettingsPath,
    projectSettingsPath,
    authPath,
    modelsPath,
    modelsStorePath,
    commandCodeModelsPath,
    defaultProvider,
    defaultModel,
    enabledModels,
    configuredModels,
    authProviders,
    customProviderCount: customProviders.length,
    customModelCount,
    hasModelSelection: Boolean((defaultProvider && defaultModel) || enabledModels.length > 0 || customModelCount > 0 || configuredModels.length > 0),
    hasAuth: authProviders.length > 0,
  };
}

export function collectVisiblePiModels(
  pi: Pick<PiModelConfigurationStatus, "defaultProvider" | "defaultModel" | "configuredModels"> | undefined,
): ModelSelection[] {
  const out: ModelSelection[] = [];
  const seen = new Set<string>();

  const add = (selection?: ModelSelection): void => {
    if (!selection?.model) {
      return;
    }
    const key = modelSelectionKey(selection);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(selection);
  };

  if (pi?.defaultProvider && pi.defaultModel) {
    add({ provider: pi.defaultProvider, model: pi.defaultModel });
  }
  for (const selection of pi?.configuredModels ?? []) {
    add(selection);
  }

  return out;
}

export function modelSelectionKey(selection: Pick<ModelSelection, "provider" | "model">): string {
  return `${selection.provider ?? ""}:${selection.model}`;
}

function collectConfiguredModels(input: {
  defaultProvider?: string;
  defaultModel?: string;
  enabledModels: string[];
  authProviders: string[];
  models: Record<string, unknown>;
  modelsStore: Record<string, unknown>;
  commandCodeModels: Record<string, unknown>;
}): ModelSelection[] {
  const out: ModelSelection[] = [];
  const seen = new Set<string>();
  const add = (provider: string | undefined, model: unknown): void => {
    if (typeof model !== "string" || !model.trim()) return;
    const selection = { ...(provider ? { provider } : {}), model: model.trim() };
    const key = modelSelectionKey(selection);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(selection);
  };

  add(input.defaultProvider, input.defaultModel);
  for (const model of input.enabledModels) {
    add(input.defaultProvider, model);
  }

  const storeProviders = asRecord(input.modelsStore);
  for (const provider of input.authProviders) {
    const providerRecord = asRecord(storeProviders?.[provider]);
    const models = Array.isArray(providerRecord?.models) ? providerRecord.models : [];
    for (const model of models) {
      const id = asRecord(model)?.id;
      add(provider, id);
    }
  }

  if (input.authProviders.includes("commandcode")) {
    const models = Array.isArray(input.commandCodeModels.models) ? input.commandCodeModels.models : [];
    for (const model of models) {
      const id = asRecord(model)?.id;
      add("commandcode", id);
    }
  }

  const customProviders = asRecord(input.models.providers);
  if (customProviders) {
    for (const [provider, providerConfig] of Object.entries(customProviders)) {
      const providerRecord = asRecord(providerConfig);
      const models = Array.isArray(providerRecord?.models) ? providerRecord.models : [];
      for (const model of models) {
        const id = asRecord(model)?.id;
        add(provider, id);
      }
    }
  }

  return out;
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
