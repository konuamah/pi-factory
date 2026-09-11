// Interview + prompt builders — extracted from controller-helpers.ts.

import { appendFactoryRunEvent, updateFactoryRunState } from "../runs/store.js";
import { appendModelLedgerEntry } from "../runs/model-ledger.js";
import { movePhase, requestHumanDecision } from "./phase-plumbing.js";
import { resolveModelForRole } from "../models/index.js";
import { resolveFactorySkills } from "../skills/index.js";
import { applyWorkflowSkillPolicy } from "./skills.js";
import { failBuiltInSkillPolicy } from "./controller-helpers.js";
import { slugifyGoal } from "./skills.js";
import { renderSkillBundleForPrompt } from "./prompts.js";
import { taskObjectiveForPrompt } from "../runs/title.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { RunFactoryControllerInput, FactoryRunProgressEvent, TaskWorkspaceSelection, InterviewDecisionRecord } from "./controller.js";
import type { AgentExecutor } from "./interfaces.js";
import type { ModelRole, ModelSelection, WorkflowStage, EffectiveFactoryConfig } from "@factory/schemas";
import type { SkillBundleSelection, SkillCandidate } from "../skills/index.js";
import type { DiscoveryEvidencePacket } from "./discovery-validate.js";
import type { TaskTypeSelection } from "../models/index.js";
export { normalizeInterviewOutput } from "./interview-output.js";

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
  executionPhase: "pre-planning" | "post-verification";
  verificationContext?: { verificationStatus: string; changedFiles: string[]; planSummary?: string };
}): Promise<{ text?: string; executionPath?: string; decisions?: InterviewDecisionRecord[]; executionPhase: "pre-planning" | "post-verification" }> {
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
    await movePhase(input.run.statePath, input.run.eventsPath, input.run.runId, input.input, "interview", `${input.executionPhase === "post-verification" ? "Interviewing verified candidate" : "Interviewing before planning"}: ${stage.name}`);
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
        executionPhase: input.executionPhase,
        verificationContext: input.verificationContext,
      }),
      model: model.model,
      tools: ["read", "grep", "find", "ls"],
      limits: input.config.runtime.limits,
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
    // Do not let a completion marker embedded in a question/recommendation
    // bypass the human decision gate.
    if (!output || output === "INTERVIEW_COMPLETE") {
      continue;
    }
    const interviewOutput = normalizeInterviewOutput(output);
    if (!interviewOutput) {
      await appendFactoryRunEvent(input.run.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "interview.output_rejected",
        data: { stage: stage.name, reason: "Model output did not contain a concrete interview round." },
      });
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
        question: interviewOutput,
        context: input.executionPhase === "post-verification"
          ? "Answer the interview questions about the verified candidate. Factory will include your answer in the reviewer and approval prompts; it will NOT be fed back into planning or building."
          : "Answer the interview questions. Factory will include your answer in the planner prompt before producing the implementation plan.",
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
      `Interview prompt/questions:\n${interviewOutput}`,
      `Selected option: ${decision.optionId}`,
      decision.feedback ? `User answer:\n${decision.feedback}` : "User answer:\n[skipped]",
    ].filter(Boolean).join("\n"));
    const skipped = interviewDecisionSkipped(decision);
    structuredDecisions.push({
      stage: stage.name,
      role,
      executionPhase: input.executionPhase,
      question: interviewOutput,
      optionId: decision.optionId,
      answer: decision.feedback,
      ...(skipped ? { skipped: true } : {}),
      ...(decision.interviewQuestions?.length ? { questions: decision.interviewQuestions } : {}),
      decisionRequestId: decision.requestId,
    });
    if (skipped) {
      await appendFactoryRunEvent(input.run.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "interview.all_questions_skipped",
        data: {
          stage: stage.name,
          decisionRequestId: decision.requestId,
        },
      });
    }
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
  return { text: answers.length > 0 ? answers.join("\n\n") : undefined, executionPath: lastExecutionPath, decisions: structuredDecisions, executionPhase: input.executionPhase };
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

function interviewDecisionSkipped(decision: {
  feedback?: string;
  interviewQuestions?: Array<{ skipped?: boolean; finalAnswer: string }>;
}): boolean {
  if (decision.interviewQuestions?.length) {
    return decision.interviewQuestions.every((question) => question.skipped === true || !question.finalAnswer.trim());
  }
  return !decision.feedback?.trim();
}

export function buildInterviewPrompt(input: {
  goal: string;
  stage: WorkflowStage;
  guidanceText?: string;
  skillBundleText?: string;
  discoveryReport?: string;
  executionPhase?: "pre-planning" | "post-verification";
  verificationContext?: { verificationStatus: string; changedFiles: string[]; planSummary?: string };
}): string {
  const taskObjective = taskObjectiveForPrompt(input.goal);
  return [
    "Role: Interview",
    "",
    input.executionPhase === "post-verification" ? "Your job is to ask the user questions about the verified candidate before review." : "Your job is to ask the user the questions needed before Factory plans implementation.",
    "Do not implement code. Do not write the implementation plan.",
    "If no user interview is needed, return exactly: INTERVIEW_COMPLETE",
    "",
    `Task: ${taskObjective}`,
    `Interview stage: ${input.stage.name}`,
    input.stage.description ? `Stage description: ${input.stage.description}` : undefined,
    input.skillBundleText ? `Selected skills:\n${input.skillBundleText}` : undefined,
    input.guidanceText ? `Project guidance context:\n${input.guidanceText}` : undefined,
    input.discoveryReport ? `Validated Discovery result:\n${input.discoveryReport}` : undefined,
    input.executionPhase === "post-verification" && input.verificationContext ? [
      "",
      "Verified candidate context:",
      `Verification status: ${input.verificationContext.verificationStatus}`,
      `Changed files:\n${input.verificationContext.changedFiles.join("\n")}`,
      input.verificationContext.planSummary ? `Plan summary:\n${input.verificationContext.planSummary}` : undefined,
    ].filter(Boolean).join("\n") : undefined,
    "",
    "Ask concise, answerable questions. Prefer one round of high-impact questions.",
    "When a question is genuinely multiple-choice, include an explicit options block in this exact shape:",
    "Options:\n[A] <option label> — <optional short description>\n[B] <option label> — <optional short description>",
    "Do not emit an 'Other' option; Factory renders a built-in custom-answer path automatically.",
    "If a question is open-ended, omit the Options block and ask for free text.",
    input.executionPhase === "post-verification" ? "The user answer will be recorded and passed to review and approval only." : "The user answer will be recorded and passed into the planner.",
  ].filter(Boolean).join("\n");
}

export function buildDiscoveryPrompt(
  goal: string,
  constitutionContext?: string,
  skillBundleText?: string,
  evidencePacket?: DiscoveryEvidencePacket,
): string {
  const taskObjective = taskObjectiveForPrompt(goal);
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
    "- invent existing file paths",
    "- mark a finding confirmed unless it is supported by the evidence packet",
    "- stop after a preamble",
    "",
    "Objective:",
    "- Report whether an existing implementation surface is identified, missing, or ambiguous.",
    "- Find the concrete existing files involved when they exist.",
    "- Return evidence from those files or explain the missing/ambiguous surface as unknowns.",
    "- Capture only unknowns that remain after read-only inspection.",
    "- If the goal clearly requires creating one or more NEW files (they do not exist and cannot be discovered), report them in newFiles[] with a note in unknowns[] explaining why; never list them in files[] or as confirmed evidence.",
    "- Prefer files from candidate_files. You may list another file only if it appears in observed_files.",
    "",
    `User task: ${taskObjective}`,
    skillBundleText ? `Selected skills:\n${skillBundleText}` : undefined,
    constitutionContext ? `Project guidance context:\n${constitutionContext}` : undefined,
    evidencePacket ? `Repository evidence packet (authoritative):\n${renderDiscoveryEvidencePacket(evidencePacket)}` : undefined,
    "",
    "Return JSON only, with this exact shape:",
    "{",
    "  \"status\": \"complete\",",
    "  \"implementationSurface\": \"identified\" | \"missing\" | \"ambiguous\",",
    "  \"files\": [\"src/path/to/file.ts\"],",
    "  \"newFiles\": [\"src/path/to/new-file.ts\"],",
    "  \"evidence\": [",
    "    { \"status\": \"confirmed\", \"file\": \"src/path/to/file.ts\", \"finding\": \"What this file proves\" }",
    "  ],",
    "  \"unknowns\": []",
    "}",
    "",
    "A concrete file is a real file path like src/data/courses.ts, src/components/UpcomingCourses.tsx, package.json, factory.yaml, or .factory/config.yaml.",
    "A directory such as src/, components/, frontend/, backend/, or course files is not a concrete file.",
    "If no existing implementation file exists, return implementationSurface \"missing\", files [], and unknowns that describe the absent surface.",
    "If the surface is ambiguous, return implementationSurface \"ambiguous\", only confirmed files in files[], and unknowns that describe the ambiguity.",
    "Every existing file in files[] must appear in observed_files from the repository evidence packet.",
    "Every confirmed evidence file must appear in observed_files from the repository evidence packet.",
    "If the goal clearly requires creating a NEW file that does not exist yet (e.g. a data file, a new component file, a new config), list it in newFiles[] — NOT in files[]. A newFile must not appear in files[] and must not be claimed as confirmed evidence; describe why it must be created in unknowns[]. Only name a newFile when the goal makes its creation necessary, never speculate.",
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
  const taskObjective = taskObjectiveForPrompt(goal);
  return [
    "You are an expert Principal Software Architect and Lead Project Planner.",
    "Your job is to turn the validated Discovery result and project guidance into a precise execution contract for the Builder.",
    "The Builder should not need to reconstruct the plan by broadly surveying the repository; your handoff must name the files, order of edits, constraints, and verification signals.",
    `Task: ${taskObjective}`,
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
    interviewContext ? "If every interview answer is marked [skipped] and the task plus Discovery evidence are not enough to plan safely, return exactly `INTERVIEW_SKIPPED_NEEDS_CLARIFICATION: <one sentence naming the missing decision>` and stop." : undefined,
    "",
    "Discovery has already inspected the repository.",
    "Use the supplied Discovery evidence as your repository context.",
    "Do not ask Builder to broadly find, locate, search for, or identify implementation files.",
    "If Discovery identified existing files, create the implementation sequence using those files.",
    "If Discovery reports newFiles (files the goal requires creating that do not exist yet), treat them as authoritative create-targets: name them in TARGET FILES and give the Builder an explicit create step for each.",
    "If Discovery reports implementationSurface \"missing\", choose explicit new files for the Builder to create based on the task and observed repository status.",
    "If Discovery reports implementationSurface \"ambiguous\", plan the smallest bounded inspection needed before editing and keep it tied to Discovery's observed files and unknowns.",
    "A narrow inspection of an identified or newly planned file is allowed when needed before editing.",
    "",
    "Produce the plan with exactly these sections:",
    "",
    "1. PLANNING DECISIONS",
    "- Restate the outcome in one sentence.",
    "- Name the confirmed files, components, data sources, commands, or config surfaces the Builder should use.",
    "- If no implementation surface exists yet, name the new files the Builder should create.",
    "- State the chosen approach and why it fits the existing system.",
    "- Call out any non-negotiable constraints from the user, config, or project guidance.",
    "",
    "2. TARGET FILES",
    "- List the exact files the Builder will create or modify, one per line as `- path/to/file.ext`.",
    "- Do not list files that must stay untouched; those belong in Non-goals.",
    "",
    "3. NON-GOALS",
    "- List the exact files, directories, or surfaces the Builder must NOT change, one per line as `- path/to/file.ext` or `- dir/`.",
    "- Include constraints from the user, interview answers, or project guidance (e.g. \"do not touch the contact form\", \"no CSS\", \"do not modify .factory\").",
    "- If there are no non-goals, write exactly \"None\".",
    "",
    "4. IMPLEMENTATION SEQUENCE",
    "- Break the work into small, sequential, and testable steps labeled Step 1, Step 2, etc.",
    "- Ensure each step builds logically on the previous one.",
    "- Each step names exact target file(s) to read and/or edit — never a directory, a glob, or 'the relevant files'.",
    "- For each step, include: affected file(s), exact action, negative path/edge case to preserve, and verification signal.",
    "- For each edit step, put the concrete reads first (exact file paths) and an explicit 'Stop discovery after <N> check(s):' line naming what the Builder must confirm before it may stop reading and start editing.",
    "- Do not make the first step a broad search, location, or file-identification step.",
    "- Do not write steps like 'inspect exports/imports before editing' — instead name the exact files to read and the exact facts to confirm (e.g. 'confirm exported Foo still exists; confirm Bar accepts field baz').",
    "",
    "5. VERIFICATION CONTRACT",
    "- List the exact checks, commands, or manual assertions that should prove the change works.",
    "- Tie each check to the risk or requirement it covers.",
    "- If a configured command is not appropriate, explain why and choose the weakest valid verification that still gives useful signal.",
    "",
    "6. RISKS AND BLOCKERS",
    "- List concrete risks, such as stale content, bad selectors, broken links, unavailable models, invalid commands, dependency issues, or verification gaps.",
    "- Provide a mitigation or fallback for each risk.",
    "- Mark user decisions as blockers only when Builder cannot safely proceed without them.",
    "",
    "7. CHANGE REQUIREMENT",
    "- State whether an implementation diff is actually required by the goal. Use one of exactly: `Status: required`, `Status: not-required`, or `Status: uncertain`.",
    "- If required, list the concrete observed baseline gaps as `Baseline gap: ...` lines (evidence-backed, tied to the files above).",
    "- If required, list each concrete diff the Builder must make as `Required change: ...` lines. If already satisfied, write `Status: not-required` and do not invent cosmetic or verification-only edits.",
    "",
    "Constraints:",
    "- Be specific. Avoid vague phrases like 'likely touchpoints' when Discovery provided concrete evidence.",
    "- For content/UI tasks, name the discovered files/components/data sources that should change.",
    "- Do not claim a file, route, dependency, command, or framework exists unless it is supported by the Discovery result or project guidance context.",
    "- You may define new files to create when Discovery reports the implementation surface is missing.",
    "- Do not delegate broad discovery to Builder with phrases like 'search for', 'find where', 'locate the', or 'identify the relevant file'.",
    "- Do not broaden scope beyond the requested outcome.",
    "- Do not propose unrelated documentation rewrites or adjacent cleanup unless clearly required.",
    "- Do not repeat the prompt, Discovery Report, or project guidance context.",
    "- Keep the plan concise but operational: the Builder should know where to start, what to change, what not to break, and how to verify without rebuilding the plan.",
    "- End with exactly: WAITING_FOR_APPROVAL",
  ].filter(Boolean).join("\n");
}
