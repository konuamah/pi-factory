import type { RunFactoryControllerInput, RunFactoryControllerResult } from "./controller.js";
import { runFactoryController } from "./controller.js";

export interface PrototypeFactoryRunInput extends RunFactoryControllerInput {}
export interface PrototypeFactoryRunResult extends RunFactoryControllerResult {}

export async function runPrototypeFactoryFlow(
  input: PrototypeFactoryRunInput,
): Promise<PrototypeFactoryRunResult> {
  return runFactoryController(input);
}
