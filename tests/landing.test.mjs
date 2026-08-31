import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { buildCompletedTasks } from "../packages/core/dist/runtime/landing.js";
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
