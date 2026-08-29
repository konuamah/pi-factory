// Helper functions for the run controller — extracted from controller-run.ts
// so the phase machine stays focused on orchestration.

import { appendFactoryRunEvent, updateFactoryRunState } from "../runs/store.js";
import { appendRepoLearning } from "../learnings/store.js";
import { resolveModelForRole } from "../models/index.js";
import { gatherVerificationRequirements, initializeVerificationProviders, runVerificationEngine } from "../verification/index.js";
import { runVerificationCommands, type VerificationPlan, type VerificationRunResult } from "./verification.js";
import { classifyVerificationFailure, type VerificationFailureClassification } from "./failure-classification.js";
import { classifyVerificationFailuresWithAI, type ClassificationSource } from "./ai-failure-classifier.js";
import { buildRepairPrompt, buildEnvironmentPrepPrompt, renderSkillBundleForPrompt } from "./prompts.js";
import { gitChangedFiles } from "./verification-planning.js";
import { uniqueStrings } from "./task-utils.js";
import { writePrototypeRepairExecutionArtifact, writePrototypeVerificationArtifact, writePrototypeReviewerExecutionArtifact } from "./artifacts.js";
import { buildContractArtifact, failureSignature } from "./verification-planning.js";
import { emitProgress, requestHumanDecision } from "./phase-plumbing.js";
import { movePhase } from "./phase-plumbing.js";
import { wait } from "./phase-plumbing.js";
import { resolveFactorySkills } from "../skills/index.js";
import { applyWorkflowSkillPolicy } from "./skills.js";
import { slugifyGoal } from "./skills.js";
import { appendModelLedgerEntry } from "../runs/model-ledger.js";
import type { RunFactoryControllerInput, RunFactoryControllerResult, InterviewDecisionRecord } from "./controller.js";
import type { AgentExecutor } from "./interfaces.js";
import type { EffectiveFactoryConfig, ModelSelection, WorkflowStage } from "@factory/schemas";
import type { VerificationContractPlan, VerificationEngineResult } from "../verification/index.js";
import type { ReviewProviderOptions } from "../verification/providers/review.js";
import type { SkillBundleSelection } from "../skills/index.js";
import type { TaskTypeSelection } from "../models/index.js";
import { createFactoryRun } from "../runs/store.js";
import path from "node:path";
import fs from "node:fs/promises";
import type { ModelRole } from "@factory/schemas";
import type { DiscoveryEvidencePacket } from "./discovery-validate.js";

export interface VerificationRepairLoopContext {
  run: Awaited<ReturnType<typeof createFactoryRun>>;
  input: RunFactoryControllerInput;
  repairConfig: EffectiveFactoryConfig["repair"];
  repairModel: ModelSelection | undefined;
  repairGuidanceText: string;
  repairSkillsBundleText: string | undefined;
  verificationPlan: VerificationPlan;
  contractPlan: VerificationContractPlan;
  implementationChangedFiles: string[];
  executionCwd: string;
  verification: VerificationRunResult;
  verificationFailureClassification: VerificationFailureClassification | undefined;
  verificationPath: string;
  contractResult: VerificationEngineResult;
  repairExecutionPaths: string[];
}

export async function runVerificationRepairLoop(
  context: VerificationRepairLoopContext,
): Promise<Pick<VerificationRepairLoopContext, "verification" | "verificationFailureClassification" | "verificationPath" | "contractResult" | "repairExecutionPaths">> {
  const {
    run,
    input,
    repairConfig,
    repairModel,
    repairGuidanceText,
    repairSkillsBundleText,
    verificationPlan,
    contractPlan,
    implementationChangedFiles,
    executionCwd,
  } = context;
  let {
    verification,
    verificationFailureClassification,
    verificationPath,
    contractResult,
    repairExecutionPaths,
  } = context;
  const repairExecutor = input.repairExecutor;

  // Signature-driven repair: keep going while the failure changes (progress), stop when
  // the same failure signature repeats maxAttempts times (stalled), capped absolutely.
  const absoluteCap = Math.max(repairConfig.maxAttempts, repairConfig.maxTotalAttempts ?? 10);
  let stallCount = 0;
  let lastSignature: string | null = null;
  let attempt = 0;
  while (attempt < absoluteCap) {
    attempt += 1;
    await emitProgress(input, {
      runId: run.runId,
      phase: "repair",
      status: "RUNNING",
      message: `Repair attempt ${attempt}`,
    });
    if (!repairExecutor) break;
    const repairResult = await repairExecutor.execute({
      executionId: `${run.runId}-repair-${attempt}`,
      cwd: verification.cwd,
      prompt: buildRepairPrompt(
        input.goal,
        verification,
        repairGuidanceText,
        repairSkillsBundleText,
        verificationFailureClassification?.suggestedGeneralFix ?? verificationFailureClassification?.rootCause,
      ),
      model: repairModel,
      tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
      metadata: {
        role: "repair",
        runId: run.runId,
        attempt,
      },
    });
    const repairExecutionPath = await writePrototypeRepairExecutionArtifact(run.runDir, {
      attempt,
      ...repairResult,
    });
    repairExecutionPaths.push(repairExecutionPath);
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "repair.attempt_completed",
      data: {
        attempt,
        repairExecutionPath,
        repairStatus: repairResult.status,
      },
    });

    const recheckVerification = await runVerificationCommands({
      cwd: verificationPlan.cwd,
      commands: verificationPlan.commands,
    });
    recheckVerification.cwdResolution = verificationPlan.cwdResolution;
    const changedAfterRepair = await gitChangedFiles(executionCwd);
    const recheckFailureClassification = classifyVerificationFailure({
      plan: verificationPlan,
      result: recheckVerification,
      changedFiles: uniqueStrings([...implementationChangedFiles, ...changedAfterRepair]),
    });
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "verification.recheck_completed",
      data: {
        attempt,
        overallStatus: recheckVerification.overallStatus,
        verificationPath,
      },
    });

    // Incremental contract re-verification: only re-run requirements affected by changed files.
    const recheckContractResult = await runVerificationEngine({
      cwd: verificationPlan.cwd,
      plan: contractPlan,
      affectedFiles: changedAfterRepair,
    });
    const recheckVerificationPath = await writePrototypeVerificationArtifact(run.runDir, {
      ...recheckVerification,
      selectionSource: verificationPlan.selectionSource,
      rationale: verificationPlan.rationale,
      skill: verificationPlan.skill,
      evidence: verificationPlan.evidence,
      failureClassification: recheckFailureClassification,
      contract: buildContractArtifact(contractPlan, recheckContractResult),
    });
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "verification.contract_recheck",
      data: {
        attempt,
        overallStatus: recheckContractResult.overallStatus,
        canComplete: recheckContractResult.canComplete,
        affectedFiles: changedAfterRepair,
      },
    });

    // Commit this attempt's state so the next iteration (and caller) sees it.
    verification = recheckVerification;
    verificationFailureClassification = recheckFailureClassification;
    verificationPath = recheckVerificationPath;
    contractResult = recheckContractResult;

    if (verification.overallStatus !== "failed") {
      break;
    }
    // Stalled detection: same failure signature repeated maxAttempts times.
    const signature = failureSignature(verification);
    if (signature === lastSignature) {
      stallCount += 1;
    } else {
      stallCount = 0;
    }
    lastSignature = signature;
    if (stallCount >= repairConfig.maxAttempts) {
      await appendFactoryRunEvent(run.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "repair.stalled",
        data: { attempt, stallCount, signature },
      });
      break;
    }
  }

  return {
    verification,
    verificationFailureClassification,
    verificationPath,
    contractResult,
    repairExecutionPaths,
  };
}

export interface EnvironmentPreparationContext {
  run: Awaited<ReturnType<typeof createFactoryRun>>;
  input: RunFactoryControllerInput;
  repairExecutor: AgentExecutor | undefined;
  repairModel: ModelSelection | undefined;
  repairEnabled: boolean;
  verificationPlan: VerificationPlan;
  implementationChangedFiles: string[];
  verification: VerificationRunResult;
  verificationFailureClassification: VerificationFailureClassification | undefined;
}

export async function attemptEnvironmentPreparation(
  context: EnvironmentPreparationContext,
): Promise<Pick<EnvironmentPreparationContext, "verification" | "verificationFailureClassification"> & { shouldAttemptEnvPrep: boolean }> {
  const {
    run,
    input,
    repairExecutor,
    repairModel,
    repairEnabled,
    verificationPlan,
    implementationChangedFiles,
  } = context;
  let {
    verification,
    verificationFailureClassification,
  } = context;

  const environmentFailures = verificationFailureClassification?.perCommand
    .filter((c) => c.suggestedAction === "prepare-environment") ?? [];
  const shouldAttemptEnvPrep = verification.overallStatus === "failed"
    && Boolean(repairExecutor)
    && repairEnabled
    && environmentFailures.length > 0;
  if (shouldAttemptEnvPrep && repairExecutor) {
    await emitProgress(input, {
      runId: run.runId,
      phase: "environment-preparation",
      status: "RUNNING",
      message: `Preparing environment for: ${environmentFailures.map((f) => f.commandName).join(", ")}`,
    });
    const envResult = await repairExecutor.execute({
      executionId: `${run.runId}-env-prep`,
      cwd: verification.cwd,
      prompt: buildEnvironmentPrepPrompt(verification.cwd, environmentFailures),
      model: repairModel,
      tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
      metadata: { role: "repair", purpose: "environment-preparation", runId: run.runId },
    });
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "environment.prep_completed",
      data: { status: envResult.status },
    });
    if (envResult.status === "completed") {
      verification = await runVerificationCommands({ cwd: verificationPlan.cwd, commands: verificationPlan.commands });
      verification.cwdResolution = verificationPlan.cwdResolution;
      const recheck = classifyVerificationFailure({ plan: verificationPlan, result: verification, changedFiles: implementationChangedFiles });
      verificationFailureClassification = recheck
        ? { ...recheck, classificationSource: "deterministic" as ClassificationSource }
        : undefined;
    }
  }

  return {
    verification,
    verificationFailureClassification,
    shouldAttemptEnvPrep,
  };
}

export interface RunFailureResultContext {
  run: Awaited<ReturnType<typeof createFactoryRun>>;
  executionCwd: string;
  worktree: RunFactoryControllerResult["worktree"];
  phases: string[];
  planPath: string;
  taskPaths: string[];
  discoveryExecutionPath?: string;
  plannerExecutionPath?: string;
  builderExecutionPaths: string[];
  integrationPath?: string;
  repairExecutionPaths: string[];
  reviewerExecutionPath?: string;
  verificationPath: string;
  summaryPath: string;
  candidateSha?: string;
  finalMergePath?: string;
}

export function buildRunFailureResult(context: RunFailureResultContext): RunFactoryControllerResult {
  return {
    runId: context.run.runId,
    runDir: context.run.runDir,
    executionCwd: context.executionCwd,
    worktree: context.worktree,
    statePath: context.run.statePath,
    eventsPath: context.run.eventsPath,
    phases: context.phases,
    approved: false,
    planPath: context.planPath,
    taskPaths: context.taskPaths,
    discoveryExecutionPath: context.discoveryExecutionPath,
    plannerExecutionPath: context.plannerExecutionPath,
    builderExecutionPaths: context.builderExecutionPaths,
    integrationPath: context.integrationPath,
    finalMergePath: context.finalMergePath,
    candidateSha: context.candidateSha,
    repairExecutionPaths: context.repairExecutionPaths,
    reviewerExecutionPath: context.reviewerExecutionPath,
    verificationPath: context.verificationPath,
    summaryPath: context.summaryPath,
  };
}

export async function failBuiltInSkillPolicy(input: {
  run: { runId: string; statePath: string; eventsPath: string };
  input: RunFactoryControllerInput;
  phase: string;
  stage: string;
  missingRequired: string[];
}): Promise<void> {
  await appendFactoryRunEvent(input.run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "task.skill_policy_failed",
    data: {
      stage: input.stage,
      missingRequiredSkills: input.missingRequired,
    },
  });
  await updateFactoryRunState({
    statePath: input.run.statePath,
    patch: { status: "FAILED", phase: input.phase },
  });
  await emitProgress(input.input, {
    runId: input.run.runId,
    phase: input.phase,
    status: "FAILED",
    message: `Missing required workflow skill(s): ${input.missingRequired.join(", ")}`,
  });
}

export async function runInterviewStages(input: {
  stages: WorkflowStage[];
  run: { runId: string; runDir: string; statePath: string; eventsPath: string };
  input: RunFactoryControllerInput;
  executionCwd: string;
  goal: string;
  config: EffectiveFactoryConfig;
  plannerGuidanceText?: string;
  plannerSkills: SkillBundleSelection;
  runTaskType: TaskTypeSelection;
  discoveryOutputText?: string;
}): Promise<{ text?: string; executionPath?: string; decisions?: InterviewDecisionRecord[] }> {
  const answers: string[] = [];
  let lastExecutionPath: string | undefined;
  const structuredDecisions: InterviewDecisionRecord[] = [];
  for (const stage of input.stages) {
    const role = stage.role ?? "planner";
    const executor = executorForRole(input.input, role);
    if (!executor) {
      throw new Error(`Interview stage '${stage.name}' requires a ${role} executor, but none is configured.`);
    }
    const skillPolicy = applyWorkflowSkillPolicy(input.plannerSkills, stage.skills);
    if (!skillPolicy.ok) {
      await failBuiltInSkillPolicy({
        run: input.run,
        input: input.input,
        phase: "interview-failed",
        stage: stage.name,
        missingRequired: skillPolicy.missingRequired,
      });
      throw new Error(`Interview failed: Missing required workflow skill(s): ${skillPolicy.missingRequired.join(", ")}`);
    }
    await movePhase(input.run.statePath, input.run.eventsPath, input.run.runId, input.input, "interview", `Interviewing before planning: ${stage.name}`);
    const model = resolveModelForRole({
      role,
      taskType: input.runTaskType.id,
      config: input.config,
      nodeModel: stage.model,
      runModelOverride: input.input.modelOverrides?.[role],
    });
    await appendModelLedgerEntry(input.run.runDir, {
      operationId: `${input.run.runId}-${role}-${stage.name}`,
      nodeId: stage.name,
      role,
      taskType: input.runTaskType.id,
      taskTypeSource: input.runTaskType.source,
      taskTypeConfidence: input.runTaskType.confidence,
      requestedModel: model.model.model,
      resolvedModel: model.model.model,
      provider: model.model.provider,
      modelSource: model.source,
    });
    const result = await executor.execute({
      executionId: `${input.run.runId}-${role}-${slugifyGoal(stage.name)}`,
      cwd: input.executionCwd,
      prompt: buildInterviewPrompt({
        goal: input.goal,
        stage,
        guidanceText: input.plannerGuidanceText,
        skillBundleText: renderSkillBundleForPrompt(skillPolicy.bundle),
        discoveryReport: input.discoveryOutputText,
      }),
      model: model.model,
      tools: ["read", "grep", "find", "ls"],
      metadata: {
        role,
        runId: input.run.runId,
        taskType: input.runTaskType.id,
        stage: stage.name,
      },
    });
    const artifactPath = path.join(input.run.runDir, `${slugifyGoal(stage.name)}-interview-execution.json`);
    await fs.writeFile(artifactPath, JSON.stringify(result, null, 2), "utf8");
    lastExecutionPath = artifactPath;
    await appendFactoryRunEvent(input.run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "interview.executor_completed",
      data: {
        stage: stage.name,
        role,
        interviewExecutionPath: artifactPath,
        interviewStatus: result.status,
      },
    });
    const output = result.outputText.trim();
    if (!output || /INTERVIEW_COMPLETE/i.test(output)) {
      continue;
    }
    const decision = await requestHumanDecision({
      controllerInput: input.input,
      runDir: input.run.runDir,
      statePath: input.run.statePath,
      eventsPath: input.run.eventsPath,
      runId: input.run.runId,
      request: {
        id: `${input.run.runId}-${slugifyGoal(stage.name)}-interview`,
        title: `Interview: ${stage.name}`,
        question: output,
        context: "Answer the interview questions. Factory will include your answer in the planner prompt before producing the implementation plan.",
        options: [
          {
            id: "answered",
            label: "Use my answer",
            description: "Continue to planning with the feedback/answer provided.",
          },
        ],
        source: "INTERVIEW",
        reason: "USER_PREFERENCE",
      },
    });
    answers.push([
      `Stage: ${stage.name}`,
      `Interview prompt/questions:\n${output}`,
      `Selected option: ${decision.optionId}`,
      decision.feedback ? `User answer:\n${decision.feedback}` : undefined,
    ].filter(Boolean).join("\n"));
    structuredDecisions.push({
      stage: stage.name,
      role,
      question: output,
      optionId: decision.optionId,
      answer: decision.feedback,
      decisionRequestId: decision.requestId,
    });
  }
  // Persist structured interview decisions for downstream stages.
  if (structuredDecisions.length > 0) {
    const artifactPath = path.join(input.run.runDir, "interview-decisions.json");
    await fs.writeFile(artifactPath, JSON.stringify(structuredDecisions, null, 2), "utf8");
    await appendFactoryRunEvent(input.run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "interview.decisions_written",
      data: { artifactPath, decisionCount: structuredDecisions.length },
    });
  }
  return { text: answers.length > 0 ? answers.join("\n\n") : undefined, executionPath: lastExecutionPath, decisions: structuredDecisions };
}

export function executorForRole(input: RunFactoryControllerInput, role: ModelRole): AgentExecutor | undefined {
  switch (role) {
    case "discovery":
      return input.discoveryExecutor ?? input.plannerExecutor;
    case "planner":
      return input.plannerExecutor;
    case "builder":
      return input.builderExecutor;
    case "reviewer":
      return input.reviewerExecutor;
    case "repair":
      return input.repairExecutor;
  }
}

export function buildInterviewPrompt(input: {
  goal: string;
  stage: WorkflowStage;
  guidanceText?: string;
  skillBundleText?: string;
  discoveryReport?: string;
}): string {
  return [
    "Role: Interview",
    "",
    "Your job is to ask the user the questions needed before Factory plans implementation.",
    "Do not implement code. Do not write the implementation plan.",
    "If no user interview is needed, return exactly: INTERVIEW_COMPLETE",
    "",
    `Task: ${input.goal}`,
    `Interview stage: ${input.stage.name}`,
    input.stage.description ? `Stage description: ${input.stage.description}` : undefined,
    input.skillBundleText ? `Selected skills:\n${input.skillBundleText}` : undefined,
    input.guidanceText ? `Project guidance context:\n${input.guidanceText}` : undefined,
    input.discoveryReport ? `Validated Discovery result:\n${input.discoveryReport}` : undefined,
    "",
    "Ask concise, answerable questions. Prefer one round of high-impact questions.",
    "The user answer will be recorded and passed into the planner.",
  ].filter(Boolean).join("\n");
}

export function buildDiscoveryPrompt(
  goal: string,
  constitutionContext?: string,
  skillBundleText?: string,
  evidencePacket?: DiscoveryEvidencePacket,
): string {
  return [
    "Role: Discovery",
    "",
    "Your job is to identify the concrete repository files/components/data/config surfaces needed for a separate Planning phase.",
    "You are in Discovery only. Use the repository evidence packet as authoritative filesystem truth.",
    "",
    "Do not:",
    "- implement anything",
    "- modify files",
    "- write code",
    "- create an implementation plan",
    "- recommend a solution prematurely",
    "- return likely candidates, possible sources, or searches for Builder to run",
    "- invent file paths",
    "- mark a finding confirmed unless it is supported by the evidence packet",
    "- stop after a preamble",
    "",
    "Objective:",
    "- Find the concrete files involved.",
    "- Return evidence from those files.",
    "- Capture only unknowns that remain after read-only inspection.",
    "- Prefer files from candidate_files. You may list another file only if it appears in observed_files.",
    "",
    `User task: ${goal}`,
    skillBundleText ? `Selected skills:\n${skillBundleText}` : undefined,
    constitutionContext ? `Project guidance context:\n${constitutionContext}` : undefined,
    evidencePacket ? `Repository evidence packet (authoritative):\n${renderDiscoveryEvidencePacket(evidencePacket)}` : undefined,
    "",
    "Return JSON only, with this exact shape:",
    "{",
    "  \"status\": \"complete\",",
    "  \"files\": [\"src/path/to/file.ts\"],",
    "  \"evidence\": [",
    "    { \"status\": \"confirmed\", \"file\": \"src/path/to/file.ts\", \"finding\": \"What this file proves\" }",
    "  ],",
    "  \"unknowns\": []",
    "}",
    "",
    "A concrete file is a real file path like src/data/courses.ts, src/components/UpcomingCourses.tsx, package.json, factory.yaml, or .factory/config.yaml.",
    "A directory such as src/, components/, frontend/, backend/, or course files is not a concrete file.",
    "Evidence must include at least one confirmed item tied to a concrete file.",
    "Every file in files[] must appear in observed_files from the repository evidence packet.",
    "Every confirmed evidence file must appear in observed_files from the repository evidence packet.",
    "",
    "If you cannot identify a concrete implementation surface after using the available read-only tools, return exactly:",
    "DISCOVERY_FAILED: Could not identify the implementation surface.",
  ].filter(Boolean).join("\n");
}

export function renderDiscoveryEvidencePacket(packet: DiscoveryEvidencePacket): string {
  const observedForPrompt = packet.observedFiles.slice(0, 700);
  return [
    `root: ${packet.root}`,
    `terms: ${packet.terms.join(", ") || "none"}`,
    `observed_file_count: ${packet.observedFiles.length}`,
    packet.truncated ? "observed_files_truncated: true" : "observed_files_truncated: false",
    "candidate_files:",
    ...(packet.candidateFiles.length > 0 ? packet.candidateFiles.map((file) => `- ${file}`) : ["- none"]),
    "matching_snippets:",
    ...(packet.snippets.length > 0
      ? packet.snippets.map((snippet) => `- ${snippet.file}:${snippet.line} [${snippet.matched}] ${snippet.text}`)
      : ["- none"]),
    "observed_files:",
    ...observedForPrompt.map((file) => `- ${file}`),
    packet.observedFiles.length > observedForPrompt.length
      ? `- ... ${packet.observedFiles.length - observedForPrompt.length} more observed files omitted from prompt`
      : undefined,
  ].filter(Boolean).join("\n");
}

export function buildPlannerPrompt(
  goal: string,
  config: { git: { baseBranch: string }; approval: { finalMerge: string }; repair: { maxAttempts: number } },
  constitutionContext?: string,
  skillBundleText?: string,
  discoveryReport?: string,
  interviewContext?: string,
): string {
  return [
    "You are an expert Principal Software Architect and Lead Project Planner.",
    "Your job is to turn the validated Discovery result and project guidance into a clear execution contract for the Builder.",
    `Task: ${goal}`,
    "Do not write implementation code.",
    "Do not perform broad repository discovery here; Discovery already gathered the evidence.",
    "Produce a concrete, repository-grounded implementation plan and then stop.",
    "",
    `Base branch: ${config.git.baseBranch}`,
    `Approval policy: ${config.approval.finalMerge}`,
    `Repair attempts: ${config.repair.maxAttempts}`,
    skillBundleText ? `Selected skills:\n${skillBundleText}` : undefined,
    constitutionContext ? `Project guidance context:\n${constitutionContext}` : undefined,
    discoveryReport ? `Validated Discovery result (authoritative pre-planning evidence):\n${discoveryReport}` : undefined,
    interviewContext ? `Interview answers and decisions:\n${interviewContext}` : undefined,
    "",
    "Discovery has already inspected the repository.",
    "Use the supplied Discovery evidence as your repository context.",
    "Do not ask Builder to find, locate, search for, or identify implementation files.",
    "Create the implementation sequence using the concrete files already identified.",
    "A narrow inspection of an identified file is allowed when needed before editing.",
    "",
    "Produce the plan with exactly these sections:",
    "",
    "1. PLANNING DECISIONS",
    "- Restate the outcome in one sentence.",
    "- Name the confirmed files, components, data sources, commands, or config surfaces the Builder should use.",
    "- State the chosen approach and why it fits the existing system.",
    "- Call out any non-negotiable constraints from the user, config, or project guidance.",
    "",
    "2. IMPLEMENTATION SEQUENCE",
    "- Break the work into small, sequential, and testable steps labeled Step 1, Step 2, etc.",
    "- Ensure each step builds logically on the previous one.",
    "- For each step, say exactly what kind of file/component/config change the Builder should make.",
    "- Do not make the first step a broad search, location, or file-identification step.",
    "- A narrow read/inspection step is allowed only for concrete files named by Discovery.",
    "",
    "3. VERIFICATION CONTRACT",
    "- List the exact checks, commands, or manual assertions that should prove the change works.",
    "- Tie each check to the risk or requirement it covers.",
    "- If a configured command is not appropriate, explain why and choose the weakest valid verification that still gives useful signal.",
    "",
    "4. RISKS AND BLOCKERS",
    "- List concrete risks, such as stale content, bad selectors, broken links, unavailable models, invalid commands, dependency issues, or verification gaps.",
    "- Provide a mitigation or fallback for each risk.",
    "- Mark user decisions as blockers only when Builder cannot safely proceed without them.",
    "",
    "Constraints:",
    "- Be specific. Avoid vague phrases like 'likely touchpoints' when Discovery provided concrete evidence.",
    "- For content/UI tasks, name the discovered files/components/data sources that should change.",
    "- Do not claim a file, route, dependency, command, or framework exists unless it is supported by the Discovery result or project guidance context.",
    "- Do not delegate broad discovery to Builder with phrases like 'search for', 'find where', 'locate the', or 'identify the relevant file'.",
    "- Do not broaden scope beyond the requested outcome.",
    "- Do not propose unrelated documentation rewrites or adjacent cleanup unless clearly required.",
    "- Do not repeat the prompt, Discovery Report, or project guidance context.",
    "- Keep the plan concise but operational: the Builder should know where to start, what to change, and how to verify.",
    "- End with exactly: WAITING_FOR_APPROVAL",
  ].filter(Boolean).join("\n");
}


