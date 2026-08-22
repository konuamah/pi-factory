import type { PiSessionFactory } from "./types.js";

export function createUnimplementedPiSessionFactory(): PiSessionFactory {
  return {
    async create() {
      throw new Error(
        "Pi session factory not wired. Inject a Pi SDK-backed sessionFactory into PiAgentExecutor.",
      );
    },
  };
}
