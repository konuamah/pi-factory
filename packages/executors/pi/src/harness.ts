import { pathToFileURL } from "node:url";
import { PiAgentExecutor } from "./executor.js";
import { createFakePiSessionFactory } from "./fake-session-factory.js";

export async function runPiExecutorHarness(): Promise<void> {
  const executor = new PiAgentExecutor({
    sessionFactory: createFakePiSessionFactory(),
    onEvent: (executionId, event) => {
      if (event.text) {
        process.stdout.write(`[${executionId}] ${event.text}`);
      }
    },
  });

  const result = await executor.execute({
    executionId: "demo-exec-1",
    cwd: process.cwd(),
    prompt: "Create a plan for the prototype",
    tools: ["read", "write"],
    model: { model: "demo-model" },
  });

  process.stdout.write(`\nstatus=${result.status}\n`);
  process.stdout.write(`events=${result.events.length}\n`);
  process.stdout.write(`output=${JSON.stringify(result.outputText)}\n`);
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  void runPiExecutorHarness();
}
