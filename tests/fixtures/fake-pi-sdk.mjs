export const SessionManager = {
  inMemory(cwd) {
    return { cwd };
  },
};

export const ModelRuntime = {
  async create() {
    return {
      getModel(provider, model) {
        return { provider, model };
      },
    };
  },
};

export async function createAgentSession() {
  const listeners = new Set();
  const session = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(text) {
      for (const listener of listeners) {
        listener({ type: 'message_update', text: `sdk:${text}\n` });
      }
    },
    async abort() {},
    async dispose() {},
  };

  return { session };
}
