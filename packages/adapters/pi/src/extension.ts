import type { FactoryPiExtensionApiLike } from "./types.js";
import { handleFactoryCommand } from "./gateway.js";

export function registerFactoryPiExtension(pi: FactoryPiExtensionApiLike): void {
  pi.registerCommand("factory", {
    description: "Run Factory setup and status commands",
    handler: async (args, ctx) => {
      await handleFactoryCommand(args, ctx);
    },
  });
}
