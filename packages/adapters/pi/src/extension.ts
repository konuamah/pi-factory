import type { FactoryPiExtensionApiLike } from "./types.js";
import { getFactoryCommandCompletions, handleFactoryCommand } from "./gateway.js";

export function registerFactoryPiExtension(pi: FactoryPiExtensionApiLike): void {
  pi.registerCommand("factory", {
    description: "Run Factory setup and status commands",
    getArgumentCompletions: (prefix) => getFactoryCommandCompletions(prefix),
    handler: async (args, ctx) => {
      await handleFactoryCommand(args, ctx);
    },
  });
}
