import { useEffect, useState } from 'preact/hooks';
import { api, type ConstitutionOverview } from '../api/client';

const SECTION_MAP: Array<[string, [number, number]]> = [
  ['Structure', [1, 7]],
  ['Dependencies', [8, 20]],
  ['Architecture', [21, 40]],
  ['API', [41, 50]],
  ['Data', [51, 60]],
  ['Security', [61, 75]],
  ['Testing', [76, 85]],
  ['CI/CD', [86, 95]],
  ['Deployment', [96, 102]],
];

export function Constitution() {
  const [data, setData] = useState<ConstitutionOverview | null>(null);

  useEffect(() => {
    api.constitution().then(setData).catch(() => setData(null));
  }, []);

  if (!data) {
    return <p>Loading…</p>;
  }

  const areas = data.areas ?? [];
  const counts = data.statusCounts ?? {};

  return (
    <>
      <h1>Constitution</h1>
      <div className="stats">
        {Object.entries(counts).map(([status, count]) => (
          <div className="stat" key={status}>
            <div className="stat-value">{count}</div>
            <div className="stat-label">{status}</div>
          </div>
        ))}
      </div>

      <section>
        <h3>Sections</h3>
        {SECTION_MAP.map(([label, [start, end]]) => {
          const inRange = areas.filter((area) => (area.id ?? 0) >= start && (area.id ?? 0) <= end);
          const covered = inRange.filter((area) => area.status === 'DEFINED' || area.status === 'INFERRED').length;
          return (
            <div className="kv" key={label}>
              <span>{label}</span>
              <span>{covered} / {inRange.length}</span>
            </div>
          );
        })}
      </section>

      <section>
        <h3>Areas</h3>
        <table>
          <thead>
            <tr><th>ID</th><th>Status</th><th>Finding</th></tr>
          </thead>
          <tbody>
            {areas.slice(0, 120).map((area) => (
              <tr key={area.id}>
                <td>{area.id}</td>
                <td><StatusBadge status={area.status} /></td>
                <td className="muted">{area.finding ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function StatusBadge({ status }: { status?: string }) {
  return <span className={`badge badge-${(status ?? 'unknown').toLowerCase()}`}>{status ?? 'unknown'}</span>;
}