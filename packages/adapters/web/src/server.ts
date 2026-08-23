import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import {
  queryStatus,
  queryRepository,
  queryRuns,
  queryRun,
  queryRunLogs,
  queryConstitution,
  queryConstitutionArea,
  querySkills,
  querySkill,
  queryModels,
  queryCapabilities,
  queryVerification,
  queryDecisions,
  querySetup,
} from "@factory/core";
import { discoverFactoryProject } from "@factory/core";

export interface DashboardServerOptions {
  cwd: string;
  port?: number;
  host?: string;
  /** Directory containing the built dashboard (index.html + assets). If provided, the server serves it at `/`. */
  staticDir?: string;
}

export interface DashboardServer {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

export async function createDashboardServer(options: DashboardServerOptions): Promise<DashboardServer> {
  const handler = createRequestHandler(options.cwd, options.staticDir);

  const server = http.createServer(async (req, res) => {
    await handler(req, res).catch((error) => {
      respondJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    server,
    port,
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function createRequestHandler(cwd: string, staticDir?: string) {
  return async function handler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = (req.url ?? "/").split("?")[0]!;
    const base = "/api";

    // Serve the built dashboard for non-API GET requests.
    if (staticDir && !url.startsWith(base) && url !== "/health" && method === "GET") {
      return serveStatic(staticDir, url, res);
    }

    // Root — a simple landing (or dashboard if staticDir provided above).
    if (url === "/" || url === "") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><body><h1>Factory Dashboard</h1><p>Read-only API at <code>/api</code></p></body></html>");
      return;
    }

    if (url === "/health") {
      respondJson(res, 200, { ok: true });
      return;
    }

    // SSE events endpoint.
    if (url === `${base}/events`) {
      return handleEvents(cwd, req, res);
    }

    // Everything else must be GET (read-only guarantee).
    if (method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed. This is a read-only API." }));
      return;
    }

    if (!url.startsWith(base)) {
      respondJson(res, 404, { error: "Not found" });
      return;
    }

    const route = url.slice(base.length);

    if (route === "/status" || route === "/status/") {
      return respondJson(res, 200, await queryStatus(cwd));
    }
    if (route === "/repository") {
      return respondJson(res, 200, await queryRepository(cwd));
    }
    if (route === "/runs" || route === "/runs/") {
      return respondJson(res, 200, await queryRuns(cwd));
    }
    if (route.startsWith("/runs/")) {
      const rest = route.slice("/runs/".length);
      return handleRunSubroute(rest, cwd, res);
    }
    if (route === "/constitution") {
      return respondJson(res, 200, await queryConstitution(cwd));
    }
    if (route.startsWith("/constitution/")) {
      const id = Number(route.slice("/constitution/".length));
      const result = await queryConstitutionArea(cwd, id);
      return result ? respondJson(res, 200, result) : respondJson(res, 404, { error: "Area not found" });
    }
    if (route === "/skills") {
      return respondJson(res, 200, await querySkills());
    }
    if (route.startsWith("/skills/")) {
      const id = decodeURIComponent(route.slice("/skills/".length));
      const result = await querySkill(id);
      return result ? respondJson(res, 200, result) : respondJson(res, 404, { error: "Skill not found" });
    }
    if (route === "/models") {
      return respondJson(res, 200, await queryModels(cwd));
    }
    if (route === "/capabilities") {
      return respondJson(res, 200, await queryCapabilities(cwd));
    }
    if (route === "/verification") {
      return respondJson(res, 200, await queryVerification(cwd));
    }
    if (route === "/decisions") {
      return respondJson(res, 200, await queryDecisions(cwd));
    }
    if (route === "/setup") {
      return respondJson(res, 200, await querySetup(cwd));
    }

    respondJson(res, 404, { error: "Not found" });
  };
}

async function handleRunSubroute(rest: string, cwd: string, res: http.ServerResponse): Promise<void> {
  const parts = rest.split("/").filter(Boolean);
  const runId = parts[0];
  const sub = parts[1];
  if (!runId) {
    return respondJson(res, 200, await queryRuns(cwd));
  }
  if (sub === "logs") {
    return respondJson(res, 200, await queryRunLogs(cwd, runId));
  }
  const run = await queryRun(cwd, runId);
  if (!run) {
    return respondJson(res, 404, { error: "Run not found" });
  }
  if (sub === "verification") {
    return respondJson(res, 200, { verification: run.verification ?? null, models: run.models, decisions: run.decisions });
  }
  return respondJson(res, 200, run);
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function serveStatic(staticDir: string, url: string, res: http.ServerResponse): Promise<void> {
  const requested = url === "/" ? "index.html" : url.replace(/^\//, "");
  const filePath = path.join(staticDir, requested);
  try {
    const raw = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const type = contentType(ext);
    res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
    res.end(raw);
  } catch {
    // SPA fallback: serve index.html for client-side routes.
    try {
      const index = await fs.readFile(path.join(staticDir, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(index);
    } catch {
      respondJson(res, 404, { error: "Dashboard not built. Run `npm run build` in dashboard/." });
    }
  }
}

function contentType(ext: string): string {
  switch (ext) {
    case ".html": return "text/html";
    case ".js": return "application/javascript";
    case ".css": return "text/css";
    case ".json": return "application/json";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".ico": return "image/x-icon";
    default: return "text/plain";
  }
}

async function handleEvents(cwd: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write("event: ready\ndata: {}\n\n");

  const project = await discoverFactoryProject(cwd);
  const runsDir = project.paths.runsDir;
  let sent: string[] = [];
  const seen = new Set<string>();

  const readNew = async (): Promise<void> => {
    const files = await readRunEventFiles(runsDir);
    for (const { runId, line } of files) {
      const key = `${runId}:${line}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      let type = "log.created";
      let data: Record<string, unknown> = { runId };
      try {
        const event = JSON.parse(line) as { type?: string; timestamp?: string };
        if (event.type) {
          type = event.type;
        }
        data = { runId, ...(event.timestamp ? { timestamp: event.timestamp } : {}) };
      } catch {
        // keep default
      }
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  const interval = setInterval(() => {
    void readNew();
  }, 2000);

  req.on("close", () => {
    clearInterval(interval);
    res.end();
  });

  void readNew();
}

async function readRunEventFiles(runsDir: string): Promise<Array<{ runId: string; line: string }>> {
  const result: Array<{ runId: string; line: string }> = [];
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean }>;
  } catch {
    return result;
  }
  const runDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse().slice(0, 10);
  for (const runId of runDirs) {
    try {
      const raw = await fs.readFile(path.join(runsDir, runId, "events.jsonl"), "utf8");
      for (const line of raw.split(/\r?\n/).filter(Boolean)) {
        result.push({ runId, line });
      }
    } catch {
      // skip
    }
  }
  return result;
}