import { api, type DashboardStatus } from '../api/client';
import { useRevalidate } from '../api/use-revalidate';

export function Overview({ goToRun }: { goToRun: (runId: string) => void }) {
  const { data: status, error } = useRevalidate<DashboardStatus>('status', () => api.status(), {
    onEvent: (type) => /^run\.|^decision\.|^constitution\./.test(type),
  });

  if (error) {
    return (
      <article>
        <h4>Cannot reach Factory</h4>
        <p>Start the read-only web server, then reload. The dashboard is view-only.</p>
      </article>
    );
  }
  if (!status) {
    return <p>Loading…</p>;
  }

  const repo = status.repository;
  const stat = (label: string, value: string | number | undefined) => (
    <div className="stat">
      <div className="stat-value">{value ?? '—'}</div>
      <div className="stat-label">{label}</div>
    </div>
  );

  return (
    <>
      <h1>{repo?.name ?? 'Factory'}</h1>
      <p className="muted">
        {repo?.branch ?? '—'} · {repo?.commit ?? '—'}
      </p>

      <div className="stats">
        {stat('Status', status.readiness)}
        {stat('Active runs', status.activeRuns)}
        {stat('Needs attention', status.needsAttention?.length ?? 0)}
        {stat('Verification failures', status.verificationFailures)}
        {stat('Constitution', status.constitution?.totalAreas ? `${status.constitution.evaluatedAreas ?? 0}/120` : '—')}
      </div>

      {status.needsAttention && status.needsAttention.length > 0 && (
        <article className="attention">
          <h5>Needs attention</h5>
          {status.needsAttention.map((item) => (
            <div key={item.runId}>
              <button className="link" onClick={() => goToRun(item.runId)}>
                {item.kind}: {item.detail ?? item.runId}
              </button>
            </div>
          ))}
        </article>
      )}

      <section>
        <h3>Recent runs</h3>
        <table>
          <thead>
            <tr><th>Status</th><th>Run</th><th>Phase</th><th></th></tr>
          </thead>
          <tbody>
            {(status.recentRuns ?? []).map((run) => (
              <tr key={run.runId}>
                <td><StatusBadge status={run.status} /></td>
                <td title={run.goal}>{run.title ?? run.goal ?? run.runId}</td>
                <td>{run.phase ?? '—'}</td>
                <td><button className="link" onClick={() => goToRun(run.runId!)}>view</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

export function StatusBadge({ status }: { status?: string }) {
  const cls = (status ?? 'unknown').toLowerCase();
  return <span className={`badge badge-${cls}`}>{status ?? 'unknown'}</span>;
}
