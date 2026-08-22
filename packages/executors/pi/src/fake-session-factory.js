export function createFakePiSessionFactory(options = {}) {
    return {
        async create(input) {
            return {
                session: new FakePiSession(input, options),
            };
        },
    };
}
class FakePiSession {
    input;
    options;
    listeners = new Set();
    aborted = false;
    constructor(input, options) {
        this.input = input;
        this.options = options;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    async prompt(text) {
        this.emit({
            type: "agent_start",
            data: {
                cwd: this.input.cwd,
                prompt: text,
            },
        });
        const script = this.options.script ??
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
    async abort() {
        this.aborted = true;
        this.emit({
            type: "agent_aborted",
            data: {
                cwd: this.input.cwd,
            },
        });
    }
    emit(event) {
        for (const listener of this.listeners) {
            listener(event);
        }
    }
}
function defaultScript(prompt) {
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
async function wait(delayMs) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
}
