import fs from "node:fs/promises";
import path from "node:path";
import type { ConstitutionArea } from "../types.js";
import type { ConstitutionEvaluationContext } from "./shared.js";
import { buildRefreshNote, makeArea } from "./shared.js";

export async function evaluateDataAreas(context: ConstitutionEvaluationContext): Promise<ConstitutionArea[]> {
  const { discovery, impactedAreaIds, noChange } = context;
  if (discovery.dataFiles.length === 0) {
    return [
      makeArea(48, "Database/storage technologies", "NOT_APPLICABLE", `No database or persistence files detected.${buildRefreshNote(48, impactedAreaIds, noChange)}`, []),
      makeArea(49, "ORM/query/data-access approach", "NOT_DEFINED", `No ORM or query-layer evidence detected.${buildRefreshNote(49, impactedAreaIds, noChange)}`, []),
      makeArea(50, "Model/schema organization", "NOT_DEFINED", `No model or schema organization evidence detected.${buildRefreshNote(50, impactedAreaIds, noChange)}`, []),
      makeArea(51, "Migration strategy", "NOT_DEFINED", `No migration strategy evidence detected.${buildRefreshNote(51, impactedAreaIds, noChange)}`, []),
      makeArea(52, "Transaction boundaries", "NOT_DEFINED", `No transaction boundary evidence detected.${buildRefreshNote(52, impactedAreaIds, noChange)}`, []),
      makeArea(53, "Query performance conventions", "NOT_DEFINED", `No query performance convention evidence detected.${buildRefreshNote(53, impactedAreaIds, noChange)}`, []),
      makeArea(54, "Indexing/data access conventions", "NOT_DEFINED", `No indexing or access-path evidence detected.${buildRefreshNote(54, impactedAreaIds, noChange)}`, []),
      makeArea(55, "Seed/fixture/reference-data handling", "NOT_DEFINED", `No seed or fixture data handling evidence detected.${buildRefreshNote(55, impactedAreaIds, noChange)}`, []),
    ];
  }

  const inspected = await inspectDataFiles(discovery.root, discovery.dataFiles.slice(0, 40));
  const schemaFiles = discovery.dataFiles.filter((file) =>
    /(^|\/)(db|database|prisma|migrations?)\//i.test(file) || /\.(prisma|sql)$/i.test(file),
  );
  const migrationFiles = discovery.dataFiles.filter((file) => /(^|\/)(migrations?)\//i.test(file));
  const seedFiles = discovery.dataFiles.filter((file) => /(^|\/)(db|database|prisma|seeds?|fixtures?)\//i.test(file) || /(seed|fixture|fixtures|reference-data)/i.test(file));
  const sqlFiles = discovery.dataFiles.filter((file) => /\.sql$/i.test(file));

  const ormMatches = inspected.filter((file) => /(prisma|typeorm|sequelize|knex|drizzle|mongoose|sqlalchemy|mikro-orm|db\.)/i.test(file.content));
  const transactionMatches = inspected.filter((file) => /(transaction\(|\$transaction|begin transaction|commit;|rollback;)/i.test(file.content));
  const performanceMatches = inspected.filter((file) => /(explain\b|analyze\b|batch\b|n\+1|performance|query plan)/i.test(file.content));
  const indexMatches = inspected.filter((file) => /(index\b|@@index|create index|unique index|btree|gin|gist)/i.test(file.content));

  const technologyEvidence = [
    ...schemaFiles.slice(0, 5).map((file) => ({ kind: "file" as const, path: file, detail: "schema definition file" })),
    ...migrationFiles.slice(0, 5).map((file) => ({ kind: "file" as const, path: file, detail: "migration file" })),
    ...sqlFiles.slice(0, 5).map((file) => ({ kind: "file" as const, path: file, detail: "SQL file" })),
  ];

  const technologyStatus = schemaFiles.length > 0 || migrationFiles.length > 0 || sqlFiles.length > 0
    ? "DEFINED"
    : discovery.dataFiles.length > 0 ? "UNCERTAIN" : "NOT_APPLICABLE";
  const technologyFinding = schemaFiles.length > 0 || migrationFiles.length > 0 || sqlFiles.length > 0
    ? `Persistence technology is evidenced by schema, migration, or SQL files such as ${[...schemaFiles, ...migrationFiles, ...sqlFiles].slice(0, 5).join(", ")}.${buildRefreshNote(48, impactedAreaIds, noChange)}`
    : `Data-oriented paths exist, but they do not yet prove a concrete database or storage technology.${buildRefreshNote(48, impactedAreaIds, noChange)}`;

  return [
    makeArea(48, "Database/storage technologies", technologyStatus, technologyFinding, technologyEvidence, technologyEvidence.length > 0 ? "HIGH" : "LOW"),
    makeArea(49, "ORM/query/data-access approach", ormMatches.length > 0 ? "INFERRED" : "NOT_DEFINED", `${ormMatches.length > 0 ? `ORM or query-layer patterns detected in ${ormMatches.slice(0, 5).map((file) => file.path).join(", ")}.` : "No explicit ORM or query-layer patterns detected in inspected data files."}${buildRefreshNote(49, impactedAreaIds, noChange)}`, ormMatches.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(prisma|typeorm|sequelize|knex|drizzle|mongoose|sqlalchemy|mikro-orm|db\.)/i, "ORM/query-layer pattern") })), ormMatches.length > 0 ? "MEDIUM" : undefined),
    makeArea(50, "Model/schema organization", schemaFiles.length > 0 ? "DEFINED" : "NOT_DEFINED", `${schemaFiles.length > 0 ? `Schema or model definitions are organized in ${schemaFiles.slice(0, 5).join(", ")}.` : "No persistence schema or model organization files detected."}${buildRefreshNote(50, impactedAreaIds, noChange)}`, schemaFiles.slice(0, 8).map((file) => ({ kind: "file" as const, path: file, detail: "schema/model organization" })), schemaFiles.length > 0 ? "HIGH" : undefined),
    makeArea(51, "Migration strategy", migrationFiles.length > 0 ? "DEFINED" : "NOT_DEFINED", `${migrationFiles.length > 0 ? `Migration files are present under ${migrationFiles.slice(0, 5).join(", ")}.` : "No migration files detected."}${buildRefreshNote(51, impactedAreaIds, noChange)}`, migrationFiles.slice(0, 8).map((file) => ({ kind: "file" as const, path: file, detail: "migration strategy evidence" })), migrationFiles.length > 0 ? "HIGH" : undefined),
    makeArea(52, "Transaction boundaries", transactionMatches.length > 0 ? "INFERRED" : "NOT_DEFINED", `${transactionMatches.length > 0 ? `Transaction boundary patterns detected in ${transactionMatches.slice(0, 5).map((file) => file.path).join(", ")}.` : "No transaction boundary patterns detected in inspected data files."}${buildRefreshNote(52, impactedAreaIds, noChange)}`, transactionMatches.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(transaction\(|\$transaction|begin transaction|commit;|rollback;)/i, "transaction pattern") })), transactionMatches.length > 0 ? "MEDIUM" : undefined),
    makeArea(53, "Query performance conventions", performanceMatches.length > 0 ? "INFERRED" : "NOT_DEFINED", `${performanceMatches.length > 0 ? `Query performance-oriented patterns detected in ${performanceMatches.slice(0, 5).map((file) => file.path).join(", ")}.` : "No explicit query performance convention evidence detected."}${buildRefreshNote(53, impactedAreaIds, noChange)}`, performanceMatches.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(explain\b|analyze\b|batch\b|n\+1|performance|query plan)/i, "query performance pattern") })), performanceMatches.length > 0 ? "MEDIUM" : undefined),
    makeArea(54, "Indexing/data access conventions", indexMatches.length > 0 ? "INFERRED" : "NOT_DEFINED", `${indexMatches.length > 0 ? `Indexing or access-path evidence detected in ${indexMatches.slice(0, 5).map((file) => file.path).join(", ")}.` : "No indexing or data access convention evidence detected."}${buildRefreshNote(54, impactedAreaIds, noChange)}`, indexMatches.slice(0, 8).map((file) => ({ kind: "file" as const, path: file.path, detail: summarizeMatch(file.content, /(index\b|@@index|create index|unique index|btree|gin|gist)/i, "index/access pattern") })), indexMatches.length > 0 ? "MEDIUM" : undefined),
    makeArea(55, "Seed/fixture/reference-data handling", seedFiles.length > 0 ? "DEFINED" : "NOT_DEFINED", `${seedFiles.length > 0 ? `Seed or fixture files detected in ${seedFiles.slice(0, 5).join(", ")}.` : "No seed, fixture, or reference-data files detected."}${buildRefreshNote(55, impactedAreaIds, noChange)}`, seedFiles.slice(0, 8).map((file) => ({ kind: "file" as const, path: file, detail: "seed/fixture/reference data" })), seedFiles.length > 0 ? "HIGH" : undefined),
  ];
}

async function inspectDataFiles(root: string, files: string[]): Promise<Array<{ path: string; content: string }>> {
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
