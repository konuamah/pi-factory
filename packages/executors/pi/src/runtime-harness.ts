import { runRuntimeHarness, type RunFactoryControllerInput } from "@factory/core";
import { PiAgentExecutor } from "./executor.js";
import { createFakePiSessionFactory } from "./fake-session-factory.js";
import { createPiSdkSessionFactory } from "./sdk-factory.js";
import { createScriptedDecisionHandler, loadScriptedDecisionAnswers } from "./headless.js";
import fs from "node:fs/promises";
import path from "node:path";

export async function runPiRuntimeHarness(): Promise<void> {
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
  const builderExecutor = new PiAgentExecutor({
    sessionFactory,
    onEvent: (executionId, event) => {
      if (event.text) {
        process.stdout.write(`[builder ${executionId}] ${event.text}`);
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
  const verificationPlannerExecutor = new PiAgentExecutor({
    sessionFactory,
    onEvent: (executionId, event) => {
      if (event.text) {
        process.stdout.write(`[verification-planner ${executionId}] ${event.text}`);
      }
    },
  });

  const goal = process.env.FACTORY_PI_RUNTIME_GOAL ?? "Create a prototype implementation plan";
  const cwd = process.env.FACTORY_PI_RUNTIME_CWD ?? process.cwd();
  const roleModel = process.env.FACTORY_PI_MODEL?.trim();
  let judgeModel: { provider?: string; model: string } | undefined;
  if (roleModel) {
    const separator = roleModel.indexOf("/");
    if (separator <= 0) {
      throw new Error(`FACTORY_PI_MODEL must be "provider/model", got "${roleModel}".`);
    }
    judgeModel = { provider: roleModel.slice(0, separator), model: roleModel.slice(separator + 1) };
    await writeRoleModelsConfig(cwd, roleModel.slice(0, separator), roleModel.slice(separator + 1));
  }
  // A repo whose .factory/config.yaml declares no role models otherwise falls
  // back to built-in defaults that carry no provider, which the SDK factory
  // rejects (observed live: verification read config.models.planner directly
  // and got the provider-less default "opus"). writeRoleModelsConfig above
  // makes every role resolve through the normal config path.
  let modelOverrides: RunFactoryControllerInput["modelOverrides"] | undefined;
  const decisionsFile = process.env.FACTORY_PI_DECISIONS_FILE;
  const requestDecision = decisionsFile
    ? createScriptedDecisionHandler(await loadScriptedDecisionAnswers(decisionsFile))
    : undefined;
  if (!requestDecision) {
    process.stdout.write("no interview answers file set (FACTORY_PI_DECISIONS_FILE); interview stages will fail\n");
  }
  const forceVerificationFailure = process.env.FACTORY_PI_FORCE_VERIFY_FAIL === "1";
  if (forceVerificationFailure) {
    process.stdout.write("forcing verification failure via FACTORY_PI_FORCE_VERIFY_FAIL=1\n");
  }

  const result = await runRuntimeHarness({
    cwd,
    goal,
    modelOverrides,
    plannerExecutor,
    builderExecutor,
    repairExecutor,
    reviewerExecutor,
    verificationPlannerExecutor,
    requestDecision,
    requestPlanApproval: async ({ runId, goal: approvalGoal, planPath, taskCount, workflowStages }) => {
      process.stdout.write(`\nplan auto-approved for ${runId}: ${approvalGoal} | tasks=${taskCount} | stages=${workflowStages.join('->')} | plan=${planPath}\n`);
      return { decision: 'approve' };
    },
    requestAcceptance: async ({ runId, goal: acceptanceGoal }) => {
      process.stdout.write(`\nfinal acceptance auto-accepted for ${runId}: ${acceptanceGoal}\n`);
      return { decision: 'accept' };
    },
  });

  process.stdout.write(`mode=${useRealSdk ? "real-sdk" : "fake"}\n`);
  process.stdout.write(`runId=${result.runId}\n`);
  process.stdout.write(`plannerExecutionPath=${result.plannerExecutionPath ?? "none"}\n`);
  process.stdout.write(`builderExecutionPaths=${result.builderExecutionPaths?.join(",") ?? "none"}\n`);
  process.stdout.write(`integrationPath=${result.integrationPath ?? "none"}\n`);
  process.stdout.write(`finalMergePath=${result.finalMergePath ?? "none"}\n`);
  process.stdout.write(`candidateSha=${result.candidateSha ?? "none"}\n`);
  process.stdout.write(`verificationPath=${result.verificationPath}\n`);
  process.stdout.write(`summaryPath=${result.summaryPath}\n`);

  // Optional LLM judge: score the finished run's artifacts with the same
  // executor + model, and write the verdict next to the run dir.
  if (process.env.FACTORY_PI_JUDGE === "1" && result.summaryPath) {
    await judgeFinishedRun({ runDir: path.dirname(result.summaryPath), executor: plannerExecutor, model: judgeModel });
  }
}

const entryArg = process.argv[1];
if (entryArg) {
  const { pathToFileURL } = await import("node:url");
  if (import.meta.url === pathToFileURL(entryArg).href) {
    void runPiRuntimeHarness();
  }
}

// Verification and other phases read role models straight off the effective
// config (verification-phase2 uses config.models.planner), bypassing the
// controller's modelOverrides. To make a headless run deterministic across
// every role, write the provider/model into .factory/config.yaml before the
// controller loads it.
export async function writeRoleModelsConfig(cwd: string, provider: string, model: string): Promise<void> {
  const configPath = path.join(cwd, ".factory", "config.yaml");
  let text = "";
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
  }
  const roleNames = ["discovery", "planner", "builder", "reviewer", "repair", "landing"];
  const block = ["models:", ...roleNames.map((role) => `  ${role}:\n    provider: ${provider}\n    model: ${model}`)].join("\n");
  // Replace any existing top-level `models:` section so the injected models
  // win; otherwise a stale block could override this run's intent.
  const stripped = text.replace(/^models:\n(?:[ \t]+.*\n?)*/m, "");
  const merged = (stripped.trimEnd() ? stripped.trimEnd() + "\n\n" : "") + block + "\n";
  await fs.writeFile(configPath, merged, "utf8");
}

/**
 * Score a finished run with the LLM judge and persist the verdict next to the
 * run dir as judge.json. No-op when the judge returns undefined (no executor
 * or unparseable output) — the deterministic score always stands.
 */
async function judgeFinishedRun(input: {
  runDir: string;
  executor: import("@factory/core").AgentExecutor;
  model?: { provider?: string; model: string };
}): Promise<void> {
  const { scoreFactoryRun, readRunArtifacts } = await import("@factory/core");
  try {
    const artifacts = await readRunArtifacts(input.runDir);
    const spec = {
      id: process.env.FACTORY_PI_TASK_ID ?? "benchmark",
      goal: process.env.FACTORY_PI_RUNTIME_GOAL ?? "",
      interviewRequired: true,
    };
    const report = await scoreFactoryRun(input.runDir, spec, {
      trialKind: "agent",
      judge: {
        executor: input.executor,
        model: input.model,
        rubric: process.env.FACTORY_PI_JUDGE_RUBRIC ?? "judge whether the interview was insightful and the build matched the decisions",
      },
    });
    const judgePath = path.join(input.runDir, "judge.json");
    await fs.writeFile(judgePath, JSON.stringify({ scores: report.scores, judge: report.judge ?? null }, null, 2), "utf8");
    process.stdout.write(`judge=${report.judge ? "scored" : "unavailable (deterministic stands)"}\n`);
    process.stdout.write(`judgePath=${judgePath}\n`);
  } catch (error) {
    process.stdout.write(`judge=error (${error instanceof Error ? error.message : String(error)})\n`);
  }
}
