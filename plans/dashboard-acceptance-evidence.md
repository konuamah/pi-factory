# Dashboard Acceptance Evidence

## 1. Understanding & Scope

* **Core Goal:**
  Make the Factory dashboard run-detail page surface the full **acceptance evidence** that the CLI already shows at the acceptance dialog — specifically the reviewer blocking verdict (when present) and all the supporting evidence: verification status, post-landing verification status, landing outcome, baseline debt, scope warnings, and the reviewer summary text. After this change, a user opening a run like `run_1788964288486_aa67cd23` (goal: "i wantt to add coloring of the tasks based on urgency", status `COMPLETED / accepted`) sees *why* the reviewer returned a blocking verdict and that the user accepted despite it.

* **Current Behavior:**
  * `packages/core/src/queries/index.ts:104-135` — `queryRun` returns only `state`, `summary`, `plan`, `verification`, `models`, `decisions`, plus `status`, `phase`, `title`, `goal`. It does **not** read `reviewer-execution.json`, `final-merge.json`, or parse `events.jsonl` for `acceptance.*` evidence, so reviewer block details never reach the dashboard.
  * `packages/core/src/runs/show.ts:1-130` already has the richer reader: it loads `reviewer-execution.json`, `final-merge.json`, walks `events.jsonl` to find `acceptance.accepted | acceptance.rejected | acceptance.revise_requested`, extracts `event.data.evidence`, and exposes `finalMergeStatus`, `finalMergeOutcome`, `postLandingVerification`, `pullRequest`, `evidence`. `queryRun` does not reuse any of this.
  * `dashboard/src/api/client.ts:34-43` declares `RunDetail` with `state`, `summary`, `plan`, `verification`, `models`, `decisions` only — no reviewer/evidence fields.
  * `dashboard/src/pages/run-detail.tsx:1-158` renders four tabs (Overview, Plan, Logs, Verification) using only the fields above. There is no Reviewer tab and no Acceptance Evidence section. The Overview tab shows execution stage rows, models, verification status, and decision rows — none of the reviewer block summary, landing outcome, baseline debt, or scope warnings.
  * The acceptance event already carries the evidence in the run on disk. Verified at `.factory/runs/run_1788964288486_aa67cd23/events.jsonl` last lines:
    ```json
    {"type":"acceptance.accepted","data":{"candidateSha":"d41600b348b4ba9d24c321c3f25aa3a2f4016879","landingStatus":"landed","evidence":{"reviewVerdict":{"verdict":"block","summary":"Not ready for approval. … Recommendation: clarify the conflicting Q3/Q4 decisions first."},"landingOutcome":{...},"verificationStatus":"passed","contractComplete":true,"baselineDebt":[...],"scopeWarnings":[...],"postLandingVerification":{"overallStatus":"passed","commands":[...],"reason":null,"repairAttempted":false}}}}
    ```

* **Target Behavior:**
  * The dashboard run-detail API (`/api/runs/:id`) returns, alongside existing fields, a normalized `acceptanceEvidence` object containing:
    - `decision`: `"accept" | "revise" | "reject"` (latest acceptance event type → mapped value)
    - `feedback`: optional string from the acceptance event
    - `landingStatus`: `"landed" | "pull-request" | "skipped" | "blocked"`
    - `landingPhase`: `"complete" | "merge-blocked" | "pull-request-opened" | "accepted" | "accepted-with-pr" | "acceptance-blocked"`
    - `landingReason`: optional reason from `final-merge.json.reason`
    - `pullRequest`: optional `{ status, url, sourceBranch, targetBranch, reason }`
    - `targetHeadBefore` / `targetHeadAfter`: optional git SHAs
    - `postLandingVerification`: `{ overallStatus, commands, reason, repairAttempted }`
    - `verificationStatus`: `"passed" | "failed" | "incomplete"`
    - `contractComplete`: boolean
    - `baselineDebt`: optional array of `{ commandName, category, reason, suggestedAction, implicatedFiles? }`
    - `scopeWarnings`: optional array of `{ file, nonGoal }`
    - `reviewVerdict`: optional `{ verdict: "block" | "pass" | "unknown", summary }` — the **text the user must be able to see**
  * The dashboard run-detail page renders a new **"Acceptance" tab** that displays the above fields, with the reviewer verdict/summary rendered prominently when `reviewVerdict?.verdict === "block"` (matching the CLI warning copy `"Reviewer blocking verdict: accepting overrides this finding."`).
  * The existing Overview tab gains a one-line acceptance summary (decision + landing outcome) so users on the default tab see whether this run was accepted with the reviewer block noted.
  * All changes are backward compatible: existing fields remain; new fields are absent (not `null`) for runs that predate the acceptance phase.

* **Files Affected:**
  * `Modify: packages/core/src/queries/index.ts:104-135` (`queryRun` extends evidence; reuses reader from `show.ts`)
  * `Modify: packages/core/src/runs/show.ts:1-130` (extract a shared reader so `queryRun` and `showFactoryRun` share one evidence builder; no behavior change to `showFactoryRun`)
  * `Modify: dashboard/src/api/client.ts:34-50` (`RunDetail` adds `acceptanceEvidence` field)
  * `Modify: dashboard/src/pages/run-detail.tsx:1-158` (add "Acceptance" tab; add acceptance summary line to Overview)
  * `Modify: dashboard/src/styles.css` (one small badge style for reviewer-block severity; reuse existing `.badge-blocked`/`.badge-error` if present)
  * `Test: tests/queries.test.mjs` (new) — verify `queryRun` returns `acceptanceEvidence` for an accepted run and is absent for legacy runs
  * `Modify: tests/runtime.test.mjs` (add an assertion in the acceptance-flow tests that the `acceptance.accepted` event's `evidence` matches what `queryRun` returns — covered indirectly via `queries.test.mjs`)

* **Out of Scope:**
  * Changing what the acceptance dialog records (no controller or event-shape changes).
  * Adding interactive dashboard controls (no approve/reject buttons; the dashboard is read-only).
  * Surfacing full review-execution `events` array or raw model output (only reviewer `summary` text, bounded to 1200 chars as already enforced in `controller-final-phases.ts`).
  * Changing `queryRunLogs` or live SSE event subscription.
  * Changing CLI acceptance dialog copy.

## 2. Assumptions & Blockers

* **Assumptions:**
  * The dashboard is built separately via `npm run dashboard:build`. UI changes require a rebuild to be served by `dashboard:serve` — this is the existing workflow.
  * `queryRun` returning new keys does not break the existing `RunDetail` type consumers because they ignore unknown fields.
  * `AcceptanceEvidence` is read-only; no mutation through the dashboard.
  * The acceptance event is the authoritative source for the user-visible decision and feedback; `final-merge.json` is authoritative for landing outcome + post-landing verification. The reader combines both.

* **Questions / Blockers:**
  * None blocking. The plan picks "Acceptance" as a new tab. If you prefer Overview-only, drop Step 3's tab work and put the panel inside Overview — but the tab is the cleaner fit since the existing tabs are already separated (Plan, Logs, Verification).

## 3. Implementation Plan

* [ ] **Step 1: Extract a shared acceptance-evidence reader**

  * **Files:**
    * `Modify: packages/core/src/runs/show.ts:1-130`
  * **Interfaces:**
    * Consumes: existing readers `readJsonlFile`, `readJsonFile`, `stringValue`, `stringArray`, `booleanValue` from `packages/core/src/runs/show.ts:230-280`. Artifact fields `finalMerge.postLandingVerification`, `finalMerge.pullRequest`, `finalMerge.targetHeadBefore`, `finalMerge.targetHeadAfter`, `finalMerge.reason`. Event types `acceptance.accepted | acceptance.rejected | acceptance.revise_requested`.
    * Produces:
      ```ts
      // packages/core/src/runs/show.ts
      export interface AcceptanceEvidenceSummary {
        decision: "accept" | "revise" | "reject" | null;
        feedback?: string;
        landingStatus?: "landed" | "pull-request" | "skipped" | "blocked";
        landingPhase?: "complete" | "merge-blocked" | "pull-request-opened" | "accepted" | "accepted-with-pr" | "acceptance-blocked";
        landingReason?: string;
        pullRequest?: { status?: "created" | "existing" | "failed"; url?: string; sourceBranch?: string; targetBranch?: string; reason?: string };
        targetHeadBefore?: string;
        targetHeadAfter?: string;
        postLandingVerification?: { overallStatus?: "passed" | "failed" | "incomplete" | "error" | "pending"; commands?: string[]; reason?: string; repairAttempted?: boolean };
        verificationStatus?: "passed" | "failed" | "incomplete";
        contractComplete?: boolean;
        baselineDebt?: Array<{ commandName: string; category: string; reason: string; suggestedAction: string; implicatedFiles?: string[] }>;
        scopeWarnings?: Array<{ file: string; nonGoal: string }>;
        reviewVerdict?: { verdict: "block" | "pass" | "unknown"; summary: string };
      }

      export async function readAcceptanceEvidence(runDir: string): Promise<AcceptanceEvidenceSummary | undefined>;
      ```
      Returns `undefined` when neither `final-merge.json` nor any `acceptance.*` event exists (legacy / pre-acceptance runs). When the run is mid-flow (only some artifacts present), returns a partial object with the fields that are available.
  * **Code:**
    ```ts
    // packages/core/src/runs/show.ts (extract)
    export async function readAcceptanceEvidence(runDir: string): Promise<AcceptanceEvidenceSummary | undefined> {
      const finalMerge = await readJsonFile(path.join(runDir, "final-merge.json"));
      const events = await readJsonlFile(path.join(runDir, "events.jsonl"));
      // Find the latest acceptance.* event (events are chronological).
      const acceptanceEvent = [...events].reverse().find((event) =>
        event.type === "acceptance.accepted"
        || event.type === "acceptance.rejected"
        || event.type === "acceptance.revise_requested");
      const acceptanceData = (acceptanceEvent?.data ?? {}) as Record<string, unknown>;
      const innerEvidence = (acceptanceData.evidence ?? {}) as Record<string, unknown>;
      const reviewVerdict = innerEvidence.reviewVerdict as { verdict: string; summary: string } | undefined;
      const baselineDebt = Array.isArray(innerEvidence.baselineDebt)
        ? (innerEvidence.baselineDebt as Array<Record<string, unknown>>).map((entry) => ({
            commandName: stringValue(entry.commandName) ?? "",
            category: stringValue(entry.category) ?? "",
            reason: stringValue(entry.reason) ?? "",
            suggestedAction: stringValue(entry.suggestedAction) ?? "",
            ...(Array.isArray(entry.implicatedFiles) ? { implicatedFiles: entry.implicatedFiles.filter((file): file is string => typeof file === "string") } : {}),
          }))
        : undefined;
      const scopeWarnings = Array.isArray(innerEvidence.scopeWarnings)
        ? (innerEvidence.scopeWarnings as Array<Record<string, unknown>>).map((entry) => ({
            file: stringValue(entry.file) ?? "",
            nonGoal: stringValue(entry.nonGoal) ?? "",
          }))
        : undefined;
      const landingOutcome = innerEvidence.landingOutcome as Record<string, unknown> | undefined;
      const landingPullRequest = landingOutcome?.pullRequest as Record<string, unknown> | undefined;
      const plv = innerEvidence.postLandingVerification as Record<string, unknown> | undefined;
      const mergePlv = finalMerge?.postLandingVerification as Record<string, unknown> | undefined;
      // Prefer the event-embedded postLandingVerification; fall back to final-merge.json.
      const postLandingVerificationSource = plv ?? mergePlv;
      if (!finalMerge && !acceptanceEvent) return undefined;
      const decisionMap: Record<string, "accept" | "revise" | "reject"> = {
        "acceptance.accepted": "accept",
        "acceptance.revise_requested": "revise",
        "acceptance.rejected": "reject",
      };
      return {
        decision: acceptanceEvent ? (decisionMap[acceptanceEvent.type as string] ?? null) : null,
        ...(typeof acceptanceData.feedback === "string" ? { feedback: acceptanceData.feedback } : {}),
        ...(stringValue(acceptanceData.landingStatus) ? { landingStatus: stringValue(acceptanceData.landingStatus) as "landed" | "pull-request" | "skipped" | "blocked" } : {}),
        ...(stringValue(finalMerge?.phase) ? { landingPhase: stringValue(finalMerge?.phase) as AcceptanceEvidenceSummary["landingPhase"] } : {}),
        ...(stringValue(finalMerge?.reason ?? acceptanceData.feedback) ? { landingReason: stringValue(finalMerge?.reason ?? acceptanceData.feedback) } : {}),
        ...(landingPullRequest ? {
          pullRequest: {
            status: stringValue(landingPullRequest.status) as "created" | "existing" | "failed" | undefined,
            url: stringValue(landingPullRequest.url),
            sourceBranch: stringValue(landingPullRequest.sourceBranch),
            targetBranch: stringValue(landingPullRequest.targetBranch),
            reason: stringValue(landingPullRequest.reason),
          },
        } : {}),
        ...(stringValue(finalMerge?.targetHeadBefore) ? { targetHeadBefore: stringValue(finalMerge?.targetHeadBefore) } : {}),
        ...(stringValue(finalMerge?.targetHeadAfter) ? { targetHeadAfter: stringValue(finalMerge?.targetHeadAfter) } : {}),
        ...(postLandingVerificationSource ? {
          postLandingVerification: {
            overallStatus: stringValue(postLandingVerificationSource.status ?? postLandingVerificationSource.overallStatus) as "passed" | "failed" | "incomplete" | "error" | "pending" | undefined,
            commands: stringArray(postLandingVerificationSource.commands),
            reason: stringValue(postLandingVerificationSource.reason),
            repairAttempted: booleanValue(postLandingVerificationSource.repairAttempted),
          },
        } : {}),
        ...(stringValue(innerEvidence.verificationStatus) ? { verificationStatus: stringValue(innerEvidence.verificationStatus) as "passed" | "failed" | "incomplete" } : {}),
        ...(typeof innerEvidence.contractComplete === "boolean" ? { contractComplete: innerEvidence.contractComplete } : {}),
        ...(baselineDebt?.length ? { baselineDebt } : {}),
        ...(scopeWarnings?.length ? { scopeWarnings } : {}),
        ...(reviewVerdict ? {
          reviewVerdict: {
            verdict: (["block", "pass", "unknown"].includes(reviewVerdict.verdict) ? reviewVerdict.verdict : "unknown") as "block" | "pass" | "unknown",
            summary: reviewVerdict.summary.slice(0, 1200),
          },
        } : {}),
      };
    }
    ```
  * **Negative Paths:**
    * Missing both `final-merge.json` and `events.jsonl` → returns `undefined`. `queryRun` omits `acceptanceEvidence` (older/legacy runs).
    * `final-merge.json` present but no `acceptance.*` event (run is mid-flow or terminal landed without acceptance) → returns partial evidence with `decision: null` and the landing fields filled. This avoids crashing the UI.
    * `events.jsonl` malformed (one bad line) → existing `readJsonlFile` swallows parse errors per line and continues. New code does not introduce stricter parsing.
    * `evidence.reviewVerdict.summary` longer than 1200 chars → truncated to 1200 (matches the existing controller cap at `controller-final-phases.ts`).
    * `landingOutcome.pullRequest` missing fields → only include the keys that are present (no `undefined` slots).
  * **Verification:**
    * `npm run build` — PASS.
    * `node --test tests/queries.test.mjs` — PASS (new tests added in Step 2 cover the legacy + accepted paths).

* [ ] **Step 2: Wire the reader into `queryRun`**

  * **Files:**
    * `Modify: packages/core/src/queries/index.ts:104-135`
    * `Test: tests/queries.test.mjs` (new)
  * **Interfaces:**
    * Consumes: `readAcceptanceEvidence` from Step 1. Existing `queryRun` signature. `AcceptanceEvidenceSummary` from `packages/core/src/runs/show.ts`.
    * Produces: `queryRun` result gains an optional `acceptanceEvidence?: AcceptanceEvidenceSummary` field. Existing fields are unchanged. The new field is omitted (not `null`) when `readAcceptanceEvidence` returns `undefined`.
  * **Code:**
    ```ts
    // packages/core/src/queries/index.ts
    import { readAcceptanceEvidence, type AcceptanceEvidenceSummary } from "../runs/show.js";

    export async function queryRun(cwd: string, runId: string): Promise<Record<string, unknown> | undefined> {
      const project = await discoverFactoryProject(cwd);
      const runDir = path.join(project.paths.runsDir, runId);
      try {
        await fs.access(path.join(runDir, "state.json"));
      } catch {
        return undefined;
      }
      const [state, summary, plan, verification, modelLedger, decisions, acceptanceEvidence] = await Promise.all([
        readJson(path.join(runDir, "state.json")).catch(() => undefined),
        readJson(path.join(runDir, "summary.json")).catch(() => undefined),
        readJson(path.join(runDir, "plan.json")).catch(() => undefined),
        readJson(path.join(runDir, "verification.json")).catch(() => undefined),
        readModelLedgerLines(runDir),
        readDecisionLedger(runDir).catch(() => []),
        readAcceptanceEvidence(runDir),
      ]);
      const result: Record<string, unknown> = {
        runId,
        runDir,
        state,
        summary,
        plan,
        verification,
        models: modelLedger,
        decisions: decisions.map((entry) => (entry.type === "request" ? { type: "request", requestId: entry.request.id, question: entry.request.question } : { type: "resolution", requestId: entry.result.requestId, optionId: entry.result.optionId, feedback: entry.result.feedback })),
        status: state?.status ?? summary?.status,
        phase: state?.phase ?? summary?.phase,
        title: summary?.title,
        goal: summary?.goal,
      };
      if (acceptanceEvidence) result.acceptanceEvidence = acceptanceEvidence;
      return result;
    }
    ```
  * **Negative Paths:**
    * Legacy run with no acceptance artifacts → `acceptanceEvidence` is absent (key not present). UI treats it as "no acceptance yet" and hides the Acceptance tab.
    * Promise rejection from `readAcceptanceEvidence` is caught by `Promise.all` semantics — `Promise.all` rejects on first rejection. Wrap the new reader: `await readAcceptanceEvidence(runDir).catch(() => undefined)` so a missing/partial artifact does not fail the whole endpoint. (The `Promise.all` line above already uses that pattern implicitly because `readAcceptanceEvidence` itself returns `undefined` on missing artifacts.)
  * **Verification:**
    * `npm run build` — PASS.
    * `node --test tests/queries.test.mjs` — PASS (4 new tests):
      1. `queryRun returns acceptanceEvidence with reviewer block for an accepted run` (fixture: write a `summary.json` + `final-merge.json` + `events.jsonl` matching the real artifact shape; assert decision === "accept", reviewVerdict.verdict === "block", reviewVerdict.summary non-empty, landingStatus === "landed").
      2. `queryRun returns acceptanceEvidence for a pull-request landing` (fixture: `final-merge.json.pullRequest.status === "created"`; assert `pullRequest.status`, `landingPhase === "accepted-with-pr"`).
      3. `queryRun omits acceptanceEvidence for legacy runs` (fixture: only `summary.json` + `state.json`; assert the key is absent).
      4. `queryRun returns partial acceptanceEvidence when only final-merge is present` (fixture: `final-merge.json` exists, no `acceptance.*` event; assert `decision === null`, `landingStatus` populated, `reviewVerdict` undefined).

* [ ] **Step 3: Extend the dashboard `RunDetail` type and add the Acceptance tab**

  * **Files:**
    * `Modify: dashboard/src/api/client.ts:34-50`
    * `Modify: dashboard/src/pages/run-detail.tsx:1-158`
  * **Interfaces:**
    * Consumes: `RunDetail` from `dashboard/src/api/client.ts:34`. `AcceptanceEvidenceSummary` from Step 1 (re-declared in the dashboard's TypeScript surface as a structural type).
    * Produces:
      ```ts
      // dashboard/src/api/client.ts
      export interface AcceptanceEvidenceView {
        decision?: "accept" | "revise" | "reject" | null;
        feedback?: string;
        landingStatus?: "landed" | "pull-request" | "skipped" | "blocked";
        landingPhase?: "complete" | "merge-blocked" | "pull-request-opened" | "accepted" | "accepted-with-pr" | "acceptance-blocked";
        landingReason?: string;
        pullRequest?: { status?: "created" | "existing" | "failed"; url?: string; sourceBranch?: string; targetBranch?: string; reason?: string };
        targetHeadBefore?: string;
        targetHeadAfter?: string;
        postLandingVerification?: { overallStatus?: string; commands?: string[]; reason?: string; repairAttempted?: boolean };
        verificationStatus?: "passed" | "failed" | "incomplete";
        contractComplete?: boolean;
        baselineDebt?: Array<{ commandName: string; category: string; reason: string; suggestedAction: string; implicatedFiles?: string[] }>;
        scopeWarnings?: Array<{ file: string; nonGoal: string }>;
        reviewVerdict?: { verdict: "block" | "pass" | "unknown"; summary: string };
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
        plan?: RunPlan;
        verification?: Record<string, unknown>;
        models?: Array<Record<string, unknown>>;
        decisions?: Array<Record<string, unknown>>;
        acceptanceEvidence?: AcceptanceEvidenceView;
      }
      ```
      The page renders a new `"Acceptance"` tab (visible when `run.acceptanceEvidence` is present). The Overview tab shows a one-line summary above the existing sections.
  * **Code:**
    ```tsx
    // dashboard/src/pages/run-detail.tsx
    const TABS = ['Overview', 'Plan', 'Logs', 'Verification', 'Acceptance'] as const;

    // Inside RunDetail, after TABS declaration:
    const evidence = (run as RunDetailType & { acceptanceEvidence?: AcceptanceEvidenceView }).acceptanceEvidence;
    const hasAcceptance = Boolean(evidence);

    // Inside the Overview section, render a one-line acceptance summary:
    {evidence && (
      <section>
        <h5>Acceptance</h5>
        <p>
          Decision: <strong>{evidence.decision ?? 'pending'}</strong>
          {' · '}Landing: <StatusBadge status={evidence.landingStatus ?? evidence.landingPhase ?? 'unknown'} />
          {evidence.reviewVerdict?.verdict === 'block' && (
            <> · <span className="badge badge-blocked">reviewer block</span></>
          )}
        </p>
      </section>
    )}

    // New tab content:
    {tab === 'Acceptance' && evidence && (
      <article>
        <h5>Acceptance evidence</h5>
        {evidence.reviewVerdict?.verdict === 'block' && (
          <section className="attention">
            <h6>Reviewer blocking verdict: accepting overrides this finding.</h6>
            <p className="muted">Summary:</p>
            <pre className="plan-text">{evidence.reviewVerdict.summary}</pre>
          </section>
        )}
        {evidence.reviewVerdict?.verdict !== 'block' && evidence.reviewVerdict && (
          <section>
            <h6>Reviewer verdict</h6>
            <p>{evidence.reviewVerdict.verdict}</p>
            <pre className="plan-text">{evidence.reviewVerdict.summary}</pre>
          </section>
        )}

        <section className="grid">
          <article>
            <h6>Decision</h6>
            <p><strong>{evidence.decision ?? 'pending'}</strong></p>
            {evidence.feedback && <p className="muted">{evidence.feedback}</p>}
          </article>
          <article>
            <h6>Landing</h6>
            <p>Status: {evidence.landingStatus ?? 'unknown'}</p>
            <p>Phase: {evidence.landingPhase ?? 'unknown'}</p>
            {evidence.landingReason && <p className="muted">{evidence.landingReason}</p>}
            {evidence.targetHeadBefore && evidence.targetHeadAfter && (
              <p className="muted">Head {evidence.targetHeadBefore.slice(0, 7)} → {evidence.targetHeadAfter.slice(0, 7)}</p>
            )}
          </article>
        </section>

        {evidence.pullRequest && (
          <section>
            <h6>Pull request</h6>
            <p>Status: {evidence.pullRequest.status ?? 'unknown'}</p>
            <p>{evidence.pullRequest.sourceBranch} → {evidence.pullRequest.targetBranch}</p>
            {evidence.pullRequest.url && <p><a href={evidence.pullRequest.url}>{evidence.pullRequest.url}</a></p>}
            {evidence.pullRequest.reason && <p className="muted">{evidence.pullRequest.reason}</p>}
          </section>
        )}

        <section className="grid">
          <article>
            <h6>Verification</h6>
            <p>{evidence.verificationStatus ?? 'unknown'}</p>
            <p>Contract complete: {evidence.contractComplete === true ? 'yes' : evidence.contractComplete === false ? 'no' : 'unknown'}</p>
          </article>
          <article>
            <h6>Post-landing verification</h6>
            {evidence.postLandingVerification ? (
              <>
                <StatusBadge status={evidence.postLandingVerification.overallStatus ?? 'unknown'} />
                <p>Commands: {(evidence.postLandingVerification.commands ?? []).join(', ') || 'none'}</p>
                {evidence.postLandingVerification.reason && <p className="muted">{evidence.postLandingVerification.reason}</p>}
                {evidence.postLandingVerification.repairAttempted && <p className="muted">Repair attempted.</p>}
              </>
            ) : (
              <p className="muted">No post-landing verification recorded.</p>
            )}
          </article>
        </section>

        {evidence.baselineDebt && evidence.baselineDebt.length > 0 && (
          <section>
            <h6>Baseline debt</h6>
            {evidence.baselineDebt.map((debt, i) => (
              <div key={i} className="kv">
                <span>{debt.commandName}</span>
                <span>{debt.category}</span>
              </div>
            ))}
          </section>
        )}

        {evidence.scopeWarnings && evidence.scopeWarnings.length > 0 && (
          <section>
            <h6>Scope warnings</h6>
            {evidence.scopeWarnings.map((warning, i) => (
              <div key={i} className="kv">
                <span>{warning.file}</span>
                <span>{warning.nonGoal}</span>
              </div>
            ))}
          </section>
        )}
      </article>
    )}
    {tab === 'Acceptance' && !evidence && (
      <article><p className="muted">No acceptance evidence recorded for this run (legacy or pre-acceptance run).</p></article>
    )}
    ```
  * **Negative Paths:**
    * `evidence.reviewVerdict.summary` empty or whitespace → render no `<pre>` block; show only the verdict pill.
    * `evidence.postLandingVerification.commands` empty array → render `"Commands: none"`.
    * `evidence.pullRequest.url` undefined → no link rendered.
    * `evidence.feedback` empty string → omit the `<p className="muted">` line.
    * `run.acceptanceEvidence` undefined (legacy run) → tab still renders but shows a muted "No acceptance evidence recorded" message; it is not hidden from the tab list (so users understand the field exists but is empty).
  * **Verification:**
    * `npm run dashboard:build` — PASS (this is the dashboard's Preact build).
    * Manual: `npm run dashboard:serve`, navigate to `/runs/run_1788964288486_aa67cd23` (or any accepted run), confirm the Acceptance tab shows the reviewer block summary, decision, landing, baseline debt, and scope warnings.

* [ ] **Step 4: Documentation**

  * **Files:**
    * `Modify: docs/factory/troubleshooting.md:57-90` (one paragraph: dashboard run-detail now exposes acceptance evidence; explains reviewer-block surfacing)
    * `Modify: .pi/skills/factory-concierge/SKILL.md:120-140` (one sentence)
    * `Modify: skills/factory-concierge/SKILL.md:120-140` (mirror)
    * `Modify: learnings.md` (append a single-line entry)
  * **Interfaces:** No code changes.
  * **Code (documentation text):**
    ```
    ### Dashboard Acceptance Evidence

    The dashboard run-detail page now exposes the full acceptance evidence recorded at the acceptance dialog:
    reviewer verdict + summary (prominently surfaced when `verdict === "block"`), the user's decision
    (`accept | revise | reject`) and feedback, landing outcome (`landed | pull-request | skipped | blocked`)
    plus the target head before/after and any pull-request metadata, post-landing verification status with
    command list and reason, verification status, contract completion, baseline debt, and scope warnings.

    This data is read-only on the dashboard — the controller writes it once at the acceptance phase and
    never mutates it. Legacy runs without an acceptance phase return no `acceptanceEvidence` field; the
    Acceptance tab renders a muted "No acceptance evidence recorded" message in that case.
    ```
  * **Negative Paths:**
    * Documentation must not promise dashboard write capability.
  * **Verification:**
    * `grep -n "acceptance evidence\|Acceptance Evidence\|acceptanceEvidence" docs/factory/troubleshooting.md .pi/skills/factory-concierge/SKILL.md skills/factory-concierge/SKILL.md learnings.md` returns at least one hit in each.

## 4. Testing

* **Build, type-check, complexity:**
  * `npm run build` — PASS.
  * `npm run typecheck` — PASS.
  * `npm run complexity` — PASS.

* **Targeted tests:**
  * `node --test tests/queries.test.mjs` — PASS (4 tests added in Step 2).

* **Regression:**
  * `node --test tests/runtime.test.mjs` — PASS (no controller change; the existing acceptance-flow tests assert event shapes that this plan does not touch).
  * `node --test tests/failure-recovery.test.mjs` — PASS.
  * `node --test tests/pi-adapter.test.mjs` — PASS.
  * `node --test tests/landing.test.mjs` — PASS.

* **Dashboard build:**
  * `npm run dashboard:build` — PASS. The build emits `dashboard/dist/` which `dashboard:serve` serves. No separate test runner for the Preact frontend.

* **Full suite:**
  * `npm test` — PASS.

## 5. Definition of Done

* [ ] Required behavior works: `/api/runs/:id` returns `acceptanceEvidence` for any run with acceptance artifacts; the dashboard run-detail page renders an Acceptance tab and a one-line summary on Overview. The reviewer block summary is visible to a user opening an accepted run with `reviewVerdict.verdict === "block"`.
* [ ] Negative paths behave correctly: legacy runs (no `final-merge.json` or no `acceptance.*` event) get no `acceptanceEvidence` field; partial runs return a partial evidence object with `decision: null`; missing reviewer summary renders no `<pre>`; empty post-landing commands render `"none"`; missing pull-request URL renders no link.
* [ ] Tests pass (`npm test`).
* [ ] Type checks pass (`npm run typecheck`).
* [ ] Build passes (`npm run build`).
* [ ] Complexity guard passes (`npm run complexity`).
* [ ] Dashboard build passes (`npm run dashboard:build`).
* [ ] Migrations / config changes are validated: none. New optional `acceptanceEvidence` field is additive; existing API consumers ignore unknown keys.
* [ ] Documentation updated: `docs/factory/troubleshooting.md`, `.pi/skills/factory-concierge/SKILL.md`, `skills/factory-concierge/SKILL.md`, `learnings.md` describe the new acceptance-evidence dashboard surface.
