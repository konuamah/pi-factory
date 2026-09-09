import { useState } from 'preact/hooks';
import { api, type RunDetail as RunDetailType, type LogEntry, type AcceptanceEvidenceView } from '../api/client';
import { useRevalidate, runEvent } from '../api/use-revalidate';
import { StatusBadge } from './overview';

const TABS = ['Overview', 'Plan', 'Logs', 'Verification', 'Acceptance'] as const;

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
  const planText = getPlanText(run.plan);
  const planSummary = getPlanSummary(run.plan);
  const evidence = run.acceptanceEvidence;

  return (
    <>
      <button className="link" onClick={goBack}>← back to runs</button>
      <h1>{run.title ?? run.goal ?? run.runId}</h1>
      {run.title && run.goal ? <p className="muted">{run.goal}</p> : null}
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
          {evidence && <section>
            <h5>Acceptance</h5>
            <p>Decision: <strong>{evidence.decision ?? 'pending'}</strong>{' · '}Landing: <StatusBadge status={evidence.landingStatus ?? evidence.landingPhase ?? 'unknown'} />{evidence.reviewVerdict?.verdict === 'block' && <> · <span className="badge badge-blocked">reviewer block</span></>}</p>
          </section>}

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

      {tab === 'Plan' && (
        <article>
          <h5>Human-readable plan</h5>
          {planText ? (
            <pre className="plan-text" aria-label="Human-readable Factory plan">{planText}</pre>
          ) : (
            <p className="muted">No human-readable plan text is available for this run yet.</p>
          )}

          {planSummary ? (
            <section>
              <h6>Runtime summary</h6>
              <p>{planSummary}</p>
            </section>
          ) : null}
        </article>
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

      {tab === 'Acceptance' && <AcceptancePanel evidence={evidence} />}

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

function AcceptancePanel({ evidence }: { evidence?: AcceptanceEvidenceView }) {
  if (!evidence) return <article><p className="muted">No acceptance evidence recorded for this run (legacy or pre-acceptance run).</p></article>;
  const verdictSummary = evidence.reviewVerdict?.summary.trim();
  return <article>
    <h5>Acceptance evidence</h5>
    {evidence.reviewVerdict?.verdict === 'block' && <section className="attention">
      <h6>Reviewer blocking verdict: accepting overrides this finding.</h6>
      {verdictSummary && <><p className="muted">Summary:</p><pre className="plan-text">{verdictSummary}</pre></>}
    </section>}
    {evidence.reviewVerdict && evidence.reviewVerdict.verdict !== 'block' && <section><h6>Reviewer verdict: {evidence.reviewVerdict.verdict}</h6>{verdictSummary && <pre className="plan-text">{verdictSummary}</pre>}</section>}
    <section className="grid"><article><h6>Decision</h6><p><strong>{evidence.decision ?? 'pending'}</strong></p>{evidence.feedback && <p className="muted">{evidence.feedback}</p>}</article><article><h6>Landing</h6><p>Status: {evidence.landingStatus ?? 'unknown'}</p><p>Phase: {evidence.landingPhase ?? 'unknown'}</p>{evidence.landingReason && <p className="muted">{evidence.landingReason}</p>}{evidence.targetHeadBefore && evidence.targetHeadAfter && <p className="muted">Head {evidence.targetHeadBefore.slice(0, 7)} → {evidence.targetHeadAfter.slice(0, 7)}</p>}</article></section>
    {evidence.pullRequest && <section><h6>Pull request</h6><p>Status: {evidence.pullRequest.status ?? 'unknown'}</p>{(evidence.pullRequest.sourceBranch || evidence.pullRequest.targetBranch) && <p>{evidence.pullRequest.sourceBranch ?? '?'} → {evidence.pullRequest.targetBranch ?? '?'}</p>}{evidence.pullRequest.url && <p><a href={evidence.pullRequest.url} target="_blank" rel="noreferrer">{evidence.pullRequest.url}</a></p>}{evidence.pullRequest.reason && <p className="muted">{evidence.pullRequest.reason}</p>}</section>}
    <section className="grid"><article><h6>Verification</h6><p>{evidence.verificationStatus ?? 'unknown'}</p><p>Contract complete: {evidence.contractComplete === true ? 'yes' : evidence.contractComplete === false ? 'no' : 'unknown'}</p></article><article><h6>Post-landing verification</h6>{evidence.postLandingVerification ? <><StatusBadge status={evidence.postLandingVerification.overallStatus ?? 'unknown'} /><p>Commands: {evidence.postLandingVerification.commands?.join(', ') || 'none'}</p>{evidence.postLandingVerification.reason && <p className="muted">{evidence.postLandingVerification.reason}</p>}{evidence.postLandingVerification.repairAttempted && <p className="muted">Repair attempted.</p>}</> : <p className="muted">No post-landing verification recorded.</p>}</article></section>
    <EvidenceList title="Baseline debt" items={evidence.baselineDebt?.map((item) => `${item.commandName} — ${item.category}: ${item.reason}${item.suggestedAction ? ` (${item.suggestedAction})` : ''}`)} />
    <EvidenceList title="Scope warnings" items={evidence.scopeWarnings?.map((item) => `${item.file} — ${item.nonGoal}`)} />
  </article>;
}

function EvidenceList({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;
  return <section><h6>{title}</h6>{items.map((item, index) => <div className="kv" key={index}><span>{item}</span></div>)}</section>;
}

function getPlanText(plan: RunDetailType['plan']): string | undefined {
  const value = plan?.planText;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function getPlanSummary(plan: RunDetailType['plan']): string | undefined {
  const value = plan?.summary;
  return typeof value === 'string' && value.trim() ? value : undefined;
}
