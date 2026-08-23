import { useEffect, useState } from 'preact/hooks';
import { api } from '../api/client';

const TABS = ['Models', 'Capabilities', 'Verification', 'Decisions', 'Setup'] as const;

export function System() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Models');
  const [models, setModels] = useState<Record<string, unknown>>({});
  const [capabilities, setCapabilities] = useState<Array<Record<string, unknown>>>([]);
  const [verification, setVerification] = useState<Record<string, unknown>>({});
  const [decisions, setDecisions] = useState<Record<string, unknown>>({});
  const [setup, setSetup] = useState<Record<string, unknown>>({});

  useEffect(() => {
    api.models().then(setModels).catch(() => setModels({}));
    api.capabilities().then(setCapabilities).catch(() => setCapabilities([]));
    api.verification().then(setVerification).catch(() => setVerification({}));
    api.decisions().then(setDecisions).catch(() => setDecisions({}));
    api.setup().then(setSetup).catch(() => setSetup({}));
  }, []);

  return (
    <>
      <h1>System</h1>
      <div className="filters">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? 'outline active' : 'outline'} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'Models' && (
        <article>
          <h5>Role defaults</h5>
          <RoleTable roles={models.roleDefaults as Record<string, unknown> | undefined} />
        </article>
      )}

      {tab === 'Capabilities' && (
        <section>
          <h5>Capabilities</h5>
          <table>
            <thead><tr><th>Capability</th><th>Status</th><th>Provider</th><th>Policy</th></tr></thead>
            <tbody>
              {capabilities.map((cap) => (
                <tr key={String(cap.id)}>
                  <td>{String(cap.id)}</td>
                  <td>{String(cap.status)}</td>
                  <td>{cap.provider ? String(cap.provider) : '—'}</td>
                  <td>{String(cap.policy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === 'Verification' && (
        <article>
          <h5>Commands</h5>
          <CommandsTable commands={verification.commands as Record<string, unknown> | undefined} />
        </article>
      )}

      {tab === 'Decisions' && (
        <article>
          <h5>Decisions</h5>
          {Array.isArray((decisions.decisions ?? [])) && (decisions.decisions as Array<Record<string, unknown>>).map((d, i) => (
            <div key={i} className="kv">
              <span>{String(d.type)}</span>
              <span>{String(d.question ?? d.optionId ?? d.requestId ?? '—')}</span>
            </div>
          ))}
          {!Array.isArray(decisions.decisions) && <p className="muted">No decisions.</p>}
        </article>
      )}

      {tab === 'Setup' && (
        <article>
          <h5>Setup</h5>
          <div className="kv"><span>Workflow</span><span>{String(setup.workflowId ?? '—')}</span></div>
          <div className="kv"><span>Readiness</span><span>{String(setup.readiness ?? '—')}</span></div>
          <div className="kv"><span>Languages</span><span>{Array.isArray(setup.repository?.languages) ? (setup.repository as { languages: string[] }).languages.join(', ') : '—'}</span></div>
        </article>
      )}
    </>
  );
}

function RoleTable({ roles }: { roles?: Record<string, unknown> }) {
  if (!roles) return <p className="muted">No model config.</p>;
  return (
    <table>
      <thead><tr><th>Role</th><th>Model</th></tr></thead>
      <tbody>
        {Object.entries(roles).map(([role, selection]) => (
          <tr key={role}>
            <td>{role}</td>
            <td>{typeof selection === 'object' && selection ? String((selection as { model?: string }).model ?? '—') : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CommandsTable({ commands }: { commands?: Record<string, unknown> }) {
  if (!commands) return <p className="muted">No commands configured.</p>;
  return (
    <table>
      <thead><tr><th>Name</th><th>Command</th></tr></thead>
      <tbody>
        {Object.entries(commands).map(([name, command]) => (
          <tr key={name}>
            <td>{name}</td>
            <td>{String(command)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}