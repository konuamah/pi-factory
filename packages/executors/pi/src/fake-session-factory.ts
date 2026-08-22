import type {
  PiSessionEvent,
  PiSessionFactory,
  PiSessionFactoryInput,
  PiSessionFactoryResult,
  PiSessionLike,
} from "./types.js";

export interface FakePiSessionScriptStep {
  delayMs?: number;
  event: PiSessionEvent;
}

export interface FakePiSessionFactoryOptions {
  script?: FakePiSessionScriptStep[];
  failWithMessage?: string;
}

export function createFakePiSessionFactory(
  options: FakePiSessionFactoryOptions = {},
): PiSessionFactory {
  return {
    async create(input: PiSessionFactoryInput): Promise<PiSessionFactoryResult> {
      return {
        session: new FakePiSession(input, options),
      };
    },
  };
}

class FakePiSession implements PiSessionLike {
  private readonly listeners = new Set<(event: PiSessionEvent) => void>();
  private aborted = false;

  constructor(
    private readonly input: PiSessionFactoryInput,
    private readonly options: FakePiSessionFactoryOptions,
  ) {}

  subscribe(listener: (event: PiSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async prompt(text: string): Promise<void> {
    this.emit({
      type: "agent_start",
      data: {
        cwd: this.input.cwd,
        prompt: text,
      },
    });

    const script =
      this.options.script ??
      defaultScript(text);

    for (const step of script) {
      if (this.aborted) {
        throw new Error("Session aborted");
      }
      if (step.delayMs && step.delayMs > 0) {
        await wait(step.delayMs);
      }
      this.emit(step.event);
    }

    if (this.options.failWithMessage) {
      throw new Error(this.options.failWithMessage);
    }

    this.emit({
      type: "agent_end",
      data: {
        prompt: text,
      },
    });
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.emit({
      type: "agent_aborted",
      data: {
        cwd: this.input.cwd,
      },
    });
  }

  dispose(): void {
    this.listeners.clear();
  }

  private emit(event: PiSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function defaultScript(prompt: string): FakePiSessionScriptStep[] {
  return [
    {
      event: {
        type: "message_update",
        text: `Working on: ${prompt}\n`,
      },
    },
    {
      event: {
        type: "tool_execution_start",
        data: { toolName: "read" },
      },
    },
    {
      event: {
        type: "message_update",
        text: "Done.\n",
      },
    },
  ];
}

async function wait(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
