import type {
  PiSessionFactory,
  PiSessionFactoryInput,
  PiSessionFactoryResult,
  PiSessionLike,
} from "./types.js";
import type { ToolCallContext } from "@factory/core";
import { ModelProviderResolutionError } from "@factory/core";
import { wrapToolsWithGate, type ToolGateOptions } from "./tool-gate.js";
import type { ToolInventory } from "@factory/core";

export interface PiSdkSessionFactoryOptions {
  packageName?: string;
  sdkLoader?: (packageName: string) => Promise<PiSdkModule>;
  toolGate?: Omit<ToolGateOptions, "context">;
  createTools?: (sdk: PiSdkModule, cwd: string, names: string[]) => Array<{ name: string; execute: (args: unknown) => Promise<unknown> }>;
}

export function createPiSdkSessionFactory(
  options: PiSdkSessionFactoryOptions = {},
): PiSessionFactory {
  const packageName = options.packageName ?? "@earendil-works/pi-coding-agent";
  const sdkLoader = options.sdkLoader ?? loadPiSdk;

  return {
    async describeTools(input: PiSessionFactoryInput): Promise<ToolInventory> {
      const sdk = await sdkLoader(packageName);
      const all = [...(sdk.createReadOnlyTools?.(input.cwd) ?? []), ...(sdk.createCodingTools?.(input.cwd) ?? [])];
      const available = [...new Set(all.map((tool) => tool.name))];
      const known = new Set(available);
      const requested = input.tools ?? [];
      return {
        available,
        unavailable: [],
        unknown: requested.filter((tool) => !known.has(tool)),
      };
    },
    async create(input: PiSessionFactoryInput): Promise<PiSessionFactoryResult> {
      const sdk = await sdkLoader(packageName);
      const sessionManager = sdk.SessionManager.inMemory(input.cwd);
      const createOptions: Record<string, unknown> = {
        cwd: input.cwd,
        sessionManager,
      };
      // Session-local provider timeout from Factory policy. Never mutates
      // global Pi settings; each execution gets its own in-memory manager.
      const limits = input.limits as { modelTimeoutMs?: number } | undefined;
      if (sdk.SettingsManager?.inMemory && limits?.modelTimeoutMs) {
        const settings = sdk.SettingsManager.inMemory();
        settings.applyOverrides({
          retry: {
            provider: {
              timeoutMs: limits.modelTimeoutMs,
            },
          },
        } as never);
        createOptions.settingsManager = settings;
      }
      const diagnostics: PiSessionFactoryResult["diagnostics"] = [];

      // Services load the project's Pi packages/extensions and register their
      // providers on the returned modelRuntime. A bare ModelRuntime.create()
      // only knows built-in providers, so a model from an installed provider
      // package (commandcode and friends) cannot be resolved without this.
      const services = sdk.createAgentSessionServices
        ? await sdk.createAgentSessionServices({ cwd: input.cwd })
        : undefined;
      if (services) {
        createOptions.modelRuntime = services.modelRuntime;
        createOptions.modelRegistry = services.modelRegistry;
        createOptions.authStorage = services.authStorage;
        createOptions.settingsManager = services.settingsManager;
        createOptions.resourceLoader = services.resourceLoader;
        createOptions.agentDir = services.agentDir;
      }

      const tools = input.tools && input.tools.length > 0 ? input.tools : undefined;
      let executableTools: Array<{ name: string; execute: (args: unknown) => Promise<unknown> }> | undefined;
      if (tools) {
        const createdTools = (options.createTools ?? createBuiltinTools)(sdk, input.cwd, tools, (input.limits as { toolTimeoutMs?: number } | undefined)?.toolTimeoutMs);
        const missingTools = findMissingTools(tools, createdTools);
        if (missingTools.length > 0) {
          throw new Error(`Pi SDK did not provide required Factory tool(s): ${missingTools.join(", ")}`);
        }
        // Pi SDK's `tools` option is an allowlist of active built-in tool
        // names, not tool definition objects. Keep executable objects only for
        // Factory's DSML/manual bridge path.
        createOptions.tools = tools;
        if (options.toolGate) {
          const gateContext = buildGateContext(input, options.toolGate);
          executableTools = wrapToolsWithGate(createdTools as Parameters<typeof wrapToolsWithGate>[0], {
            ...options.toolGate,
            context: gateContext,
          });
        } else {
          executableTools = createdTools;
        }
      } else {
        createOptions.tools = [];
      }

      // If caller supplies a model, respect it strictly; otherwise let Pi use
      // the user's default (commandcode/OAuth etc.) — do NOT inject a stale env model.
      if (input.model) {
        const resolution = await resolveRequestedModel(sdk, input.model, services);
        if (resolution.modelRuntime && !createOptions.modelRuntime) {
          createOptions.modelRuntime = resolution.modelRuntime;
        }
        if (resolution.resolvedModel) {
          createOptions.model = resolution.resolvedModel;
        }
        if (resolution.warning) {
          diagnostics.push({
            type: "model.selection_warning",
            data: {
              requestedProvider: input.model.provider,
              requestedModel: input.model.model,
              reason: resolution.warning,
              fallback: "sdk-default",
            },
          });
        }
      } else {
        diagnostics.push({
          type: "model.selection_warning",
          data: {
            requestedModel: "(default)",
            requestedProvider: "(default)",
            reason: "No model requested — using Pi default from settings.json/auth.json (commandcode/Spark etc.)",
            fallback: "sdk-default",
          },
        });
      }

      const created = await sdk.createAgentSession(createOptions);
      return {
        session: wrapPiSdkSession(created.session, executableTools),
        diagnostics,
      };
    },
  };
}

function wrapPiSdkSession(
  session: PiSdkAgentSession,
  tools?: Array<{ name: string; execute: (args: unknown) => Promise<unknown> }>,
): PiSessionLike {
  const toolMap = new Map((tools ?? []).map((tool) => [tool.name, tool]));
  return {
    prompt(text: string) {
      return session.prompt(text);
    },
    subscribe(listener) {
      return session.subscribe((event: Record<string, unknown>) => {
        listener(mapPiSdkEvent(event));
      });
    },
    abort() {
      return session.abort();
    },
    async executeTool(name: string, args: unknown) {
      const tool = toolMap.get(name);
      if (!tool) {
        throw new Error(`Pi SDK tool '${name}' is not available to this session.`);
      }
      return await tool.execute(args);
    },
    dispose() {
      return session.dispose();
    },
  };
}

function mapPiSdkEvent(event: Record<string, unknown>) {
  const type = typeof event.type === "string" ? event.type : "unknown";
  const text = extractEventText(event);
  return {
    type,
    text,
    data: event,
  };
}

function extractEventText(event: Record<string, unknown>): string | undefined {
  const message = asRecord(event.message);
  if (message && typeof message.role === "string" && message.role !== "assistant") {
    return undefined;
  }

  if (typeof event.text === "string") {
    return event.text;
  }

  if (event.type === "message_update") {
    const assistantMessageEvent = asRecord(event.assistantMessageEvent);
    if (
      assistantMessageEvent &&
      assistantMessageEvent.type === "text_delta" &&
      typeof assistantMessageEvent.delta === "string"
    ) {
      return assistantMessageEvent.delta;
    }
  }

  if (message) {
    const content = message.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      // SDK 0.84+ emits full assistant messages as content-block arrays on
      // message_end/turn_end; no text_delta stream events fire.
      const text = content
        .map((block) => {
          if (typeof block === "string") return block;
          const b = asRecord(block);
          return typeof b?.text === "string" ? b.text : undefined;
        })
        .filter((value): value is string => typeof value === "string")
        .join("");
      return text || undefined;
    }
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

type PiModelRuntime = Awaited<ReturnType<NonNullable<PiSdkModule["ModelRuntime"]>["create"]>>;

async function resolveRequestedModel(
  sdk: PiSdkModule,
  model: NonNullable<PiSessionFactoryInput["model"]>,
  services?: PiSdkServices,
): Promise<{
  modelRuntime?: PiModelRuntime;
  resolvedModel?: unknown;
  warning?: string;
}> {
  if (!model.provider) {
    throw new ModelProviderResolutionError(
      `Configured model \"${model.model}\" has no provider, so Factory cannot resolve it. Fix it by running the Factory concierge skill (recommended) or /factory models to see detected Pi models, then set a model with provider, e.g. models.planner: { provider: \"openai\", model: \"gpt-4o\" } in .factory/config.yaml.`,
    );
  }

  // Prefer the runtime that already has the project's provider packages registered.
  let modelRuntime: PiModelRuntime | undefined = services?.modelRuntime as PiModelRuntime | undefined;
  const registryModel = services?.modelRegistry?.find?.(model.provider, model.model);
  if (registryModel) {
    return {
      modelRuntime,
      resolvedModel: registryModel,
    };
  }
  if (!modelRuntime && sdk.ModelRuntime?.create) {
    modelRuntime = await sdk.ModelRuntime.create();
  }

  // SDK builds without a queryable runtime: hand the provider/model pair to
  // createAgentSession and let Pi resolve it against its own defaults.
  if (!modelRuntime) {
    return {
      resolvedModel: { provider: model.provider, model: model.model, id: model.model },
    };
  }

  const resolvedModel =
    typeof modelRuntime.getModel === "function"
      ? modelRuntime.getModel(model.provider, model.model)
      : undefined;

  if (!resolvedModel) {
    const extensionErrors = (services?.diagnostics ?? [])
      .filter((diagnostic) => diagnostic.type === "error")
      .map((diagnostic) => diagnostic.message);
    const detail = extensionErrors.length
      ? ` Pi reported: ${extensionErrors.join("; ")}`
      : "";
    throw new ModelProviderResolutionError(
      `Configured model \"${model.provider}:${model.model}\" could not be resolved by the Pi SDK.${detail} No fallback is used. Fix it by running the Factory concierge skill (recommended) or /factory models to see which models this Pi SDK actually exposes, then set models.planner / models.builder / models.reviewer / models.repair in .factory/config.yaml to one of those, e.g. { provider: \"<provider>\", model: \"<model-id>\" }.`,
    );
  }

  return {
    modelRuntime,
    resolvedModel,
  };
}

function buildGateContext(
  input: PiSessionFactoryInput,
  gate: Omit<ToolGateOptions, "context">,
): ToolCallContext {
  const metadata = asRecord(input.metadata) ?? {};
  return {
    executionId: typeof metadata.executionId === "string" ? metadata.executionId : "unknown",
    role: typeof metadata.role === "string" ? metadata.role : undefined,
    taskId: typeof metadata.taskId === "string" ? metadata.taskId : undefined,
    workflowId: typeof metadata.workflowId === "string" ? metadata.workflowId : undefined,
    grantedCapabilities: stringArray(metadata.grantedCapabilities),
    deniedCapabilities: stringArray(metadata.deniedCapabilities),
    needsApproval: stringArray(metadata.needsApprovalCapabilities),
    approvedCapabilities: new Set<string>(),
    skills: gate.skills,
    negotiated: gate.negotiated ?? (metadata.negotiated as ToolCallContext["negotiated"] | undefined),
    projectPolicy: gate.projectPolicy,
    workflowPolicy: gate.workflowPolicy,
    nodePolicy: gate.nodePolicy,
    cwd: input.cwd,
  };
}

function createBuiltinTools(
  sdk: PiSdkModule,
  cwd: string,
  names: string[],
  maxToolTimeoutMs?: number,
): Array<{ name: string; execute: (args: unknown) => Promise<unknown> }> {
  const all = [...(sdk.createReadOnlyTools?.(cwd) ?? []), ...(sdk.createCodingTools?.(cwd) ?? [])];
  const byName = new Map(all.map((tool) => [tool.name, tool]));
  return names
    .map((name) => byName.get(name))
    .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
    .map((tool) => ({
      name: tool.name,
      execute: async (args: unknown) => {
        // Clamp model-supplied bash timeout to Factory's hard ceiling.
        // Model cannot extend the tool limit.
        let callArgs = args;
        if (tool.name === "bash" && maxToolTimeoutMs && args && typeof args === "object" && !Array.isArray(args)) {
          const record = args as Record<string, unknown>;
          if (typeof record.timeout === "number") {
            callArgs = { ...record, timeout: Math.min(record.timeout, maxToolTimeoutMs) };
          }
        }
        return await tool.execute(`factory-${tool.name}-${Date.now()}`, callArgs);
      },
    }));
}

function findMissingTools(requested: string[], created: Array<{ name: string }>): string[] {
  const available = new Set(created.map((tool) => tool.name));
  return [...new Set(requested)].filter((name) => !available.has(name));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function loadPiSdk(packageName: string): Promise<PiSdkModule> {
  const importer = new Function("specifier", "return import(specifier);") as (
    specifier: string,
  ) => Promise<unknown>;

  try {
    const loaded = await importer(packageName);
    return loaded as PiSdkModule;
  } catch (error) {
    throw new Error(
      `Failed to load Pi SDK package \"${packageName}\". Install it before using createPiSdkSessionFactory().`,
      { cause: error },
    );
  }
}

interface PiSdkAgentSession {
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: Record<string, unknown>) => void): () => void;
  abort(): Promise<void>;
  dispose(): Promise<void> | void;
}

interface PiSdkServices {
  cwd: string;
  agentDir: string;
  modelRuntime?: {
    getModel?: (provider: string, model: string) => unknown;
  };
  modelRegistry?: {
    find?: (provider: string, model: string) => unknown;
    getAvailable?: () => unknown[] | Promise<unknown[]>;
  };
  authStorage?: unknown;
  settingsManager?: unknown;
  resourceLoader?: unknown;
  diagnostics?: Array<{ type: string; message: string }>;
}

interface PiSdkModule {
  createAgentSession(options: Record<string, unknown>): Promise<{ session: PiSdkAgentSession }>;
  createAgentSessionServices?(options: { cwd: string }): Promise<PiSdkServices>;
  SessionManager: {
    inMemory(cwd?: string): unknown;
  };
  SettingsManager?: {
    inMemory?(settings?: unknown): {
      applyOverrides(overrides: unknown): void;
    };
  };
  createReadOnlyTools?(cwd?: string): Array<{ name: string; execute: (toolCallId: string, args: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown> }>;
  createCodingTools?(cwd?: string): Array<{ name: string; execute: (toolCallId: string, args: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown> }>;
  ModelRuntime?: {
    create(): Promise<{
      getModel?: (provider: string, model: string) => unknown;
    }>;
  };
}
