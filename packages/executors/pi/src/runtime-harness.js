import { runRuntimeHarness } from "@factory/core";
import { PiAgentExecutor } from "./executor.js";
import { createFakePiSessionFactory } from "./fake-session-factory.js";
import { createPiSdkSessionFactory } from "./sdk-factory.js";
export async function runPiRuntimeHarness() {
    const useRealSdk = process.env.FACTORY_PI_USE_REAL_SDK === "1";
    const sessionFactory = useRealSdk
        ? createPiSdkSessionFactory({
            packageName: process.env.FACTORY_PI_SDK_PACKAGE,
        })
        : createFakePiSessionFactory();
    const plannerExecutor = new PiAgentExecutor({
        sessionFactory,
        onEvent: (executionId, event) => {
            if (event.text) {
                process.stdout.write(`[planner ${executionId}] ${event.text}`);
            }
        },
    });
    const repairExecutor = new PiAgentExecutor({
        sessionFactory,
        onEvent: (executionId, event) => {
            if (event.text) {
                process.stdout.write(`[repair ${executionId}] ${event.text}`);
            }
        },
    });
    const reviewerExecutor = new PiAgentExecutor({
        sessionFactory,
        onEvent: (executionId, event) => {
            if (event.text) {
                process.stdout.write(`[reviewer ${executionId}] ${event.text}`);
            }
        },
    });
    const goal = process.env.FACTORY_PI_RUNTIME_GOAL ?? "Create a prototype implementation plan";
    const forceVerificationFailure = process.env.FACTORY_PI_FORCE_VERIFY_FAIL === "1";
    if (forceVerificationFailure) {
        process.stdout.write("forcing verification failure via FACTORY_PI_FORCE_VERIFY_FAIL=1\n");
    }
    const result = await runRuntimeHarness({
        cwd: process.cwd(),
        goal,
        plannerExecutor,
        repairExecutor,
        reviewerExecutor,
        requestApproval: async ({ runId, goal: approvalGoal }) => {
            process.stdout.write(`\napproval auto-approved for ${runId}: ${approvalGoal}\n`);
            return true;
        },
    });
    process.stdout.write(`mode=${useRealSdk ? "real-sdk" : "fake"}\n`);
    process.stdout.write(`runId=${result.runId}\n`);
    process.stdout.write(`plannerExecutionPath=${result.plannerExecutionPath ?? "none"}\n`);
    process.stdout.write(`verificationPath=${result.verificationPath}\n`);
    process.stdout.write(`summaryPath=${result.summaryPath}\n`);
}
const entryArg = process.argv[1];
if (entryArg) {
    const { pathToFileURL } = await import("node:url");
    if (import.meta.url === pathToFileURL(entryArg).href) {
        void runPiRuntimeHarness();
    }
}
