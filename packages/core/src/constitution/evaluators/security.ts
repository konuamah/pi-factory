import fs from "node:fs/promises";
import path from "node:path";
import type { ConstitutionArea } from "../types.js";
import type { ConstitutionEvaluationContext } from "./shared.js";
import { buildRefreshNote, makeArea } from "./shared.js";

export async function evaluateSecurityAreas(context: ConstitutionEvaluationContext): Promise<ConstitutionArea[]> {
  const { discovery, impactedAreaIds, noChange } = context;
  const candidateFiles = dedupe([
    ...discovery.apiFiles,
    ...discovery.sourceFiles,
    ...discovery.docsFiles,
    ...discovery.ciFiles,
    ...discovery.manifests,
    ...discovery.envFiles,
  ]).filter((file) =>
    !/package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$/i.test(file) &&
    !/packages\/core\/src\/constitution\//i.test(file) &&
    !/\.d\.ts$/i.test(file) &&
    !/\.js$/i.test(file) &&
    !/^CONSTITUTION\.md$/i.test(file) &&
    !/^constitution_.*\.md$/i.test(file),
  ).slice(0, 60);
  const inspected = await inspectFiles(discovery.root, candidateFiles);

  const authHits = inspected.filter((file) => /(authenticate|authentication|\bauth\b|jwt|oauth|oidc|bearer|signin|login|access token|refresh token)/i.test(file.content));
  const authzHits = inspected.filter((file) => /(authorize|authorization|access control|rbac|acl|allowlist|denylist)/i.test(file.content));
  const validationHits = inspected.filter((file) => /(zod|yup|joi|valibot|sanitize|validator|safeParse|schema\.parse|escapeHtml)/i.test(file.content));
  const xssHits = inspected.filter((file) => /(content-security-policy|x-xss-protection|sanitize|escapeHtml|trustedTypes|dangerouslySetInnerHTML)/i.test(file.content));
  const browserSecurityHits = inspected.filter((file) => /(cors|csrf|sameSite|helmet|x-frame-options|strict-transport-security|content-security-policy)/i.test(file.content));
  const secretsHits = inspected.filter((file) => /(gitleaks|secret scanning|secrets? scan|detect-secrets|vault|1password|doppler)/i.test(file.content));
  const depScanHits = inspected.filter((file) => /(snyk|npm audit|dependabot|osv|trivy|grype|dependency review)/i.test(file.content));
  const staticSecurityHits = inspected.filter((file) => /(codeql|semgrep|bandit|brakeman|security analysis|static analysis)/i.test(file.content));
  const encryptionHits = inspected.filter((file) => /(https:\/\/|\btls\b|\bencrypt(?:ion)?\b|certificate|strict-transport-security)/i.test(file.content));
  const networkHeaderHits = inspected.filter((file) => /(x-frame-options|content-security-policy|strict-transport-security|x-content-type-options|trusted proxy|trust proxy)/i.test(file.content));

  return [
    makeArea(63, "Authentication approach", authHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${authHits.length > 0 ? `Authentication-related patterns detected in ${authHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No authentication approach evidence detected."}${buildRefreshNote(63, impactedAreaIds, noChange)}`, authHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(authenticate|authentication|\bauth\b|jwt|oauth|oidc|bearer|signin|login|access token|refresh token)/i, "authentication pattern") })), authHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(64, "Authorization/permission model", authzHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${authzHits.length > 0 ? `Authorization or access-control patterns detected in ${authzHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No authorization or permission model evidence detected."}${buildRefreshNote(64, impactedAreaIds, noChange)}`, authzHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(authorize|authorization|access control|rbac|acl|allowlist|denylist)/i, "authorization pattern") })), authzHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(65, "Input validation/sanitization", validationHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${validationHits.length > 0 ? `Validation or sanitization patterns detected in ${validationHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No input validation or sanitization evidence detected."}${buildRefreshNote(65, impactedAreaIds, noChange)}`, validationHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(zod|yup|joi|valibot|sanitize|validator|safeParse|schema\.parse|escapeHtml)/i, "validation/sanitization pattern") })), validationHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(66, "Output encoding/XSS controls", xssHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${xssHits.length > 0 ? `Output encoding or XSS-control evidence detected in ${xssHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No output encoding or XSS-control evidence detected."}${buildRefreshNote(66, impactedAreaIds, noChange)}`, xssHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(content-security-policy|x-xss-protection|sanitize|escapeHtml|trustedTypes|dangerouslySetInnerHTML)/i, "XSS/output-encoding control") })), xssHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(67, "CSRF/CORS/browser security controls", browserSecurityHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${browserSecurityHits.length > 0 ? `Browser-security controls detected in ${browserSecurityHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No CSRF, CORS, or browser-security control evidence detected."}${buildRefreshNote(67, impactedAreaIds, noChange)}`, browserSecurityHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(cors|csrf|sameSite|helmet|x-frame-options|strict-transport-security|content-security-policy)/i, "browser-security control") })), browserSecurityHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(68, "Secrets scanning/storage", secretsHits.length > 0 || discovery.envFiles.length > 0 ? (secretsHits.length > 0 ? "INFERRED" : "UNCERTAIN") : "NOT_DEFINED", `${secretsHits.length > 0 ? `Secrets scanning or storage tooling detected in ${secretsHits.slice(0, 5).map((file) => file.path).join(", ")}.` : discovery.envFiles.length > 0 ? `Environment files exist (${discovery.envFiles.slice(0, 5).join(", ")}), but dedicated secrets scanning/storage controls are not explicit.` : "No secrets scanning or storage evidence detected."}${buildRefreshNote(68, impactedAreaIds, noChange)}`, [
      ...secretsHits.slice(0, 6).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(gitleaks|secret scanning|secrets? scan|detect-secrets|vault|1password|doppler)/i, "secrets scanning/storage") })),
      ...discovery.envFiles.slice(0, 3).map((file) => ({ kind: "file" as const, path: file, detail: "environment file with potential secret usage" })),
    ], secretsHits.length > 0 ? "MEDIUM" : discovery.envFiles.length > 0 ? "LOW" : undefined),
    makeArea(69, "Dependency/SCA security scanning", depScanHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${depScanHits.length > 0 ? `Dependency security scanning evidence detected in ${depScanHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No dependency or SCA security scanning evidence detected."}${buildRefreshNote(69, impactedAreaIds, noChange)}`, depScanHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(snyk|npm audit|dependabot|osv|trivy|grype|dependency review)/i, "dependency security scanning") })), depScanHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(70, "Static code/security analysis", staticSecurityHits.length > 0 || discovery.commands.typecheck ? (staticSecurityHits.length > 0 ? "INFERRED" : "UNCERTAIN") : "NOT_DEFINED", `${staticSecurityHits.length > 0 ? `Static security analysis evidence detected in ${staticSecurityHits.slice(0, 5).map((file) => file.path).join(", ")}.` : discovery.commands.typecheck ? "Static analysis exists via typecheck tooling, but dedicated security analysis is not explicit." : "No static code or security analysis evidence detected."}${buildRefreshNote(70, impactedAreaIds, noChange)}`, [
      ...staticSecurityHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(codeql|semgrep|bandit|brakeman|security analysis|static analysis)/i, "static security analysis") })),
      ...discovery.commands.typecheck ? [{ kind: "pattern" as const, detail: `typecheck: ${discovery.commands.typecheck}` }] : [],
    ], staticSecurityHits.length > 0 ? "MEDIUM" : discovery.commands.typecheck ? "LOW" : undefined),
    makeArea(71, "Encryption/TLS/data protection", encryptionHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${encryptionHits.length > 0 ? `Encryption, TLS, or certificate-related evidence detected in ${encryptionHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No encryption, TLS, or data-protection evidence detected."}${buildRefreshNote(71, impactedAreaIds, noChange)}`, encryptionHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(https:\/\/|\btls\b|\bencrypt(?:ion)?\b|certificate|strict-transport-security)/i, "encryption/TLS pattern") })), encryptionHits.length > 0 ? "MEDIUM" : undefined),
    makeArea(72, "Security headers/network trust boundaries", networkHeaderHits.length > 0 ? "INFERRED" : "NOT_DEFINED", `${networkHeaderHits.length > 0 ? `Security-header or trust-boundary evidence detected in ${networkHeaderHits.slice(0, 5).map((file) => file.path).join(", ")}.` : "No security-header or network trust-boundary evidence detected."}${buildRefreshNote(72, impactedAreaIds, noChange)}`, networkHeaderHits.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(x-frame-options|content-security-policy|strict-transport-security|x-content-type-options|trusted proxy|trust proxy)/i, "security header or trust-boundary control") })), networkHeaderHits.length > 0 ? "MEDIUM" : undefined),
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
