import fs from "node:fs/promises";
import path from "node:path";
import type { ConstitutionArea } from "../types.js";
import type { ConstitutionEvaluationContext } from "./shared.js";
import { buildRefreshNote, makeArea } from "./shared.js";

export async function evaluateTestingAreas(context: ConstitutionEvaluationContext): Promise<ConstitutionArea[]> {
  const { discovery, impactedAreaIds, noChange } = context;
  if (discovery.testFiles.length === 0) {
    return [
      makeArea(74, "Unit test conventions", "NOT_DEFINED", `No unit test conventions detected.${buildRefreshNote(74, impactedAreaIds, noChange)}`, []),
      makeArea(75, "Integration test conventions", "NOT_DEFINED", `No integration test conventions detected.${buildRefreshNote(75, impactedAreaIds, noChange)}`, []),
      makeArea(76, "End-to-end test conventions", "NOT_DEFINED", `No end-to-end test conventions detected.${buildRefreshNote(76, impactedAreaIds, noChange)}`, []),
      makeArea(77, "Test naming/location conventions", "NOT_DEFINED", `No test naming or location conventions detected.${buildRefreshNote(77, impactedAreaIds, noChange)}`, []),
      makeArea(78, "Mock/fake/test-double strategy", "NOT_DEFINED", `No mock, fake, or test-double strategy evidence detected.${buildRefreshNote(78, impactedAreaIds, noChange)}`, []),
      makeArea(79, "Test data/factory/fixture strategy", "NOT_DEFINED", `No test data, factory, or fixture strategy evidence detected.${buildRefreshNote(79, impactedAreaIds, noChange)}`, []),
      makeArea(80, "Coverage/flaky-test/quality gates", "NOT_DEFINED", `No coverage, flaky-test, or test quality-gate evidence detected.${buildRefreshNote(80, impactedAreaIds, noChange)}`, []),
    ];
  }

  const inspected = await inspectTestFiles(discovery.root, discovery.testFiles.slice(0, 50));
  const unitFiles = discovery.testFiles.filter((file) => /(unit|\.test\.|\.spec\.)/i.test(file) && !/(integration|e2e|playwright|cypress)/i.test(file));
  const integrationFiles = discovery.testFiles.filter((file) => /(integration|int\.)/i.test(file));
  const e2eFiles = discovery.testFiles.filter((file) => /(e2e|playwright|cypress)/i.test(file));
  const mockHits = inspected.filter((file) => /(mock|fake|stub|spyOn|jest\.mock|vi\.mock|test double)/i.test(file.content));
  const fixtureHits = inspected.filter((file) => /(fixture|factory|seed data|test data)/i.test(file.content));
  const qualityHits = [
    ...discovery.ciFiles.filter((file) => /coverage/i.test(file)),
    ...discovery.trackedFiles.filter((file) => /(coverage|nyc|vitest|jest|playwright|cypress)\.(config|setup)|codecov/i.test(file)),
  ];
  const qualityContentHits = inspected.filter((file) => /(coverage|flaky|retry|threshold|quality gate|codecov)/i.test(file.content));

  return [
    makeArea(74, "Unit test conventions", unitFiles.length > 0 ? "INFERRED" : "NOT_DEFINED", `${unitFiles.length > 0 ? `Unit-style tests detected in ${unitFiles.slice(0, 5).join(", ")}.` : "No unit test conventions detected from file names."}${buildRefreshNote(74, impactedAreaIds, noChange)}`, unitFiles.slice(0, 8).map((file) => ({ kind: "file" as const, path: file, detail: "unit-style test" })), unitFiles.length > 0 ? "MEDIUM" : undefined),
    makeArea(75, "Integration test conventions", integrationFiles.length > 0 ? "INFERRED" : "NOT_DEFINED", `${integrationFiles.length > 0 ? `Integration-style tests detected in ${integrationFiles.slice(0, 5).join(", ")}.` : "No integration test conventions detected from file names."}${buildRefreshNote(75, impactedAreaIds, noChange)}`, integrationFiles.slice(0, 8).map((file) => ({ kind: "file" as const, path: file, detail: "integration-style test" })), integrationFiles.length > 0 ? "MEDIUM" : undefined),
    makeArea(76, "End-to-end test conventions", e2eFiles.length > 0 ? "INFERRED" : "NOT_DEFINED", `${e2eFiles.length > 0 ? `End-to-end or browser test evidence detected in ${e2eFiles.slice(0, 5).join(", ")}.` : "No end-to-end test conventions detected from file names."}${buildRefreshNote(76, impactedAreaIds, noChange)}`, e2eFiles.slice(0, 8).map((file) => ({ kind: "file" as const, path: file, detail: "e2e/browser test" })), e2eFiles.length > 0 ? "MEDIUM" : undefined),
    makeArea(77, "Test naming/location conventions", discovery.testFiles.length > 0 ? "DEFINED" : "NOT_DEFINED", `Tests are organized using detected naming/location patterns such as ${discovery.testFiles.slice(0, 5).join(", ")}.${buildRefreshNote(77, impactedAreaIds, noChange)}`, discovery.testFiles.slice(0, 8).map((file) => ({ kind: "file" as const, path: file, detail: "test naming/location" })), discovery.testFiles.length > 0 ? "HIGH" : undefined),
    makeArea(78, "Mock/fake/test-double strategy", mockHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${mockHits.length > 0 ? `Mock/fake/test-double patterns detected in ${mockHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No mock, fake, or test-double strategy evidence detected."}${buildRefreshNote(78, impactedAreaIds, noChange)}`, mockHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(mock|fake|stub|spyOn|jest\.mock|vi\.mock|test double)/i, "mock/fake pattern") })), mockHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(79, "Test data/factory/fixture strategy", fixtureHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${fixtureHits.length > 0 ? `Fixture/factory/test-data patterns detected in ${fixtureHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No test data, factory, or fixture strategy evidence detected."}${buildRefreshNote(79, impactedAreaIds, noChange)}`, fixtureHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(fixture|factory|seed data|test data)/i, "fixture/factory pattern") })), fixtureHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(80, "Coverage/flaky-test/quality gates", qualityHits.length > 0 || qualityContentHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${qualityHits.length > 0 || qualityContentHits.length > 0 ? "Coverage or test quality-gate evidence detected in repository files." : "No coverage, flaky-test, or test quality-gate evidence detected."}${buildRefreshNote(80, impactedAreaIds, noChange)}`, [
      ...qualityHits.slice(0, 6).map((file) => ({ kind: "file" as const, path: file, detail: "coverage/quality-gate file" })),
      ...qualityContentHits.slice(0, 6).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(coverage|flaky|retry|threshold|quality gate|codecov)/i, "coverage/quality-gate pattern") })),
    ], qualityHits.length > 0 || qualityContentHits.length > 0 ? "MEDIUM" : undefined),
  ];
}

async function inspectTestFiles(root: string, files: string[]): Promise<Array<{ path: string; content: string }>> {
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

function summarizeMatch(content: string, pattern: RegExp, fallback: string): string {
  const match = pattern.exec(content);
  return match?.[0] ?? fallback;
}
