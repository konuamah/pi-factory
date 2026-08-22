export class PiAgentExecutor {
    options;
    activeSessions = new Map();
    constructor(options) {
        this.options = options;
    }
    async execute(input) {
        const created = await this.options.sessionFactory.create({
            cwd: input.cwd,
            prompt: input.prompt,
            model: input.model,
            tools: input.tools,
            metadata: input.metadata,
        });
        const state = {
            executionId: input.executionId,
            events: [],
            outputChunks: [],
        };
        this.activeSessions.set(input.executionId, created.session);
        const unsubscribe = created.session.subscribe((event) => {
            this.captureEvent(state, event);
            void this.options.onEvent?.(input.executionId, event);
        });
        try {
            await created.session.prompt(input.prompt);
            return {
                executionId: input.executionId,
                status: "completed",
                outputText: state.outputChunks.join(""),
                events: state.events,
            };
        }
        catch (error) {
            return {
                executionId: input.executionId,
                status: isAbortError(error) ? "cancelled" : "failed",
                outputText: state.outputChunks.join(""),
                events: state.events,
                errorMessage: error instanceof Error ? error.message : String(error),
            };
        }
        finally {
            unsubscribe();
            this.activeSessions.delete(input.executionId);
        }
    }
    async cancel(executionId) {
        await this.activeSessions.get(executionId)?.abort();
    }
    captureEvent(state, event) {
        state.events.push({
            type: event.type,
            data: event.data,
        });
        if (event.text) {
            state.outputChunks.push(event.text);
        }
    }
}
function isAbortError(error) {
    return error instanceof Error && /abort|cancel/i.test(error.message);
}
