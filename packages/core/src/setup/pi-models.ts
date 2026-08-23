import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface PiModelConfigurationStatus {
  agentDir: string;
  globalSettingsPath: string;
  projectSettingsPath: string;
  authPath: string;
  modelsPath: string;
  defaultProvider?: string;
  defaultModel?: string;
  enabledModels: string[];
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

  const globalSettings = (await readJsonFile<Record<string, unknown>>(globalSettingsPath)) ?? {};
  const projectSettings = (await readJsonFile<Record<string, unknown>>(projectSettingsPath)) ?? {};
  const auth = (await readJsonFile<Record<string, unknown>>(authPath)) ?? {};
  const models = (await readJsonFile<Record<string, unknown>>(modelsPath)) ?? {};

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

  return {
    agentDir,
    globalSettingsPath,
    projectSettingsPath,
    authPath,
    modelsPath,
    defaultProvider,
    defaultModel,
    enabledModels,
    authProviders,
    customProviderCount: customProviders.length,
    customModelCount,
    hasModelSelection: Boolean((defaultProvider && defaultModel) || enabledModels.length > 0 || customModelCount > 0),
    hasAuth: authProviders.length > 0,
  };
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
