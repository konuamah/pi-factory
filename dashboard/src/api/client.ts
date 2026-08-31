export interface DashboardStatus {
  repository?: { name?: string; branch?: string; commit?: string; root?: string };
  readiness?: string;
  activeRuns?: number;
  needsAttention?: Array<{ runId: string; kind: string; detail?: string }>;
  verificationFailures?: number;
  constitution?: { coveredAreas?: number; totalAreas?: number };
  recentRuns?: Array<{ runId: string; title?: string; goal?: string; status?: string; phase?: string }>;
}

export interface RunListItem {
  runId: string;
  status?: string;
  phase?: string;
  title?: string;
  goal?: string;
  updatedAt?: string;
}

export interface LogEntry {
  id: string;
  timestamp?: string;
  runId: string;
  source: string;
  level: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface RunDetail {
  runId?: string;
  runDir?: string;
  status?: string;
  phase?: string;
  title?: string;
  goal?: string;
  state?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  verification?: Record<string, unknown>;
  models?: Array<Record<string, unknown>>;
  decisions?: Array<Record<string, unknown>>;
}

export interface ConstitutionOverview {
  totalAreas?: number;
  evaluatedAreas?: number;
  statusCounts?: Record<string, number>;
  areas?: Array<{ id?: number; status?: string; finding?: string }>;
}

export interface SkillInfo {
  id: string;
  version?: string;
  description?: string;
  capabilities?: string[];
  constitutionAreas?: number[];
  stages?: string[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  status: () => get<DashboardStatus>('/api/status'),
  repository: () => get<Record<string, unknown>>('/api/repository'),
  runs: () => get<RunListItem[]>('/api/runs'),
  run: (id: string) => get<RunDetail>(`/api/runs/${id}`),
  runLogs: (id: string) => get<LogEntry[]>(`/api/runs/${id}/logs`),
  constitution: () => get<ConstitutionOverview>('/api/constitution'),
  skills: () => get<SkillInfo[]>('/api/skills'),
  models: () => get<Record<string, unknown>>('/api/models'),
  capabilities: () => get<Array<Record<string, unknown>>>('/api/capabilities'),
  verification: () => get<Record<string, unknown>>('/api/verification'),
  decisions: () => get<Record<string, unknown>>('/api/decisions'),
  setup: () => get<Record<string, unknown>>('/api/setup'),
};

export function subscribeEvents(onEvent: (type: string, data: Record<string, unknown>) => void): () => void {
  const source = new EventSource('/api/events');
  source.onmessage = (event) => onEvent(event.type ?? 'message', JSON.parse(event.data || '{}'));
  source.addEventListener('run.updated', (event) => onEvent('run.updated', JSON.parse((event as MessageEvent).data || '{}')));
  source.addEventListener('log.created', (event) => onEvent('log.created', JSON.parse((event as MessageEvent).data || '{}')));
  return () => source.close();
}
