import type { AgentExecutionInput, AgentExecutionResult, AgentExecutor } from "@factory/core";
import type { PiExecutorOptions } from "./types.js";
export declare class PiAgentExecutor implements AgentExecutor {
    private readonly options;
    private readonly activeSessions;
    constructor(options: PiExecutorOptions);
    execute(input: AgentExecutionInput): Promise<AgentExecutionResult>;
    cancel(executionId: string): Promise<void>;
    private captureEvent;
}
//# sourceMappingURL=executor.d.ts.map