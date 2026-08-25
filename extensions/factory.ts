import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFactoryPiExtension } from "@factory/adapter-pi";

export default function factoryExtension(pi: ExtensionAPI): void {
  registerFactoryPiExtension(pi);
}
