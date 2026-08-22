import fs from "node:fs/promises";
import path from "node:path";
import type { ConstitutionArea, ConstitutionEvidence } from "../types.js";
import type { ConstitutionEvaluationContext } from "./shared.js";
import { buildRefreshNote, makeArea } from "./shared.js";

export async function evaluateApiAreas(context: ConstitutionEvaluationContext): Promise<ConstitutionArea[]> {
  const { discovery, impactedAreaIds, noChange } = context;
  if (discovery.apiFiles.length === 0) {
    return [
      makeArea(40, "API style/protocols", "NOT_APPLICABLE", `No API files detected.${buildRefreshNote(40, impactedAreaIds, noChange)}`, []),
      makeArea(41, "Route/endpoint organization", "NOT_APPLICABLE", `No route or endpoint files detected.${buildRefreshNote(41, impactedAreaIds, noChange)}`, []),
      makeArea(42, "API versioning", "NOT_DEFINED", `No API versioning evidence detected.${buildRefreshNote(42, impactedAreaIds, noChange)}`, []),
      makeArea(43, "Request validation", "NOT_DEFINED", `No request validation evidence detected.${buildRefreshNote(43, impactedAreaIds, noChange)}`, []),
      makeArea(44, "Response contracts", "NOT_DEFINED", `No response contract evidence detected.${buildRefreshNote(44, impactedAreaIds, noChange)}`, []),
      makeArea(45, "Error response format", "NOT_DEFINED", `No API error format evidence detected.${buildRefreshNote(45, impactedAreaIds, noChange)}`, []),
      makeArea(46, "Pagination/filtering conventions", "NOT_DEFINED", `No pagination or filtering evidence detected.${buildRefreshNote(46, impactedAreaIds, noChange)}`, []),
      makeArea(47, "Idempotency/rate-limit contract handling", "NOT_DEFINED", `No idempotency or rate-limit evidence detected.${buildRefreshNote(47, impactedAreaIds, noChange)}`, []),
    ];
  }

  const inspected = await inspectApiFiles(discovery.root, discovery.apiFiles.slice(0, 40));
  const openApiFiles = discovery.apiFiles.filter((file) => /(openapi|swagger)\.(json|ya?ml)$/i.test(file));
  const routeFiles = discovery.apiFiles.filter((file) => /(^|\/)(api|routes?)\//.test(file));

  const protocolEvidence: ConstitutionEvidence[] = [];
  if (openApiFiles.length > 0) {
    protocolEvidence.push(...openApiFiles.slice(0, 5).map((file) => ({ kind: "file" as const, path: file, detail: "OpenAPI/Swagger specification" })));
  }
  if (routeFiles.length > 0) {
    protocolEvidence.push(...routeFiles.slice(0, 5).map((file) => ({ kind: "file" as const, path: file, detail: "route or API file" })));
  }

  const validationMatches = inspected.filter((file) => /(zod|yup|joi|valibot|schema\.parse|safeParse|request\.body|req\.body)/i.test(file.content));
  const responseMatches = inspected.filter((file) => /(res\.json|return\s+json\(|NextResponse\.json|reply\.send|response_model|openapi)/i.test(file.content));
  const errorMatches = inspected.filter((file) => /(status\((4\d\d|5\d\d)\)|HTTPException|createError|errorCode|error:\s*\{|problem\+json)/i.test(file.content));
  const paginationMatches = inspected.filter((file) => /(pageSize|page\b|cursor|limit\b|offset\b|sort\b|filter\b)/i.test(file.content));
  const idempotencyMatches = inspected.filter((file) => /(idempotency|rateLimit|rate-limit|throttle|retry-after)/i.test(file.content));
  const versionMatches = [
    ...discovery.apiFiles.filter((file) => /\/v\d+\//i.test(file) || /version/i.test(path.basename(file))),
    ...inspected.filter((file) => /(\/v\d+\/|version[:=]|apiVersion)/i.test(file.content)).map((file) => file.path),
  ];

  const apiStyleStatus = openApiFiles.length > 0 || routeFiles.length > 0 ? "DEFINED" : "INFERRED";
  const apiStyleFinding = openApiFiles.length > 0
    ? `HTTP-style API evidence detected with route files and explicit specification files such as ${openApiFiles.slice(0, 3).join(", ")}.${buildRefreshNote(40, impactedAreaIds, noChange)}`
    : `API protocol is inferred from route-oriented source files such as ${routeFiles.slice(0, 3).join(", ") || "detected API files"}.${buildRefreshNote(40, impactedAreaIds, noChange)}`;

  return [
    makeArea(40, "API style/protocols", apiStyleStatus, apiStyleFinding, protocolEvidence, openApiFiles.length > 0 ? "HIGH" : "MEDIUM"),
    makeArea(41, "Route/endpoint organization", routeFiles.length > 0 ? "DEFINED" : "UNCERTAIN", `${routeFiles.length > 0 ? `Detected ${routeFiles.length} route/API files organized under route-oriented paths.` : "API files exist, but route organization is not explicit from file paths."}${buildRefreshNote(41, impactedAreaIds, noChange)}`, routeFiles.slice(0, 8).map((file) => ({ kind: "file" as const, path: file, detail: "route organization" })), routeFiles.length > 0 ? "HIGH" : "LOW"),
    makeArea(42, "API versioning", versionMatches.length > 0 ? "INFERRED" : "NOT_DEFINED", `${versionMatches.length > 0 ? `Versioning evidence detected in ${dedupe(versionMatches).slice(0, 5).join(", ")}.` : "No explicit API versioning evidence detected in file paths or inspected route content."}${buildRefreshNote(42, impactedAreaIds, noChange)}`, dedupe(versionMatches).slice(0, 8).map((file) => ({ kind: "file" as const, path: file, detail: "API versioning evidence" })), versionMatches.length > 0 ? "MEDIUM" : undefined),
    makeArea(43, "Request validation", validationMatches.length > 0 ? "INFERRED" : "NOT_DEFINED", `${validationMatches.length > 0 ? `Request validation patterns detected in ${validationMatches.slice(0, 5).map((file) => file.path).join(", ")}.` : "No explicit request validation patterns detected in inspected API files."}${buildRefreshNote(43, impactedAreaIds, noChange)}`, validationMatches.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(zod|yup|joi|valibot|schema\.parse|safeParse|request\.body|req\.body)/i, "request validation pattern") })), validationMatches.length > 0 ? "MEDIUM" : undefined),
    makeArea(44, "Response contracts", responseMatches.length > 0 || openApiFiles.length > 0 ? "INFERRED" : "NOT_DEFINED", `${responseMatches.length > 0 || openApiFiles.length > 0 ? `Response contract evidence detected via response serialization or schema files.` : "No explicit response contract evidence detected."}${buildRefreshNote(44, impactedAreaIds, noChange)}`, [
      ...responseMatches.slice(0, 5).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(res\.json|return\s+json\(|NextResponse\.json|reply\.send|response_model)/i, "response serialization pattern") })),
      ...openApiFiles.slice(0, 3).map((file) => ({ kind: "file" as const, path: file, detail: "schema contract file" })),
    ], responseMatches.length > 0 || openApiFiles.length > 0 ? "MEDIUM" : undefined),
    makeArea(45, "Error response format", errorMatches.length > 0 ? "INFERRED" : "NOT_DEFINED", `${errorMatches.length > 0 ? `Error response handling patterns detected in ${errorMatches.slice(0, 5).map((file) => file.path).join(", ")}.` : "No explicit API error response format evidence detected."}${buildRefreshNote(45, impactedAreaIds, noChange)}`, errorMatches.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(status\((4\d\d|5\d\d)\)|HTTPException|createError|errorCode|error:\s*\{|problem\+json)/i, "error handling pattern") })), errorMatches.length > 0 ? "MEDIUM" : undefined),
    makeArea(46, "Pagination/filtering conventions", paginationMatches.length > 0 ? "INFERRED" : "NOT_DEFINED", `${paginationMatches.length > 0 ? `Pagination or filtering parameters detected in ${paginationMatches.slice(0, 5).map((file) => file.path).join(", ")}.` : "No pagination/filtering evidence detected in inspected API files."}${buildRefreshNote(46, impactedAreaIds, noChange)}`, paginationMatches.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(pageSize|page\b|cursor|limit\b|offset\b|sort\b|filter\b)/i, "pagination/filtering pattern") })), paginationMatches.length > 0 ? "MEDIUM" : undefined),
    makeArea(47, "Idempotency/rate-limit contract handling", idempotencyMatches.length > 0 ? "INFERRED" : "NOT_DEFINED", `${idempotencyMatches.length > 0 ? `Idempotency or rate-limit handling evidence detected in ${idempotencyMatches.slice(0, 5).map((file) => file.path).join(", ")}.` : "No idempotency or rate-limit contract evidence detected in inspected API files."}${buildRefreshNote(47, impactedAreaIds, noChange)}`, idempotencyMatches.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(idempotency|rateLimit|rate-limit|throttle|retry-after)/i, "idempotency/rate-limit pattern") })), idempotencyMatches.length > 0 ? "MEDIUM" : undefined),
  ];
}

async function inspectApiFiles(root: string, files: string[]): Promise<Array<{ path: string; content: string }>> {
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
