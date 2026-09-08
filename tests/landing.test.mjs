import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { buildCompletedTasks, runLandingFlow } from "../packages/core/dist/runtime/landing.js";
import { classifyDirtyFiles, executeLandingStrategy, validateLandingPlan } from "../packages/core/dist/runtime/landing-git.js";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

async function initRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-landing-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "factory@example.test"]);
  await git(root, ["config", "user.name", "Factory Test"]);
  await fs.writeFile(path.join(root, "README.md"), "# fixture\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "init"]);
  return root;
}

test("completed tasks normalize committed feature changes", () => {
  const completed = buildCompletedTasks([
    {
      taskId: "task-1",
      path: "/tmp/worktree",
      mode: "created",
      branch: "factory/task-1",
      shouldIntegrate: true,
      changedFiles: ["index.html"],
      commitSha: "abc123",
    },
    {
      taskId: "task-2",
      path: "/tmp/worktree",
      mode: "created",
      branch: "factory/task-2",
      shouldIntegrate: true,
      changedFiles: [],
      commitSha: "def456",
    },
  ], "main");

  assert.deepEqual(completed, [{
    taskId: "task-1",
    targetBranch: "main",
    sourceBranch: "factory/task-1",
    commitSha: "abc123",
    changedFiles: ["index.html"],
    workspaceMode: "created",
    worktreePath: "/tmp/worktree",
  }]);
});

test("landing guard ignores unrelated runtime dirties but blocks feature overlap", async () => {
  const root = await initRepo();
  await git(root, ["switch", "-c", "factory/task-1"]);
  await fs.writeFile(path.join(root, "index.html"), "<h1>Doctor</h1>\n", "utf8");
  await git(root, ["add", "index.html"]);
  await git(root, ["commit", "-m", "add portfolio"]);
  const candidateSha = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["switch", "main"]);

  const completedTasks = [{
    taskId: "task-1",
    targetBranch: "main",
    sourceBranch: "factory/task-1",
    commitSha: candidateSha,
    changedFiles: ["index.html"],
    workspaceMode: "created",
    worktreePath: root,
  }];
  const plan = {
    strategy: "cherry-pick",
    targetBranch: "main",
    candidateSha,
    sourceBranch: "factory/task-1",
    reasoning: ["isolated feature commit"],
    verification: ["manual"],
    risk: "low",
    expectedFiles: ["index.html"],
  };

  await fs.mkdir(path.join(root, ".pi-glla"), { recursive: true });
  await fs.writeFile(path.join(root, ".pi-glla", "active.jsonl"), "{}\n", "utf8");
  const runtimeDirty = classifyDirtyFiles([".pi-glla/active.jsonl"], completedTasks);
  assert.deepEqual(runtimeDirty.relevant, []);
  assert.deepEqual(runtimeDirty.unrelated, [".pi-glla/active.jsonl"]);
  const runtimeVerdict = await validateLandingPlan({
    mergeCwd: root,
    plan,
    dirtyRelevantFiles: runtimeDirty.relevant,
    dirtyUnrelatedFiles: runtimeDirty.unrelated,
    finalMergePolicy: "required",
    completedTasks,
    verificationStatus: "passed",
  });
  assert.equal(runtimeVerdict.ok, true);

  const noCommandsVerdict = await validateLandingPlan({
    mergeCwd: root,
    plan,
    dirtyRelevantFiles: runtimeDirty.relevant,
    dirtyUnrelatedFiles: runtimeDirty.unrelated,
    finalMergePolicy: "required",
    completedTasks,
    verificationStatus: "incomplete",
  });
  assert.equal(noCommandsVerdict.ok, true);

  await fs.writeFile(path.join(root, "index.html"), "<h1>User draft</h1>\n", "utf8");
  const featureDirty = classifyDirtyFiles(["index.html"], completedTasks);
  const featureVerdict = await validateLandingPlan({
    mergeCwd: root,
    plan,
    dirtyRelevantFiles: featureDirty.relevant,
    dirtyUnrelatedFiles: featureDirty.unrelated,
    finalMergePolicy: "required",
    completedTasks,
    verificationStatus: "passed",
  });
  assert.equal(featureVerdict.ok, false);
  assert.ok(featureVerdict.reasons.some((reason) => /overlaps landing files/.test(reason)));
});

test("landing executor treats an in-place candidate already on target as landed", async () => {
  const root = await initRepo();
  await fs.writeFile(path.join(root, "index.html"), "<h1>Doctor</h1>\n", "utf8");
  await git(root, ["add", "index.html"]);
  await git(root, ["commit", "-m", "add portfolio"]);
  const candidateSha = await git(root, ["rev-parse", "HEAD"]);

  const result = await executeLandingStrategy({
    cwd: root,
    plan: {
      strategy: "cherry-pick",
      targetBranch: "main",
      candidateSha,
      reasoning: ["candidate was produced in place"],
      verification: [],
      risk: "low",
      expectedFiles: ["index.html"],
    },
  });

  assert.equal(result.status, "landed");
  assert.equal(result.outcome, "landed");
});

test('recovery pull request uses authenticated gh without exposing credentials', async () => {
  const root = await initRepo();
  await git(root, ["switch", "-c", "factory/candidate"]);
  await fs.writeFile(path.join(root, "index.html"), "<h1>Candidate</h1>\n", "utf8");
  await git(root, ["add", "index.html"]);
  await git(root, ["commit", "-m", "candidate"]);
  const remote = await fs.mkdtemp(path.join(os.tmpdir(), "factory-landing-remote-"));
  await git(remote, ["init", "--bare"]);
  await git(root, ["remote", "add", "origin", remote]);

  const bin = path.join(root, "fake-bin");
  await fs.mkdir(bin, { recursive: true });
  const logPath = path.join(root, "fake-gh.log");
  await fs.writeFile(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" > "${logPath}"\ncase "$1 $2" in\n  "pr list") exit 0 ;;\n  "pr create") printf '%s\\n' 'https://github.com/example/repo/pull/42' ;;\nesac\n`, "utf8");
  await fs.chmod(path.join(bin, "gh"), 0o755);

  const { createRecoveryPullRequest } = await import("../packages/core/dist/git/pull-request.js");
  const result = await createRecoveryPullRequest({
    cwd: root,
    sourceBranch: "factory/candidate",
    targetBranch: "main",
    runId: "run-test",
    goal: "Add candidate feature",
    reason: "baseline verification debt",
    candidateSha: await git(root, ["rev-parse", "HEAD"]),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.equal(result.status, "created");
  assert.equal(result.url, "https://github.com/example/repo/pull/42");
  const args = await fs.readFile(logPath, "utf8");
  assert.match(args, /pr create/);
  assert.match(args, /--base main/);
  assert.match(args, /--head factory\/candidate/);
  assert.doesNotMatch(args, /token|authorization/i);
});

test('recovery pull request can be disabled without running git or gh', async () => {
  const result = await (await import("../packages/core/dist/git/pull-request.js")).createRecoveryPullRequest({
    cwd: "/does-not-exist",
    sourceBranch: "factory/candidate",
    targetBranch: "main",
    runId: "run-test",
    goal: "candidate",
    reason: "blocked",
    enabled: false,
  });
  assert.equal(result.status, "skipped");
});

test('recovery pull request fails fast and actionable when no remote exists', async () => {
  const root = await initRepo();
  await git(root, ["switch", "-c", "factory/candidate"]);
  await fs.writeFile(path.join(root, "index.html"), "<h1>Candidate</h1>\n", "utf8");
  await git(root, ["add", "index.html"]);
  await git(root, ["commit", "-m", "candidate"]);

  const { createRecoveryPullRequest } = await import("../packages/core/dist/git/pull-request.js");
  const result = await createRecoveryPullRequest({
    cwd: root,
    sourceBranch: "factory/candidate",
    targetBranch: "main",
    runId: "run-test",
    goal: "Add candidate feature",
    reason: "baseline debt",
    candidateSha: await git(root, ["rev-parse", "HEAD"]),
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

  assert.equal(result.status, "failed");
  assert.match(result.reason, /No git remote is configured|not pushed/i);
  assert.match(result.reason, /preserved locally/);
});

test('landing finalizes after direct cherry-pick even when post-landing verification fails', async () => {
  const root = await initRepo();
  await git(root, ["switch", "-c", "factory/task-1"]);
  await fs.writeFile(path.join(root, "index.html"), "<h1>Candidate</h1>\n", "utf8");
  await git(root, ["add", "index.html"]);
  await git(root, ["commit", "-m", "candidate"]);
  const candidateSha = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["switch", "main"]);

  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "factory-run-landing-"));
  const eventsPath = path.join(runDir, "events.jsonl");
  await fs.writeFile(eventsPath, "", "utf8");
  const landingExecutor = {
    async execute() {
      return {
        status: "completed",
        outputText: JSON.stringify({
          strategy: "cherry-pick",
          targetBranch: "main",
          candidateSha,
          sourceBranch: "factory/task-1",
          reasoning: ["safe single commit"],
          verification: ["lint"],
          risk: "low",
          expectedFiles: ["index.html"],
          recoveryPlan: "Open a PR if direct landing fails.",
        }),
        events: [],
      };
    },
  };

  const result = await runLandingFlow({
    runDir,
    runId: "run-test",
    eventsPath,
    goal: "Add candidate feature",
    mergeCwd: root,
    taskType: "general",
    config: {
      git: { baseBranch: "main", pullRequest: { enabled: true, provider: "github", cli: "gh", draft: false } },
      approval: { finalMerge: "required" },
      runtime: { limits: {} },
      models: { repair: undefined, landing: { provider: "openai-codex", model: "gpt-test" }, reviewer: { provider: "openai-codex", model: "gpt-test" } },
    },
    completedTasks: [{
      taskId: "task-1",
      targetBranch: "main",
      sourceBranch: "factory/task-1",
      commitSha: candidateSha,
      changedFiles: ["index.html"],
      workspaceMode: "created",
      worktreePath: root,
    }],
    candidateSha,
    candidateBranch: "factory/task-1",
    verificationPlan: {
      cwd: root,
      cwdResolution: "default-root",
      commands: { lint: `node -e "process.exit(1)"` },
      selectionSource: "deterministic",
      skill: { id: "test", version: "1.0.0", mode: "verification", selectionReasons: [] },
      evidence: { rootCwd: root, configuredCommands: {}, allowedCommands: [], rootScripts: [], candidateCwds: [], commandDecisions: [] },
    },
    verification: { cwd: root, cwdResolution: "default-root", commands: [], overallStatus: "passed" },
    verificationFailureClassification: undefined,
    contractCanComplete: true,
    controllerInput: { cwd: root, goal: "Add candidate feature", landingExecutor },
    repairGuidanceText: undefined,
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.phase, "complete");
  assert.equal(result.landingStatus, "landed");
  const finalMerge = JSON.parse(await fs.readFile(path.join(runDir, "final-merge.json"), "utf8"));
  assert.equal(finalMerge.status, "landed");
  assert.equal(finalMerge.postLandingVerification.status, "failed");
  const attempts = (await fs.readFile(path.join(runDir, "landing-attempts.jsonl"), "utf8")).trim().split(/\n+/).map((line) => JSON.parse(line));
  assert.equal(attempts[0].stage, "started");
  assert.ok(attempts.some((entry) => entry.stage === "applied"));
  assert.ok(attempts.some((entry) => entry.stage === "finalized"));
});

test('landing finalizes when post-landing verification command times out', async () => {
  const root = await initRepo();
  await git(root, ["switch", "-c", "factory/task-timeout"]);
  await fs.writeFile(path.join(root, "index.html"), "<h1>Candidate</h1>\n", "utf8");
  await git(root, ["add", "index.html"]);
  await git(root, ["commit", "-m", "candidate"]);
  const candidateSha = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["switch", "main"]);

  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "factory-run-landing-timeout-"));
  const eventsPath = path.join(runDir, "events.jsonl");
  const statePath = path.join(runDir, "state.json");
  await fs.writeFile(eventsPath, "", "utf8");
  await fs.writeFile(statePath, JSON.stringify({ runId: "run-timeout", status: "RUNNING", phase: "landing-planning", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, null, 2), "utf8");
  const landingExecutor = {
    async execute() {
      return {
        status: "completed",
        outputText: JSON.stringify({
          strategy: "cherry-pick",
          targetBranch: "main",
          candidateSha,
          sourceBranch: "factory/task-timeout",
          reasoning: ["safe single commit"],
          verification: ["lint"],
          risk: "low",
          expectedFiles: ["index.html"],
          recoveryPlan: "Open a PR if direct landing fails.",
        }),
        events: [],
      };
    },
  };

  const result = await runLandingFlow({
    runDir,
    runId: "run-timeout",
    eventsPath,
    statePath,
    goal: "Add candidate feature",
    mergeCwd: root,
    taskType: "general",
    config: {
      git: { baseBranch: "main", pullRequest: { enabled: true, provider: "github", cli: "gh", draft: false } },
      approval: { finalMerge: "required" },
      runtime: { limits: { toolTimeoutMs: 20 } },
      models: { repair: undefined, landing: { provider: "openai-codex", model: "gpt-test" }, reviewer: { provider: "openai-codex", model: "gpt-test" } },
    },
    completedTasks: [{
      taskId: "task-1",
      targetBranch: "main",
      sourceBranch: "factory/task-timeout",
      commitSha: candidateSha,
      changedFiles: ["index.html"],
      workspaceMode: "created",
      worktreePath: root,
    }],
    candidateSha,
    candidateBranch: "factory/task-timeout",
    verificationPlan: {
      cwd: root,
      cwdResolution: "default-root",
      commands: { lint: `node -e "setTimeout(() => {}, 2000)"` },
      selectionSource: "deterministic",
      skill: { id: "test", version: "1.0.0", mode: "verification", selectionReasons: [] },
      evidence: { rootCwd: root, configuredCommands: {}, allowedCommands: [], rootScripts: [], candidateCwds: [], commandDecisions: [] },
    },
    verification: { cwd: root, cwdResolution: "default-root", commands: [], overallStatus: "passed" },
    verificationFailureClassification: undefined,
    contractCanComplete: true,
    controllerInput: { cwd: root, goal: "Add candidate feature", landingExecutor },
    repairGuidanceText: undefined,
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.phase, "complete");
  const finalMerge = JSON.parse(await fs.readFile(path.join(runDir, "final-merge.json"), "utf8"));
  assert.equal(finalMerge.status, "landed");
  assert.equal(finalMerge.postLandingVerification.status, "failed");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(state.phase, "post-landing-verification");
  const events = await fs.readFile(eventsPath, "utf8");
  assert.match(events, /landing\.post_verification_started/);
  assert.match(events, /landing\.post_verification_completed/);
  const attempts = (await fs.readFile(path.join(runDir, "landing-attempts.jsonl"), "utf8")).trim().split(/\n+/).map((line) => JSON.parse(line));
  assert.ok(attempts.some((entry) => entry.stage === "finalized"));
});

test('successful PR recovery completes the run instead of leaving landing blocked', async () => {
  const root = await initRepo();
  await git(root, ["switch", "-c", "factory/candidate"]);
  await fs.writeFile(path.join(root, "index.html"), "<h1>Candidate</h1>\n", "utf8");
  await git(root, ["add", "index.html"]);
  await git(root, ["commit", "-m", "candidate"]);
  const candidateSha = await git(root, ["rev-parse", "HEAD"]);
  const remote = await fs.mkdtemp(path.join(os.tmpdir(), "factory-landing-remote-"));
  await git(remote, ["init", "--bare"]);
  await git(root, ["remote", "add", "origin", remote]);
  await git(root, ["switch", "main"]);
  await fs.writeFile(path.join(root, "index.html"), "<h1>User draft</h1>\n", "utf8");

  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "factory-run-landing-"));
  const eventsPath = path.join(runDir, "events.jsonl");
  await fs.writeFile(eventsPath, "", "utf8");
  const bin = path.join(root, "fake-bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "gh"), `#!/bin/sh\ncase "$1 $2" in\n  "pr list") exit 0 ;;\n  "pr create") printf '%s\\n' 'https://github.com/example/repo/pull/99'; exit 0 ;;\n  *) exit 1 ;;\nesac\n`, "utf8");
  await fs.chmod(path.join(bin, "gh"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  const landingExecutor = {
    async execute() {
      return {
        status: "completed",
        outputText: JSON.stringify({
          strategy: "cherry-pick",
          targetBranch: "main",
          candidateSha,
          sourceBranch: "factory/candidate",
          reasoning: ["try direct landing first"],
          verification: ["lint"],
          risk: "low",
          expectedFiles: ["index.html"],
          recoveryPlan: "Open a PR if direct landing fails.",
        }),
        events: [],
      };
    },
  };

  try {
    const result = await runLandingFlow({
      runDir,
      runId: "run-pr",
      eventsPath,
      goal: "Add candidate feature",
      mergeCwd: root,
      taskType: "general",
      config: {
        git: { baseBranch: "main", pullRequest: { enabled: true, provider: "github", cli: "gh", draft: false } },
        approval: { finalMerge: "required" },
        runtime: { limits: {} },
        models: { repair: undefined, landing: { provider: "openai-codex", model: "gpt-test" }, reviewer: { provider: "openai-codex", model: "gpt-test" } },
      },
      completedTasks: [{
        taskId: "task-1",
        targetBranch: "main",
        sourceBranch: "factory/candidate",
        commitSha: candidateSha,
        changedFiles: ["index.html"],
        workspaceMode: "created",
        worktreePath: root,
      }],
      candidateSha,
      candidateBranch: "factory/candidate",
      verificationPlan: {
        cwd: root,
        cwdResolution: "default-root",
        commands: { lint: `node -e "process.exit(0)"` },
        selectionSource: "deterministic",
        skill: { id: "test", version: "1.0.0", mode: "verification", selectionReasons: [] },
        evidence: { rootCwd: root, configuredCommands: {}, allowedCommands: [], rootScripts: [], candidateCwds: [], commandDecisions: [] },
      },
      verification: { cwd: root, cwdResolution: "default-root", commands: [], overallStatus: "failed" },
      verificationFailureClassification: undefined,
      contractCanComplete: true,
      controllerInput: { cwd: root, goal: "Add candidate feature", landingExecutor },
      repairGuidanceText: undefined,
    });

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.phase, "pull-request-opened");
    assert.equal(result.landingStatus, "pull-request");
    assert.equal(result.pullRequest?.url, "https://github.com/example/repo/pull/99");
    const finalMerge = JSON.parse(await fs.readFile(path.join(runDir, "final-merge.json"), "utf8"));
    assert.equal(finalMerge.status, "pull-request-created");
    assert.equal(finalMerge.outcome, "pull-request-created");
  } finally {
    process.env.PATH = previousPath;
  }
});

test('recovery pull request reports missing gh clearly and keeps pushed branch usable', async () => {
  const root = await initRepo();
  await git(root, ["switch", "-c", "factory/candidate"]);
  await fs.writeFile(path.join(root, "index.html"), "<h1>Candidate</h1>\n", "utf8");
  await git(root, ["add", "index.html"]);
  await git(root, ["commit", "-m", "candidate"]);
  const remote = await fs.mkdtemp(path.join(os.tmpdir(), "factory-landing-remote-"));
  await git(remote, ["init", "--bare"]);
  await git(root, ["remote", "add", "origin", remote]);

  const bin = path.join(root, "git-only-bin");
  await fs.mkdir(bin, { recursive: true });
  const realGit = (await import("node:child_process")).execSync("command -v git").toString().trim();
  await fs.symlink(realGit, path.join(bin, "git"));

  const { createRecoveryPullRequest } = await import("../packages/core/dist/git/pull-request.js");
  const result = await createRecoveryPullRequest({
    cwd: root,
    sourceBranch: "factory/candidate",
    targetBranch: "main",
    runId: "run-test",
    goal: "Add candidate feature",
    reason: "baseline debt",
    env: { ...process.env, PATH: bin, GIT_TERMINAL_PROMPT: "0" },
  });

  assert.equal(result.status, "failed");
  assert.match(result.reason, /gh\) is not installed/i);
  // The push already succeeded, so the branch is on the remote for manual merge.
  await assert.doesNotReject(git(root, ["ls-remote", "--heads", "origin", "factory/candidate"]));
});

// Sets up a real candidate branch + commit so the guard's pre-existing ref
// checks pass; the scope check is then the only thing under test.
async function scopeGuardRepo(changedFiles) {
  const root = await initRepo();
  await git(root, ["switch", "-c", "factory/candidate"]);
  await fs.writeFile(path.join(root, "index.html"), "<h1>Candidate</h1>\n", "utf8");
  await fs.writeFile(path.join(root, "contact-form.html"), "<form></form>\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "candidate" ]);
  const candidateSha = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["switch", "main"]);
  const plan = {
    strategy: "merge",
    targetBranch: "main",
    candidateSha,
    sourceBranch: "factory/candidate",
    reasoning: ["land"],
    verification: ["test"],
    risk: "low",
    expectedFiles: changedFiles,
  };
  const completedTasks = [{
    taskId: "task-1",
    targetBranch: "main",
    sourceBranch: "factory/candidate",
    commitSha: candidateSha,
    changedFiles,
    workspaceMode: "created",
    worktreePath: root,
  }];
  return { root, plan, completedTasks };
}

test('landing guard: scope violation warns (notes) by default, ok stays true', async () => {
  const { root, plan, completedTasks } = await scopeGuardRepo(["contact-form.html"]);
  const verdict = await validateLandingPlan({
    mergeCwd: root,
    plan,
    dirtyRelevantFiles: [],
    dirtyUnrelatedFiles: [],
    finalMergePolicy: "required",
    completedTasks,
    verificationStatus: "passed",
    nonGoals: ["contact-form.html"],
    scopeGuardBlocking: false,
  });
  assert.equal(verdict.ok, true, "warn mode must not block");
  assert.ok(verdict.notes && verdict.notes.some((note) => /non-goals/.test(note)), `expected scope note, got ${JSON.stringify(verdict.notes)}`);
});

test('landing guard: scope violation blocks (reasons) when scopeGuardBlocking is true', async () => {
  const { root, plan, completedTasks } = await scopeGuardRepo(["contact-form.html"]);
  const verdict = await validateLandingPlan({
    mergeCwd: root,
    plan,
    dirtyRelevantFiles: [],
    dirtyUnrelatedFiles: [],
    finalMergePolicy: "required",
    completedTasks,
    verificationStatus: "passed",
    nonGoals: ["contact-form.html"],
    scopeGuardBlocking: true,
  });
  assert.equal(verdict.ok, false, "block mode must set ok false");
  assert.ok(verdict.reasons.some((reason) => /non-goals/.test(reason)), `expected block reason, got ${JSON.stringify(verdict.reasons)}`);
});

test('landing guard: no non-goals means no scope note/reason', async () => {
  const { root, plan, completedTasks } = await scopeGuardRepo(["index.html"]);
  const verdict = await validateLandingPlan({
    mergeCwd: root,
    plan,
    dirtyRelevantFiles: [],
    dirtyUnrelatedFiles: [],
    finalMergePolicy: "required",
    completedTasks,
    verificationStatus: "passed",
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.notes, undefined);
});

// Helper: a real candidate branch + commit, then run runLandingFlow with a
// post-landing verification command that fails. Returns the landing result
// plus the run dir, events, and a repair-executor spy.
async function landingFixture({ postLandingExitCode, verificationFailureClassification, verificationStatus = "passed" }) {
  const root = await initRepo();
  await git(root, ["switch", "-c", "factory/task-1"]);
  await fs.writeFile(path.join(root, "index.html"), "<h1>Candidate</h1>\n", "utf8");
  await git(root, ["add", "index.html"]);
  await git(root, ["commit", "-m", "candidate"]);
  const candidateSha = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["switch", "main"]);

  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "factory-run-landing-"));
  const eventsPath = path.join(runDir, "events.jsonl");
  await fs.writeFile(eventsPath, "", "utf8");
  const landingExecutor = {
    async execute() {
      return {
        status: "completed",
        outputText: JSON.stringify({
          strategy: "cherry-pick",
          targetBranch: "main",
          candidateSha,
          sourceBranch: "factory/task-1",
          reasoning: ["safe single commit"],
          verification: ["lint"],
          risk: "low",
          expectedFiles: ["index.html"],
          recoveryPlan: "Open a PR if direct landing fails.",
        }),
        events: [],
      };
    },
  };
  const repairCalls = [];
  const repairExecutor = {
    async execute(input) {
      repairCalls.push(input);
      return { status: "completed", outputText: "", events: [] };
    },
  };

  const result = await runLandingFlow({
    runDir,
    runId: "run-test",
    eventsPath,
    goal: "Add candidate feature",
    mergeCwd: root,
    taskType: "general",
    config: {
      git: { baseBranch: "main", pullRequest: { enabled: true, provider: "github", cli: "gh", draft: false } },
      approval: { finalMerge: "required" },
      runtime: { limits: {} },
      models: { repair: { provider: "openai-codex", model: "gpt-test" }, landing: { provider: "openai-codex", model: "gpt-test" }, reviewer: { provider: "openai-codex", model: "gpt-test" } },
    },
    completedTasks: [{
      taskId: "task-1",
      targetBranch: "main",
      sourceBranch: "factory/task-1",
      commitSha: candidateSha,
      changedFiles: ["index.html"],
      workspaceMode: "created",
      worktreePath: root,
    }],
    candidateSha,
    candidateBranch: "factory/task-1",
    verificationPlan: {
      cwd: root,
      cwdResolution: "default-root",
      commands: { lint: `node -e "process.exit(${postLandingExitCode})"` },
      selectionSource: "deterministic",
      skill: { id: "test", version: "1.0.0", mode: "verification", selectionReasons: [] },
      evidence: { rootCwd: root, configuredCommands: {}, allowedCommands: [], rootScripts: [], candidateCwds: [], commandDecisions: [] },
    },
    verification: { cwd: root, cwdResolution: "default-root", commands: [], overallStatus: verificationStatus },
    verificationFailureClassification,
    contractCanComplete: true,
    controllerInput: { cwd: root, goal: "Add candidate feature", landingExecutor, repairExecutor },
    repairGuidanceText: undefined,
  });
  return { root, runDir, eventsPath, candidateSha, result, repairCalls };
}

test('post-landing verification failure on baseline-unrelated debt skips the repair agent', async () => {
  const { runDir, result, repairCalls } = await landingFixture({
    postLandingExitCode: 1,
    verificationStatus: "failed",
    verificationFailureClassification: {
      kind: "baseline-unrelated",
      reason: "lint fails on untouched legacy file",
      retryable: false,
      suggestedPhase: "verification",
      classificationSource: "deterministic",
      perCommand: [{
        commandName: "lint",
        category: "baseline-unrelated",
        reason: "Failure outside implemented files: hooks/useRateLimiter.js",
        retryable: false,
        suggestedAction: "ignore",
        implicatedFiles: ["hooks/useRateLimiter.js"],
      }],
    },
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.landingStatus, "landed");
  assert.equal(repairCalls.length, 0, "baseline-unrelated post-landing failure must not launch a repair agent");
  const finalMerge = JSON.parse(await fs.readFile(path.join(runDir, "final-merge.json"), "utf8"));
  assert.equal(finalMerge.status, "landed");
  assert.equal(finalMerge.postLandingVerification.status, "failed");
  assert.equal(finalMerge.postLandingVerification.repairAttempted, false);
  assert.match(finalMerge.postLandingVerification.reason, /baseline-unrelated/);
  const events = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8");
  assert.ok(/landing.post_verification_repair_skipped/.test(events), "expected repair-skipped event");
});

test('post-landing verification failure on a real failure still launches the repair agent', async () => {
  const { result, repairCalls } = await landingFixture({
    postLandingExitCode: 1,
    verificationStatus: "failed",
    verificationFailureClassification: {
      kind: "real-code-failure",
      reason: "type error in changed file",
      retryable: true,
      suggestedPhase: "verification",
      classificationSource: "deterministic",
      perCommand: [{
        commandName: "lint",
        category: "real-code-failure",
        reason: "error in src/index.ts",
        retryable: true,
        suggestedAction: "repair",
        implicatedFiles: ["src/index.ts"],
      }],
    },
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.landingStatus, "landed");
  assert.ok(repairCalls.length >= 1, "real post-landing failure should still repair");
});

test('post-landing verification runs in mergeCwd, not the stale verification worktree', async () => {
  const root = await initRepo();
  await git(root, ["switch", "-c", "factory/task-1"]);
  await fs.writeFile(path.join(root, "index.html"), "<h1>Candidate</h1>\n", "utf8");
  await git(root, ["add", "index.html"]);
  await git(root, ["commit", "-m", "candidate"]);
  const candidateSha = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["switch", "main"]);

  // A stale checkout that the pre-landing verification ran in; the landed
  // commit lives in `root` (mergeCwd), so post-landing verification must run
  // there, not here.
  const staleWorktree = await fs.mkdtemp(path.join(os.tmpdir(), "factory-stale-worktree-"));

  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "factory-run-landing-"));
  const eventsPath = path.join(runDir, "events.jsonl");
  await fs.writeFile(eventsPath, "", "utf8");
  const landingExecutor = {
    async execute() {
      return {
        status: "completed",
        outputText: JSON.stringify({
          strategy: "cherry-pick",
          targetBranch: "main",
          candidateSha,
          sourceBranch: "factory/task-1",
          reasoning: ["safe single commit"],
          verification: ["lint"],
          risk: "low",
          expectedFiles: ["index.html"],
          recoveryPlan: "Open a PR if direct landing fails.",
        }),
        events: [],
      };
    },
  };

  const result = await runLandingFlow({
    runDir,
    runId: "run-test",
    eventsPath,
    goal: "Add candidate feature",
    mergeCwd: root,
    taskType: "general",
    config: {
      git: { baseBranch: "main", pullRequest: { enabled: true, provider: "github", cli: "gh", draft: false } },
      approval: { finalMerge: "required" },
      runtime: { limits: {} },
      models: { landing: { provider: "openai-codex", model: "gpt-test" }, reviewer: { provider: "openai-codex", model: "gpt-test" } },
    },
    completedTasks: [{
      taskId: "task-1",
      targetBranch: "main",
      sourceBranch: "factory/task-1",
      commitSha: candidateSha,
      changedFiles: ["index.html"],
      workspaceMode: "created",
      worktreePath: root,
    }],
    candidateSha,
    candidateBranch: "factory/task-1",
    // verificationPlan.cwd points at the STALE checkout; mergeCwd is the real
    // target. Post-landing verification must execute against mergeCwd.
    verificationPlan: {
      cwd: staleWorktree,
      cwdResolution: "default-root",
      commands: { lint: `node -e "require('node:fs').writeFileSync('post-landing-cwd.txt', process.cwd())"` },
      selectionSource: "deterministic",
      skill: { id: "test", version: "1.0.0", mode: "verification", selectionReasons: [] },
      evidence: { rootCwd: staleWorktree, configuredCommands: {}, allowedCommands: [], rootScripts: [], candidateCwds: [], commandDecisions: [] },
    },
    verification: { cwd: staleWorktree, cwdResolution: "default-root", commands: [], overallStatus: "passed" },
    verificationFailureClassification: undefined,
    contractCanComplete: true,
    controllerInput: { cwd: root, goal: "Add candidate feature", landingExecutor },
    repairGuidanceText: undefined,
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.landingStatus, "landed");
  const markerInMergeCwd = path.join(root, "post-landing-cwd.txt");
  const markerInStale = path.join(staleWorktree, "post-landing-cwd.txt");
  const mergeCwdMarker = await fs.readFile(markerInMergeCwd, "utf8").catch(() => undefined);
  const staleMarker = await fs.readFile(markerInStale, "utf8").catch(() => undefined);
  assert.ok(mergeCwdMarker && mergeCwdMarker.trim() === (await fs.realpath(root)), `post-landing verification should run in mergeCwd (${root}), got ${mergeCwdMarker ?? "no marker"}`);
  assert.equal(staleMarker, undefined, "post-landing verification must not run in the stale worktree");
});
