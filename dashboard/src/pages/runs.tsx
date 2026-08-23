import { useState } from 'preact/hooks';
import { api, type RunListItem } from '../api/client';
import { useRevalidate } from '../api/use-revalidate';
import { StatusBadge } from './overview';

const FILTERS = ['All', 'Running', 'Complete', 'Failed', 'Blocked', 'Decision required'];

export function Runs({ goToRun }: { goToRun: (runId: string) => void }) {
  const [filter, setFilter] = useState('All');
  const { data: runs } = useRevalidate<RunListItem[]>('runs', () => api.runs(), {
    initial: [],
    onEvent: (type) => /^run\.|^log\.|^decision\./.test(type),
  });

  const matches = (run: RunListItem): boolean => {
    if (filter === 'All') return true;
    if (filter === 'Running') return run.status === 'RUNNING' || run.status === 'PENDING';
    if (filter === 'Complete') return run.status === 'COMPLETED';
    if (filter === 'Failed') return run.status === 'FAILED';
    if (filter === 'Blocked') return run.status === 'BLOCKED';
    if (filter === 'Decision required') return run.status === 'DECISION_REQUIRED';
    return true;
  };

  const filtered = (runs ?? []).filter(matches);

  return (
    <>
      <h1>Runs</h1>
      <div className="filters">
        {FILTERS.map((f) => (
          <button key={f} className={f === filter ? 'outline active' : 'outline'} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
      </div>
      <table>
        <thead>
          <tr><th>Status</th><th>Goal</th><th>Phase</th><th>Updated</th><th></th></tr>
        </thead>
        <tbody>
          {filtered.map((run) => (
            <tr key={run.runId}>
              <td><StatusBadge status={run.status} /></td>
              <td>{run.goal ?? '—'}</td>
              <td>{run.phase ?? '—'}</td>
              <td className="muted">{run.updatedAt ? new Date(run.updatedAt).toLocaleTimeString() : '—'}</td>
              <td><button className="link" onClick={() => goToRun(run.runId)}>view</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}