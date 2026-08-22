export function createPiSdkSessionFactory(options = {}) {
    const packageName = options.packageName ?? "@earendil-works/pi-coding-agent";
    return {
        async create(input) {
            const sdk = await loadPiSdk(packageName);
            const sessionManager = sdk.SessionManager.inMemory(input.cwd);
            const createOptions = {
                cwd: input.cwd,
                sessionManager,
            };
            if (input.tools && input.tools.length > 0) {
                createOptions.tools = input.tools;
            }
            if (input.model) {
                const modelRuntime = await sdk.ModelRuntime.create();
                createOptions.modelRuntime = modelRuntime;
                const resolvedModel = typeof modelRuntime.getModel === "function" && input.model.provider
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
function wrapPiSdkSession(session) {
    return {
        prompt(text) {
            return session.prompt(text);
        },
        subscribe(listener) {
            return session.subscribe((event) => {
                listener(mapPiSdkEvent(event));
            });
        },
        abort() {
            return session.abort();
        },
    };
}
function mapPiSdkEvent(event) {
    const type = typeof event.type === "string" ? event.type : "unknown";
    const text = extractEventText(event);
    return {
        type,
        text,
        data: event,
    };
}
function extractEventText(event) {
    if (typeof event.text === "string") {
        return event.text;
    }
    if (event.type === "message_update") {
        const assistantMessageEvent = asRecord(event.assistantMessageEvent);
        if (assistantMessageEvent &&
            assistantMessageEvent.type === "text_delta" &&
            typeof assistantMessageEvent.delta === "string") {
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
function asRecord(value) {
    return value && typeof value === "object" ? value : undefined;
}
async function loadPiSdk(packageName) {
    const importer = new Function("specifier", "return import(specifier);");
    try {
        const loaded = await importer(packageName);
        return loaded;
    }
    catch (error) {
        throw new Error(`Failed to load Pi SDK package \"${packageName}\". Install it before using createPiSdkSessionFactory().`, { cause: error });
    }
}
