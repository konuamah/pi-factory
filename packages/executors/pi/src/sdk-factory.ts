import type {
  PiSessionFactory,
  PiSessionFactoryInput,
  PiSessionFactoryResult,
  PiSessionLike,
} from "./types.js";

export interface PiSdkSessionFactoryOptions {
  packageName?: string;
  sdkLoader?: (packageName: string) => Promise<PiSdkModule>;
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

      if (input.tools && input.tools.length > 0) {
        createOptions.tools = input.tools;
      }

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
      }

      const created = await sdk.createAgentSession(createOptions);
      return {
        session: wrapPiSdkSession(created.session),
        diagnostics,
      };
    },
  };
}

function wrapPiSdkSession(session: PiSdkAgentSession): PiSessionLike {
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
  if (!sdk.ModelRuntime?.create) {
    return {
      warning: `Configured model \"${model.model}\" could not be resolved because this Pi SDK does not expose ModelRuntime; falling back to the SDK default model.`,
    };
  }

  const modelRuntime = await sdk.ModelRuntime.create();
  if (!model.provider) {
    return {
      modelRuntime,
      warning: `Configured model \"${model.model}\" has no provider, so Factory could not resolve it explicitly; falling back to the SDK default model.`,
    };
  }

  const resolvedModel =
    typeof modelRuntime.getModel === "function"
      ? modelRuntime.getModel(model.provider, model.model)
      : undefined;

  if (!resolvedModel) {
    return {
      modelRuntime,
      warning: `Configured model \"${model.provider}:${model.model}\" could not be resolved by the Pi SDK; falling back to the SDK default model.`,
    };
  }

  return {
    modelRuntime,
    resolvedModel,
  };
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
  ModelRuntime?: {
    create(): Promise<{
      getModel?: (provider: string, model: string) => unknown;
    }>;
  };
}
