import fs from "node:fs/promises";
import path from "node:path";
import type { ConstitutionArea } from "../types.js";
import type { ConstitutionEvaluationContext } from "./shared.js";
import { buildRefreshNote, makeArea } from "./shared.js";

export async function evaluateObservabilityAreas(context: ConstitutionEvaluationContext): Promise<ConstitutionArea[]> {
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

  const loggingHits = inspected.filter((file) => /(logger|console\.log|log\(|structured log|pino|winston)/i.test(file.content));
  const logLevelHits = inspected.filter((file) => /(log level|debug|info|warn|error|trace)/i.test(file.content));
  const traceIdHits = inspected.filter((file) => /(traceId|requestId|correlationId|spanId)/i.test(file.content));
  const metricsHits = inspected.filter((file) => /(metric|metrics|prometheus|telemetry|histogram|counter|gauge)/i.test(file.content));
  const tracingHits = inspected.filter((file) => /(opentelemetry|otel|trace\(|span\(|distributed tracing)/i.test(file.content));
  const alertHits = inspected.filter((file) => /(alert|monitor|monitoring|pagerduty|incident|on-call)/i.test(file.content));
  const cacheHits = inspected.filter((file) => /(cache|redis|memoiz|lru)/i.test(file.content));
  const asyncHits = inspected.filter((file) => /(queue|worker|background|job\b|bull|cron)/i.test(file.content));
  const payloadHits = inspected.filter((file) => /(payload|upload|multipart|body size|maxBody|limit\b)/i.test(file.content));
  const poolingHits = inspected.filter((file) => /(pool|connection pool|maxConnections|keepAlive)/i.test(file.content));
  const perfHits = inspected.filter((file) => /(benchmark|profil|performance.now|measure|perf)/i.test(file.content));
  const concurrencyHits = inspected.filter((file) => /(parallel|concurrency|maxParallel|max parallel|throttle|batch)/i.test(file.content));

  return [
    makeArea(94, "Logging format/conventions", loggingHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${loggingHits.length > 0 ? `Logging patterns detected in ${loggingHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No logging format or convention evidence detected."}${buildRefreshNote(94, impactedAreaIds, noChange)}`, loggingHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(logger|console\.log|log\(|structured log|pino|winston)/i, "logging pattern") })), loggingHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(95, "Log levels and production logging", logLevelHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${logLevelHits.length > 0 ? `Log-level or severity language detected in ${logLevelHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No log-level or production logging evidence detected."}${buildRefreshNote(95, impactedAreaIds, noChange)}`, logLevelHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(log level|debug|info|warn|error|trace)/i, "log-level pattern") })), logLevelHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(96, "Request/trace/correlation IDs", traceIdHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${traceIdHits.length > 0 ? `Trace or correlation identifier patterns detected in ${traceIdHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No request/trace/correlation ID evidence detected."}${buildRefreshNote(96, impactedAreaIds, noChange)}`, traceIdHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(traceId|requestId|correlationId|spanId)/i, "trace/correlation identifier") })), traceIdHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(97, "Metrics instrumentation", metricsHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${metricsHits.length > 0 ? `Metrics instrumentation patterns detected in ${metricsHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No metrics instrumentation evidence detected."}${buildRefreshNote(97, impactedAreaIds, noChange)}`, metricsHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(metric|metrics|prometheus|telemetry|histogram|counter|gauge)/i, "metrics pattern") })), metricsHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(98, "Distributed tracing", tracingHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${tracingHits.length > 0 ? `Tracing instrumentation patterns detected in ${tracingHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No distributed tracing evidence detected."}${buildRefreshNote(98, impactedAreaIds, noChange)}`, tracingHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(opentelemetry|otel|trace\(|span\(|distributed tracing)/i, "tracing pattern") })), tracingHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(99, "Alerting/operational monitoring", alertHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${alertHits.length > 0 ? `Operational monitoring or alerting language detected in ${alertHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No alerting or operational monitoring evidence detected."}${buildRefreshNote(99, impactedAreaIds, noChange)}`, alertHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(alert|monitor|monitoring|pagerduty|incident|on-call)/i, "alerting/monitoring pattern") })), alertHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(100, "Caching strategy", cacheHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${cacheHits.length > 0 ? `Caching-related patterns detected in ${cacheHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No caching strategy evidence detected."}${buildRefreshNote(100, impactedAreaIds, noChange)}`, cacheHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(cache|redis|memoiz|lru)/i, "cache pattern") })), cacheHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(101, "Async/background work", asyncHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${asyncHits.length > 0 ? `Async or background-work patterns detected in ${asyncHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No async or background work evidence detected."}${buildRefreshNote(101, impactedAreaIds, noChange)}`, asyncHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(queue|worker|background|job\b|bull|cron)/i, "async/background work pattern") })), asyncHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(102, "Payload/upload size controls", payloadHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${payloadHits.length > 0 ? `Payload or upload size control patterns detected in ${payloadHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No payload or upload size control evidence detected."}${buildRefreshNote(102, impactedAreaIds, noChange)}`, payloadHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(payload|upload|multipart|body size|maxBody|limit\b)/i, "payload/upload control") })), payloadHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(103, "Connection/resource pooling", poolingHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${poolingHits.length > 0 ? `Pooling or connection-resource patterns detected in ${poolingHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No connection or resource pooling evidence detected."}${buildRefreshNote(103, impactedAreaIds, noChange)}`, poolingHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(pool|connection pool|maxConnections|keepAlive)/i, "pooling/resource pattern") })), poolingHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(104, "Performance profiling/benchmarking", perfHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${perfHits.length > 0 ? `Performance profiling or benchmarking patterns detected in ${perfHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No performance profiling or benchmarking evidence detected."}${buildRefreshNote(104, impactedAreaIds, noChange)}`, perfHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(benchmark|profil|performance.now|measure|perf)/i, "profiling/benchmarking pattern") })), perfHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(105, "Scalability/concurrency conventions", concurrencyHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${concurrencyHits.length > 0 ? `Concurrency or scalability-oriented patterns detected in ${concurrencyHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No scalability or concurrency convention evidence detected."}${buildRefreshNote(105, impactedAreaIds, noChange)}`, concurrencyHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(parallel|concurrency|maxParallel|max parallel|throttle|batch)/i, "concurrency/scalability pattern") })), concurrencyHits.length > 0 ? "MEDIUM" : undefined),
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
