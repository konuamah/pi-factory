import type {
  PiSessionFactory,
  PiSessionFactoryInput,
  PiSessionFactoryResult,
  PiSessionLike,
} from "./types.js";
import type { ToolCallContext } from "@factory/core";
import { ModelProviderResolutionError } from "@factory/core";
import { wrapToolsWithGate, type ToolGateOptions } from "./tool-gate.js";

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
    async create(input: PiSessionFactoryInput): Promise<PiSessionFactoryResult> {
      const sdk = await sdkLoader(packageName);
      const sessionManager = sdk.SessionManager.inMemory(input.cwd);
      const createOptions: Record<string, unknown> = {
        cwd: input.cwd,
        sessionManager,
      };
      const diagnostics: PiSessionFactoryResult["diagnostics"] = [];

      const tools = input.tools && input.tools.length > 0 ? input.tools : undefined;
      let executableTools: Array<{ name: string; execute: (args: unknown) => Promise<unknown> }> | undefined;
      if (tools) {
        const createdTools = (options.createTools ?? createBuiltinTools)(sdk, input.cwd, tools);
        const missingTools = findMissingTools(tools, createdTools);
        if (missingTools.length > 0) {
          throw new Error(`Pi SDK did not provide required Factory tool(s): ${missingTools.join(", ")}`);
        }
        if (options.toolGate) {
          const gateContext = buildGateContext(input, options.toolGate);
          createOptions.tools = wrapToolsWithGate(createdTools as Parameters<typeof wrapToolsWithGate>[0], {
            ...options.toolGate,
            context: gateContext,
          });
        } else {
          createOptions.tools = createdTools;
        }
        executableTools = createOptions.tools as Array<{ name: string; execute: (args: unknown) => Promise<unknown> }>;
      }

      // If caller supplies a model, respect it strictly; otherwise let Pi use
      // the user's default (commandcode/OAuth etc.) — do NOT inject a stale env model.
      if (input.model) {
        const resolution = await resolveRequestedModel(sdk, input.model);
        if (resolution.modelRuntime) {
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

  const message = asRecord(event.message);
  if (message) {
    const content = message.content;
    if (typeof content === "string") {
      return content;
    }
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

async function resolveRequestedModel(
  sdk: PiSdkModule,
  model: NonNullable<PiSessionFactoryInput["model"]>,
): Promise<{
  modelRuntime?: Awaited<ReturnType<NonNullable<PiSdkModule["ModelRuntime"]>["create"]>>;
  resolvedModel?: unknown;
  warning?: string;
}> {
  if (!model.provider) {
    throw new ModelProviderResolutionError(
      `Configured model \"${model.model}\" has no provider, so Factory cannot resolve it. Provide a provider or remove the model from config.`,
    );
  }

  // SDK 0.82 no longer exposes ModelRuntime — pass model directly to createAgentSession.
  // Old path kept for backward compat when ModelRuntime exists.
  if (!sdk.ModelRuntime?.create) {
    return {
      resolvedModel: { provider: model.provider, model: model.model, id: model.model },
    };
  }

  const modelRuntime = await sdk.ModelRuntime.create();

  const resolvedModel =
    typeof modelRuntime.getModel === "function"
      ? modelRuntime.getModel(model.provider, model.model)
      : undefined;

  if (!resolvedModel) {
    throw new ModelProviderResolutionError(
      `Configured model \"${model.provider}:${model.model}\" could not be resolved by the Pi SDK. No fallback is used.`,
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
    projectPolicy: gate.projectPolicy,
    workflowPolicy: gate.workflowPolicy,
    nodePolicy: gate.nodePolicy,
    cwd: input.cwd,
  };
}

function createBuiltinTools(sdk: PiSdkModule, cwd: string, names: string[]): Array<{ name: string; execute: (args: unknown) => Promise<unknown> }> {
  const all = [...(sdk.createReadOnlyTools?.(cwd) ?? []), ...(sdk.createCodingTools?.(cwd) ?? [])];
  const byName = new Map(all.map((tool) => [tool.name, tool]));
  return names
    .map((name) => byName.get(name))
    .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
    .map((tool) => ({
      name: tool.name,
      execute: async (args: unknown) => await tool.execute(`factory-${tool.name}-${Date.now()}`, args),
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

interface PiSdkModule {
  createAgentSession(options: Record<string, unknown>): Promise<{ session: PiSdkAgentSession }>;
  SessionManager: {
    inMemory(cwd?: string): unknown;
  };
  createReadOnlyTools?(cwd?: string): Array<{ name: string; execute: (toolCallId: string, args: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown> }>;
  createCodingTools?(cwd?: string): Array<{ name: string; execute: (toolCallId: string, args: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown> }>;
  ModelRuntime?: {
    create(): Promise<{
      getModel?: (provider: string, model: string) => unknown;
    }>;
  };
}
