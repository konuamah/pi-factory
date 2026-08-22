import type {
  PiSessionFactory,
  PiSessionFactoryInput,
  PiSessionFactoryResult,
  PiSessionLike,
} from "./types.js";

export interface PiSdkSessionFactoryOptions {
  packageName?: string;
}

export function createPiSdkSessionFactory(
  options: PiSdkSessionFactoryOptions = {},
): PiSessionFactory {
  const packageName = options.packageName ?? "@earendil-works/pi-coding-agent";

  return {
    async create(input: PiSessionFactoryInput): Promise<PiSessionFactoryResult> {
      const sdk = await loadPiSdk(packageName);
      const sessionManager = sdk.SessionManager.inMemory(input.cwd);
      const createOptions: Record<string, unknown> = {
        cwd: input.cwd,
        sessionManager,
      };

      if (input.tools && input.tools.length > 0) {
        createOptions.tools = input.tools;
      }

      if (input.model) {
        const modelRuntime = await sdk.ModelRuntime.create();
        createOptions.modelRuntime = modelRuntime;

        const resolvedModel =
          typeof modelRuntime.getModel === "function" && input.model.provider
            ? modelRuntime.getModel(input.model.provider, input.model.model)
            : undefined;

        if (resolvedModel) {
          createOptions.model = resolvedModel;
        }
      }

      const created = await sdk.createAgentSession(createOptions);
      return {
        session: wrapPiSdkSession(created.session),
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
}

interface PiSdkModule {
  createAgentSession(options: Record<string, unknown>): Promise<{ session: PiSdkAgentSession }>;
  SessionManager: {
    inMemory(cwd?: string): unknown;
  };
  ModelRuntime: {
    create(): Promise<{
      getModel?: (provider: string, model: string) => unknown;
    }>;
  };
}
