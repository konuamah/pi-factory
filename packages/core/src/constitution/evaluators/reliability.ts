import fs from "node:fs/promises";
import path from "node:path";
import type { ConstitutionArea } from "../types.js";
import type { ConstitutionEvaluationContext } from "./shared.js";
import { buildRefreshNote, makeArea } from "./shared.js";

export async function evaluateReliabilityAreas(context: ConstitutionEvaluationContext): Promise<ConstitutionArea[]> {
  const { discovery, impactedAreaIds, noChange } = context;
  const candidateFiles = dedupe([
    ...discovery.sourceFiles,
    ...discovery.apiFiles,
    ...discovery.scriptFiles,
    ...discovery.docsFiles,
    ...discovery.manifests,
    ...discovery.ciFiles,
  ]).filter((file) =>
    /\.(ts|tsx|md|json|ya?ml)$/i.test(file) &&
    !/packages\/core\/src\/constitution\//i.test(file) &&
    !/^CONSTITUTION\.md$/i.test(file) &&
    !/^constitution_.*\.md$/i.test(file),
  ).slice(0, 80);
  const inspected = await inspectFiles(discovery.root, candidateFiles);

  const errorHits = inspected.filter((file) => /(try\s*\{|catch\s*\(|throw new Error|Error\(|status\((4\d\d|5\d\d)\)|problem\+json)/i.test(file.content));
  const timeoutHits = inspected.filter((file) => /(timeout|AbortSignal|abort\(|signal\s*:|setTimeout\()/i.test(file.content));
  const retryHits = inspected.filter((file) => /(retry|backoff|maxAttempts|attempt\b|retry-after)/i.test(file.content));
  const circuitHits = inspected.filter((file) => /(circuit breaker|bulkhead|failure isolation|isolated workspace)/i.test(file.content));
  const fallbackHits = inspected.filter((file) => /(fallback|graceful degrad|working in place|recover from|resume recovery)/i.test(file.content));
  const healthHits = inspected.filter((file) => /(health check|readiness|liveness|doctor|diagnostic)/i.test(file.content));
  const idempotentHits = inspected.filter((file) => /(idempotent|idempotency|replay safe|dedupe|resume event)/i.test(file.content));

  return [
    makeArea(56, "Error handling conventions", errorHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${errorHits.length > 0 ? `Error handling patterns detected in ${errorHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No error handling convention evidence detected."}${buildRefreshNote(56, impactedAreaIds, noChange)}`, errorHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(try\s*\{|catch\s*\(|throw new Error|Error\(|status\((4\d\d|5\d\d)\)|problem\+json)/i, "error handling pattern") })), errorHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(57, "Timeout conventions", timeoutHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${timeoutHits.length > 0 ? `Timeout or abort-control patterns detected in ${timeoutHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No timeout convention evidence detected."}${buildRefreshNote(57, impactedAreaIds, noChange)}`, timeoutHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(timeout|AbortSignal|abort\(|signal\s*:|setTimeout\()/i, "timeout/abort pattern") })), timeoutHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(58, "Retry/backoff policy", retryHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${retryHits.length > 0 ? `Retry or backoff patterns detected in ${retryHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No retry or backoff policy evidence detected."}${buildRefreshNote(58, impactedAreaIds, noChange)}`, retryHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(retry|backoff|maxAttempts|attempt\b|retry-after)/i, "retry/backoff pattern") })), retryHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(59, "Circuit-breaking/failure isolation", circuitHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${circuitHits.length > 0 ? `Failure-isolation or circuit-breaker patterns detected in ${circuitHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No circuit-breaking or failure-isolation evidence detected."}${buildRefreshNote(59, impactedAreaIds, noChange)}`, circuitHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(circuit breaker|bulkhead|failure isolation|isolated workspace)/i, "failure isolation pattern") })), circuitHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(60, "Graceful degradation/fallbacks", fallbackHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${fallbackHits.length > 0 ? `Fallback or graceful-degradation language detected in ${fallbackHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No graceful degradation or fallback evidence detected."}${buildRefreshNote(60, impactedAreaIds, noChange)}`, fallbackHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(fallback|graceful degrad|working in place|recover from|resume recovery)/i, "fallback/graceful degradation pattern") })), fallbackHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(61, "Health/readiness/liveness checks", healthHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${healthHits.length > 0 ? `Health, readiness, liveness, or diagnostic checks are referenced in ${healthHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No health/readiness/liveness check evidence detected."}${buildRefreshNote(61, impactedAreaIds, noChange)}`, healthHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(health check|readiness|liveness|doctor|diagnostic)/i, "health/readiness/liveness pattern") })), healthHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(62, "Idempotent operation handling", idempotentHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${idempotentHits.length > 0 ? `Idempotency or replay-safe operation patterns detected in ${idempotentHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No idempotent operation handling evidence detected."}${buildRefreshNote(62, impactedAreaIds, noChange)}`, idempotentHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(idempotent|idempotency|replay safe|dedupe|resume event)/i, "idempotency/replay-safety pattern") })), idempotentHits.length > 0 ? "MEDIUM" : undefined),
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

function summarizeMatch(content: string, pattern: RegExp, fallback: string): string {
  const match = pattern.exec(content);
  return match?.[0] ?? fallback;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
