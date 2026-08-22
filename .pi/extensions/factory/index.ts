import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFactoryPiExtension } from "../../../packages/adapters/pi/src/index.ts";

export default function factoryExtension(pi: ExtensionAPI): void {
  registerFactoryPiExtension(pi);
}
