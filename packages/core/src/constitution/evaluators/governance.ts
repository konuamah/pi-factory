import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConstitutionArea, ConstitutionEvidence } from "../types.js";
import type { ConstitutionEvaluationContext } from "./shared.js";
import { buildRefreshNote, makeArea } from "./shared.js";

const execFileAsync = promisify(execFile);

export async function evaluateGovernanceAreas(context: ConstitutionEvaluationContext): Promise<ConstitutionArea[]> {
  const { discovery, impactedAreaIds, noChange } = context;
  const tracked = discovery.trackedFiles;
  const codeownersFiles = tracked.filter((file) => /(^|\/)(CODEOWNERS)$/i.test(file));
  const prTemplateFiles = tracked.filter((file) => /pull_request_template|PULL_REQUEST_TEMPLATE/i.test(file));
  const releaseFiles = tracked.filter((file) => /(release|changeset|changelog|version)/i.test(file) || /(^|\/)(\.changeset|CHANGELOG\.md)$/i.test(file));
  const deployFiles = tracked.filter((file) => /(deploy|deployment|helm|k8s|kubernetes|terraform|infra|docker-compose)/i.test(file));
  const featureFlagFiles = tracked.filter((file) => /(feature[-_.]?flag|flags?\.|launchdarkly|unleash)/i.test(file));
  const docsToInspect = dedupe([
    ...codeownersFiles,
    ...prTemplateFiles,
    ...releaseFiles,
    ...deployFiles,
    ...featureFlagFiles,
    ...discovery.docsFiles,
    ...discovery.ciFiles,
    ...discovery.manifests,
  ]).slice(0, 40);
  const inspected = await inspectFiles(discovery.root, docsToInspect);
  const policyInspected = inspected.filter((file) => !/package\.json$/i.test(file.path) && !/tsconfig(\.[^/]+)?\.json$/i.test(file.path));
  const releaseInspected = inspected.filter((file) => /(^|\/)(CHANGELOG\.md|\.changeset\/|release|changeset|workflow)/i.test(file.path) || file.path.startsWith(".github/workflows/"));

  const branches = await readLocalBranches(discovery.root);
  const commitSubjects = await readCommitSubjects(discovery.root, 30);

  const branchPattern = inferBranchPattern(branches);
  const commitConvention = inferCommitConvention(commitSubjects);
  const prReviewHits = policyInspected.filter((file) => /(pull request|review|approval|approver|code review|required reviewers?)/i.test(file.content));
  const protectedBranchHints = policyInspected.filter((file) => /(protected branch|force-push|force push|branch protection|required status checks|required checks)/i.test(file.content));
  const promotionHints = policyInspected.filter((file) => /(staging|production|promot|environment(s)?|release candidate|\brc\b)/i.test(file.content));
  const versionHints = releaseInspected.filter((file) => /(semantic release|semver|changeset|release(?! candidate)|version tag|tagged release)/i.test(file.content) || /(^|\/)(CHANGELOG\.md|\.changeset\/)/i.test(file.path));
  const featureFlagHints = policyInspected.filter((file) => /(feature[-_. ]?flag|launchdarkly|unleash|toggle)/i.test(file.content));
  const rollbackHints = policyInspected.filter((file) => /(rollback|revert|recover|restore)/i.test(file.content));

  return [
    makeArea(106, "Branch naming/workflow", branchPattern.status, `${branchPattern.finding}${buildRefreshNote(106, impactedAreaIds, noChange)}`, branchPattern.evidence, branchPattern.confidence),
    makeArea(107, "Commit message conventions", commitConvention.status, `${commitConvention.finding}${buildRefreshNote(107, impactedAreaIds, noChange)}`, commitConvention.evidence, commitConvention.confidence),
    makeArea(108, "Pull request conventions", prTemplateFiles.length > 0 || prReviewHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${prTemplateFiles.length > 0 ? `Pull request templates detected in ${prTemplateFiles.slice(0, 5).join(", ")}.` : prReviewHits.length > 0 ? `Pull request or review process guidance detected in ${prReviewHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No pull request convention evidence detected."}${buildRefreshNote(108, impactedAreaIds, noChange)}`, [
      ...prTemplateFiles.slice(0, 5).map((file) => ({ kind: "file" as const, path: file, detail: "pull request template" })),
      ...prReviewHits.slice(0, 5).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(pull request|review|approval|approver|code review)/i, "pull request guidance") })),
    ], prTemplateFiles.length > 0 || prReviewHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(109, "Review/approval requirements", prReviewHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${prReviewHits.length > 0 ? `Review or approval requirements are referenced in ${prReviewHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No explicit review or approval requirement evidence detected."}${buildRefreshNote(109, impactedAreaIds, noChange)}`, prReviewHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(approval|approver|review|required reviewers?)/i, "review/approval requirement") })), prReviewHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(110, "Protected branch/force-push rules", protectedBranchHints.length > 0 ? "INFERRED" : "NOT_DEFINED", `${protectedBranchHints.length > 0 ? `Protected branch or force-push guidance detected in ${protectedBranchHints.slice(0, 5).map((file) => file.path).join(", ")}.` : "No protected branch or force-push rule evidence detected."}${buildRefreshNote(110, impactedAreaIds, noChange)}`, protectedBranchHints.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(protected branch|force-push|force push|branch protection|required status checks|required checks)/i, "branch protection guidance") })), protectedBranchHints.length > 0 ? "MEDIUM" : undefined),
    makeArea(111, "Code ownership rules", codeownersFiles.length > 0 ? "DEFINED" : "NOT_DEFINED", `${codeownersFiles.length > 0 ? `CODEOWNERS files detected in ${codeownersFiles.join(", ")}.` : "No CODEOWNERS evidence detected."}${buildRefreshNote(111, impactedAreaIds, noChange)}`, codeownersFiles.map((file) => ({ kind: "file" as const, path: file, detail: "code ownership rules" })), codeownersFiles.length > 0 ? "HIGH" : undefined),
    makeArea(112, "Deployment model", deployFiles.length > 0 || discovery.dockerFiles.length > 0 ? "INFERRED" : "NOT_DEFINED", `${deployFiles.length > 0 || discovery.dockerFiles.length > 0 ? `Deployment-related configuration detected in ${(deployFiles.length > 0 ? deployFiles : discovery.dockerFiles).slice(0, 5).join(", ")}.` : "No deployment model evidence detected."}${buildRefreshNote(112, impactedAreaIds, noChange)}`, [
      ...deployFiles.slice(0, 6).map((file) => ({ kind: "file" as const, path: file, detail: "deployment configuration" })),
      ...discovery.dockerFiles.slice(0, 3).map((file) => ({ kind: "file" as const, path: file, detail: "container/runtime deployment artifact" })),
    ], deployFiles.length > 0 || discovery.dockerFiles.length > 0 ? "MEDIUM" : undefined),
    makeArea(113, "Environment promotion strategy", promotionHints.length > 0 ? "INFERRED" : "NOT_DEFINED", `${promotionHints.length > 0 ? `Environment promotion language detected in ${promotionHints.slice(0, 5).map((file) => file.path).join(", ")}.` : "No environment promotion strategy evidence detected."}${buildRefreshNote(113, impactedAreaIds, noChange)}`, promotionHints.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(staging|production|promot|environment(s)?|release candidate|rc\b)/i, "promotion/environment strategy") })), promotionHints.length > 0 ? "MEDIUM" : undefined),
    makeArea(114, "Versioning/release strategy", versionHints.length > 0 || commitConvention.kind === "conventional" ? "INFERRED" : "NOT_DEFINED", `${versionHints.length > 0 ? `Release or versioning evidence detected in ${versionHints.slice(0, 5).map((file) => file.path).join(", ")}.` : commitConvention.kind === "conventional" ? "Commit history suggests a conventional-commit-friendly release strategy." : "No release or versioning strategy evidence detected."}${buildRefreshNote(114, impactedAreaIds, noChange)}`, [
      ...versionHints.slice(0, 6).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(version|semantic release|semver|changeset|release)/i, "release/version strategy") })),
      ...commitConvention.kind === "conventional" ? [{ kind: "pattern" as const, detail: "commit subjects resemble conventional commits" }] : [],
    ], versionHints.length > 0 || commitConvention.kind === "conventional" ? "MEDIUM" : undefined),
    makeArea(115, "Feature flag/release-control strategy", featureFlagHints.length > 0 ? "INFERRED" : "NOT_DEFINED", `${featureFlagHints.length > 0 ? `Feature flag or release-control evidence detected in ${featureFlagHints.slice(0, 5).map((file) => file.path).join(", ")}.` : "No feature flag or release-control strategy evidence detected."}${buildRefreshNote(115, impactedAreaIds, noChange)}`, featureFlagHints.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(feature[-_. ]?flag|launchdarkly|unleash|toggle)/i, "feature flag or release control") })), featureFlagHints.length > 0 ? "MEDIUM" : undefined),
    makeArea(116, "Rollback/recovery strategy", rollbackHints.length > 0 ? "INFERRED" : "NOT_DEFINED", `${rollbackHints.length > 0 ? `Rollback or recovery guidance detected in ${rollbackHints.slice(0, 5).map((file) => file.path).join(", ")}.` : "No rollback or recovery strategy evidence detected."}${buildRefreshNote(116, impactedAreaIds, noChange)}`, rollbackHints.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(rollback|revert|recover|restore)/i, "rollback/recovery guidance") })), rollbackHints.length > 0 ? "MEDIUM" : undefined),
  ];
}

async function inspectFiles(root: string, files: string[]): Promise<Array<{ path: string; content: string }>> {
  const results = await Promise.all(files.map(async (file) => {
    try {
      const content = await fs.readFile(path.join(root, file), "utf8");
      return { path: file, content };
    } catch {
      return undefined;
    }
  }));
  return results.filter((value): value is { path: string; content: string } => Boolean(value));
}

async function readLocalBranches(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--format=%(refname:short)"], { cwd: root, windowsHide: true });
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function readCommitSubjects(root: string, count: number): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["log", `-n`, String(count), "--pretty=%s"], { cwd: root, windowsHide: true });
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function inferBranchPattern(branches: string[]): {
  status: ConstitutionArea["status"];
  finding: string;
  evidence: ConstitutionEvidence[];
  confidence?: ConstitutionArea["confidence"];
} {
  const nonMain = branches.filter((branch) => branch !== "main" && branch !== "master");
  const taskLike = nonMain.filter((branch) => /task|feature|fix|prototype|create-/i.test(branch));
  if (taskLike.length > 0) {
    return {
      status: "INFERRED",
      finding: `Branch names suggest a task- or feature-oriented workflow, e.g. ${taskLike.slice(0, 5).join(", ")}.`,
      evidence: taskLike.slice(0, 5).map((branch) => ({ kind: "pattern", detail: `branch: ${branch}` })),
      confidence: "MEDIUM",
    };
  }
  if (branches.length > 0) {
    return {
      status: "INFERRED",
      finding: `Local branches exist, but a strong repository-wide naming convention is not obvious from ${branches.slice(0, 5).join(", ")}.`,
      evidence: branches.slice(0, 5).map((branch) => ({ kind: "pattern", detail: `branch: ${branch}` })),
      confidence: "LOW",
    };
  }
  return {
    status: "NOT_DEFINED",
    finding: "No branch naming evidence could be extracted from local refs.",
    evidence: [],
  };
}

function inferCommitConvention(subjects: string[]): {
  kind: "conventional" | "freeform" | "unknown";
  status: ConstitutionArea["status"];
  finding: string;
  evidence: ConstitutionEvidence[];
  confidence?: ConstitutionArea["confidence"];
} {
  if (subjects.length === 0) {
    return {
      kind: "unknown",
      status: "NOT_DEFINED",
      finding: "No commit history was available to infer commit message conventions.",
      evidence: [],
    };
  }
  const conventional = subjects.filter((subject) => /^(feat|fix|chore|docs|refactor|test|build|ci)(\(.+\))?:\s+/i.test(subject));
  if (conventional.length >= Math.max(2, Math.ceil(subjects.length / 3))) {
    return {
      kind: "conventional",
      status: "INFERRED",
      finding: `Recent commit subjects suggest a conventional commit style, e.g. ${conventional.slice(0, 4).join(" | ")}.`,
      evidence: conventional.slice(0, 4).map((subject) => ({ kind: "pattern", detail: `commit: ${subject}` })),
      confidence: "MEDIUM",
    };
  }
  return {
    kind: "freeform",
    status: "INFERRED",
    finding: `Recent commit subjects appear free-form, e.g. ${subjects.slice(0, 4).join(" | ")}.`,
    evidence: subjects.slice(0, 4).map((subject) => ({ kind: "pattern", detail: `commit: ${subject}` })),
    confidence: "LOW",
  };
}

function summarizeMatch(content: string, pattern: RegExp, fallback: string): string {
  const match = pattern.exec(content);
  return match?.[0] ?? fallback;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
