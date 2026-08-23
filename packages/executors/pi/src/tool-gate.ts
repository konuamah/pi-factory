import type { SkillContract } from "@factory/schemas";
import { buildResourcePolicyForContext, checkToolCall, type ToolCallContext, type ToolCallDecision, type ToolResourcePolicy } from "@factory/core";

export interface GatedTool {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  prepareArguments?: (args: unknown) => unknown;
  executionMode?: string;
  execute: (args: unknown) => Promise<unknown>;
}

export interface ToolGateOptions {
  context: ToolCallContext;
  skills?: SkillContract[];
  projectPolicy?: ToolCallContext["projectPolicy"];
  workflowPolicy?: ToolCallContext["workflowPolicy"];
  nodePolicy?: ToolCallContext["nodePolicy"];
  onApprovalRequired?: (input: {
    executionId: string;
    capability: string;
    toolName: string;
    args: unknown;
  }) => Promise<boolean> | boolean;
  onDecision?: (decision: ToolCallDecision, toolName: string) => void;
  resourcePolicy?: ToolResourcePolicy;
}

export function wrapToolsWithGate(tools: GatedTool[], options: ToolGateOptions): GatedTool[] {
  const resourcePolicy = options.resourcePolicy ?? buildResourcePolicyForContext(options.context);

  return tools.map((tool) => {
    const originalExecute = tool.execute;
    return {
      ...tool,
      execute: async (args: unknown) => {
        const decision = checkToolCall({
          toolName: tool.name,
          args: (args ?? {}) as Record<string, unknown>,
          context: options.context,
        }, resourcePolicy);

        options.onDecision?.(decision, tool.name);

        if (decision.action === "deny") {
          return structuredDenial(tool.name, decision);
        }

        if (decision.action === "require-approval") {
          const approved = await requestApproval(options, decision);
          if (!approved) {
            return structuredDenial(tool.name, {
              action: "deny",
              rule: "approval-denied",
              reason: `Tool '${tool.name}' requires approval for capability '${decision.capability}' which was not granted.`,
            });
          }
          options.context.approvedCapabilities?.add(decision.capability);
        }

        return originalExecute(args);
      },
    };
  });
}

async function requestApproval(options: ToolGateOptions, decision: Extract<ToolCallDecision, { action: "require-approval" }>): Promise<boolean> {
  if (!options.onApprovalRequired) {
    // Fail closed: no approval mechanism available.
    return false;
  }
  return Boolean(await options.onApprovalRequired({
    executionId: options.context.executionId,
    capability: decision.capability,
    toolName: decision.toolName,
    args: decision.args,
  }));
}

function structuredDenial(toolName: string, decision: Extract<ToolCallDecision, { action: "deny" }>): unknown {
  return {
    __factory_blocked: true,
    tool: toolName,
    capability: decision.capability,
    rule: decision.rule,
    message: decision.reason,
  };
}
