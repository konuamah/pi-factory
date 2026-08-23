import { useState } from 'preact/hooks';
import { api, type RunDetail as RunDetailType, type LogEntry } from '../api/client';
import { useRevalidate, runEvent } from '../api/use-revalidate';
import { StatusBadge } from './overview';

const TABS = ['Overview', 'Logs', 'Verification'] as const;

export function RunDetail({ runId, goBack }: { runId: string; goBack: () => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Overview');
  const [logFilter, setLogFilter] = useState('All');

  const { data: run, error } = useRevalidate<RunDetailType>(`run:${runId}`, () => api.run(runId), {
    onEvent: (type, data) => runEvent(type, data, runId),
  });
  const { data: logs } = useRevalidate<LogEntry[]>(`logs:${runId}`, () => api.runLogs(runId), {
    initial: [],
    onEvent: (type, data) => /^log\.|^task\.|^verification\.|^run\./.test(type) && data.runId === runId,
  });

  if (error || !run) {
    return <p>{error ? 'Run not found.' : 'Loading…'} <button className="link" onClick={goBack}>← back</button></p>;
  }

  const planTasks = run.plan?.tasks as Array<{ id?: string; stage?: string; status?: string }> | undefined;
  const models = (run.models ?? []).slice(0, 8);

  return (
    <>
      <button className="link" onClick={goBack}>← back to runs</button>
      <h1>{run.goal ?? run.runId}</h1>
      <p>
        <StatusBadge status={run.status} /> <span className="muted">{run.runId}</span>
      </p>

      <div className="filters">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? 'outline active' : 'outline'} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'Overview' && (
        <>
          <section className="grid">
            <article>
              <h5>Execution</h5>
              {(planTasks ?? []).map((task) => (
                <div key={task.id} className="stage-row">
                  <span className={task.status === 'done' ? 'check' : 'circle'}>{task.status === 'done' ? '✓' : '○'}</span>
                  {' '}{task.stage} ({task.id})
                </div>
              ))}
            </article>
            <article>
              <h5>Models</h5>
              {models.map((entry, i) => (
                <div key={i} className="kv">
                  <span>{String(entry.role ?? entry.modelSource ?? 'op')}</span>
                  <span>{String(entry.resolvedModel ?? entry.model ?? '—')}</span>
                </div>
              ))}
              {models.length === 0 && <p className="muted">No model ledger entries.</p>}
            </article>
          </section>

          <section className="grid">
            <article>
              <h5>Verification</h5>
              <StatusBadge status={run.verification?.overallStatus as string | undefined} />
            </article>
            <article>
              <h5>Decisions</h5>
              {(run.decisions ?? []).map((d, i) => (
                <div key={i} className="kv">
                  <span>{String(d.type)}</span>
                  <span>{String(d.optionId ?? d.question ?? d.requestId ?? '—')}</span>
                </div>
              ))}
              {(run.decisions ?? []).length === 0 && <p className="muted">No decisions.</p>}
            </article>
          </section>
        </>
      )}

      {tab === 'Logs' && (
        <>
          <div className="filters">
            {['All', 'SYSTEM', 'PLANNER', 'BUILDER', 'TOOL', 'VERIFICATION', 'REVIEWER', 'REPAIR'].map((f) => (
              <button key={f} className={f === logFilter ? 'outline active' : 'outline'} onClick={() => setLogFilter(f)}>
                {f}
              </button>
            ))}
          </div>
          <div className="log-viewer">
            {(logs ?? []).filter((log) => logFilter === 'All' || log.source === logFilter).map((log) => (
              <div key={log.id} className={`log-line log-${log.level.toLowerCase()}`}>
                <span className="log-time">{log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '--:--:--'}</span>
                <span className="log-source">{log.source}</span>
                <span className="log-msg">{log.message}</span>
              </div>
            ))}
            {(logs ?? []).length === 0 && <p className="muted">No logs yet.</p>}
          </div>
        </>
      )}

      {tab === 'Verification' && (
        <article>
          <h5>Verification</h5>
          {Array.isArray(run.verification?.commands) && (run.verification.commands as Array<{ name?: string; status?: string }>).map((cmd, i) => (
            <div key={i} className="kv">
              <span>{String(cmd.name)}</span>
              <span>{String(cmd.status)}</span>
            </div>
          ))}
          {run.verification?.contract && (
            <section>
              <h6>Contract</h6>
              <StatusBadge status={(run.verification.contract as { canComplete?: boolean }).canComplete ? 'COMPLETED' : 'BLOCKED'} />
            </section>
          )}
        </article>
      )}
    </>
  );
}