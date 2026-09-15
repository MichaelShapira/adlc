import { useState } from "react";
import { api } from "./api";
import type { ExecutionMode, Report, Run, RunEvent, RunLog, SecurityReview, UsageStatus } from "./types";
import {
  displayStatus,
  optionalString,
  safeArray,
  safeFixed,
  safeLowerClass,
  safeNonNegativeNumber,
  safeObjectArray,
  safeRecord,
  safeString,
  safeTime,
  shortId,
} from "./safe";

const PHASE_ICONS: Record<string, string> = {
  SUBMITTED: "1.",
  TRIAGE: "2.",
  DRAFT: "3.",
  GATE: "4.",
  IMPLEMENT: "5.",
  VALIDATE: "6.",
  REPORT: "7.",
};

function safeUsageStatus(value: unknown): UsageStatus {
  return value === "COMPLETE" || value === "PARTIAL" ||
    value === "UNAVAILABLE" || value === "NOT_APPLICABLE"
    ? value
    : "UNAVAILABLE";
}

function ApprovalPanel({ run, onChanged }: { run: Run; onChanged: () => void }) {
  const recommendedMode: ExecutionMode =
    run.triage?.complexity === "COMPLEX" ? "COMPLEX" : "SIMPLE";
  const [selectedMode, setSelectedMode] = useState<ExecutionMode>(recommendedMode);
  const [simplePrompt, setSimplePrompt] = useState(
    optionalString(run.draft?.simplePrompt) ?? optionalString(run.draft?.proposedFix) ?? ""
  );
  const [complexSpec, setComplexSpec] = useState(optionalString(run.draft?.complexSpec) ?? "");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const artifact = selectedMode === "SIMPLE" ? simplePrompt : complexSpec;

  const decide = async (action: "execute" | "cancel") => {
    const runId = optionalString(run.runId);
    if (!runId) {
      setError("This historical run has no usable run ID.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.decide(runId, action, selectedMode, artifact, feedback);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="approval execution-gate card warn-border">
      <div className="gate-heading">
        <div>
          <span className="eyebrow gate-eyebrow">EXECUTION GATE</span>
          <h3>Choose how Kiro should execute</h3>
        </div>
        <span className="recommendation-pill">
          Recommendation: {recommendedMode === "SIMPLE" ? "Simple / Vibe" : "Complex / Spec"}
        </span>
      </div>
      <p className="muted">
        Triage is advisory. Choose either path, review its independently editable artifact,
        then freeze it for implementation and validation.
      </p>

      <div className="mode-card-grid" role="radiogroup" aria-label="Execution mode">
        <button
          type="button"
          role="radio"
          aria-checked={selectedMode === "SIMPLE"}
          className={`mode-card ${selectedMode === "SIMPLE" ? "selected" : ""}`}
          onClick={() => setSelectedMode("SIMPLE")}
        >
          <span className="mode-icon">S</span>
          <strong>Simple / Vibe</strong>
          <small>Direct normal Kiro chat with a concise approved prompt.</small>
          {recommendedMode === "SIMPLE" && <em>Recommended</em>}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={selectedMode === "COMPLEX"}
          className={`mode-card ${selectedMode === "COMPLEX" ? "selected" : ""}`}
          onClick={() => setSelectedMode("COMPLEX")}
        >
          <span className="mode-icon">C</span>
          <strong>Complex / Spec</strong>
          <small>Normal Kiro chat grounded in an approved Markdown specification.</small>
          {recommendedMode === "COMPLEX" && <em>Recommended</em>}
        </button>
      </div>

      <label className="field-label" htmlFor="approved-artifact">
        {selectedMode === "SIMPLE" ? "Approved implementation prompt" : "Approved Markdown spec"}
      </label>
      <textarea
        id="approved-artifact"
        className="artifact-editor"
        rows={18}
        maxLength={50000}
        value={artifact}
        onChange={(event) =>
          selectedMode === "SIMPLE"
            ? setSimplePrompt(event.target.value)
            : setComplexSpec(event.target.value)
        }
      />
      <div className="artifact-meta">
        <span>{artifact.length.toLocaleString()} / 50,000 characters</span>
        <span>Validation will use this exact frozen artifact.</span>
      </div>
      <textarea
        rows={3}
        maxLength={4000}
        placeholder="Optional execution note"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
      />
      {error && <p className="error">{error}</p>}
      <div className="button-row">
        <button
          className="primary"
          disabled={busy || !artifact.trim()}
          onClick={() => decide("execute")}
        >
          {busy ? "Submitting…" : "Execute with Kiro"}
        </button>
        <button className="danger" disabled={busy} onClick={() => decide("cancel")}>
          Cancel run
        </button>
      </div>
    </div>
  );
}

function UsageStatusPill({ status }: { status: unknown }) {
  const safeStatus = safeUsageStatus(status);
  return (
    <span className={`usage-status ${safeLowerClass(safeStatus)}`}>
      {displayStatus(safeStatus)}
    </span>
  );
}

function formatUsageNumber(
  value: unknown,
  statusValue: unknown,
  maximumFractionDigits = 0
) {
  const status = safeUsageStatus(statusValue);
  if (status === "NOT_APPLICABLE") return "Not applicable";
  const number = safeNonNegativeNumber(value);
  if (number === null) return "Unavailable";
  return number.toLocaleString(undefined, { maximumFractionDigits });
}

function formatUsageUsd(value: unknown, statusValue: unknown) {
  const status = safeUsageStatus(statusValue);
  if (status === "NOT_APPLICABLE") return "Not applicable";
  const formatted = safeFixed(value, 4);
  return formatted === "Unavailable" ? formatted : `$${formatted}`;
}

const RISK_COLORS: Record<string, string> = {
  CRITICAL: "#ff4444",
  HIGH: "#ff8800",
  MEDIUM: "#ffcc00",
  LOW: "#4488ff",
  INFORMATIONAL: "#888",
  UNKNOWN: "#888",
};

function SecurityReviewCard({ securityReview }: { securityReview?: SecurityReview }) {
  if (!securityReview) return null;

  // Show in-progress state
  if (!securityReview.reviewed) {
    return (
      <section className="card" style={{ borderLeft: "3px solid #3b82f6" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ fontSize: "1.4rem" }}>🔒</span>
          <h3 style={{ margin: 0 }}>Security Review</h3>
          <span style={{
            marginLeft: "auto", padding: "0.2rem 0.6rem", borderRadius: "4px",
            fontSize: "0.8rem", fontWeight: 600, color: "#fff", backgroundColor: "#3b82f6",
          }}>IN PROGRESS</span>
        </div>
        <p style={{ color: "#aaa", fontSize: "0.85rem", margin: "0.5rem 0 0" }}>
          AWS Security Agent is scanning... ({securityReview.phase === "CODE_REVIEW" ? "Code Review" : "Penetration Test"})
        </p>
      </section>
    );
  }

  const { passed, findingsCount, criticalCount, highCount, mediumCount, lowCount, findings } = securityReview;

  return (
    <section className="card" style={{ borderLeft: passed ? "3px solid #22c55e" : "3px solid #ff4444" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
        <span style={{ fontSize: "1.4rem" }}>{passed ? "🛡️" : "⚠️"}</span>
        <h3 style={{ margin: 0 }}>Security Review</h3>
        <span
          style={{
            marginLeft: "auto",
            padding: "0.2rem 0.6rem",
            borderRadius: "4px",
            fontSize: "0.8rem",
            fontWeight: 600,
            color: "#fff",
            backgroundColor: passed ? "#22c55e" : "#ff4444",
          }}
        >
          {passed ? "PASSED" : "FAILED"}
        </span>
      </div>

      <p style={{ color: "#aaa", fontSize: "0.85rem", margin: "0 0 0.75rem" }}>
        AWS Security Agent — Code Review{securityReview.codeReviewId ? " ✅" : ""} + Penetration Test{securityReview.pentestId ? " ✅" : ""}
      </p>

      {/* Severity badges */}
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
        {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((level) => {
          const count = level === "CRITICAL" ? criticalCount : level === "HIGH" ? highCount : level === "MEDIUM" ? mediumCount : lowCount;
          return (
            <div
              key={level}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.3rem",
                padding: "0.25rem 0.5rem",
                borderRadius: "4px",
                backgroundColor: count > 0 ? RISK_COLORS[level] + "22" : "#333",
                border: `1px solid ${count > 0 ? RISK_COLORS[level] : "#555"}`,
                fontSize: "0.8rem",
              }}
            >
              <strong style={{ color: count > 0 ? RISK_COLORS[level] : "#888" }}>{count}</strong>
              <span style={{ color: "#ccc" }}>{level}</span>
            </div>
          );
        })}
        <div style={{ padding: "0.25rem 0.5rem", fontSize: "0.8rem", color: "#aaa" }}>
          {findingsCount} total finding{findingsCount !== 1 ? "s" : ""}
        </div>
      </div>

      {/* Findings list */}
      {findings && findings.length > 0 ? (
        <div style={{ maxHeight: "300px", overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #444", textAlign: "left" }}>
                <th style={{ padding: "0.4rem", color: "#aaa" }}>Finding</th>
                <th style={{ padding: "0.4rem", color: "#aaa" }}>Risk</th>
                <th style={{ padding: "0.4rem", color: "#aaa" }}>Confidence</th>
                <th style={{ padding: "0.4rem", color: "#aaa" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f, i) => (
                <tr key={f.findingId || i} style={{ borderBottom: "1px solid #333" }}>
                  <td style={{ padding: "0.4rem" }}>{f.name}</td>
                  <td style={{ padding: "0.4rem" }}>
                    <span style={{ color: RISK_COLORS[f.riskLevel] || "#888", fontWeight: 600 }}>
                      {f.riskLevel}
                    </span>
                  </td>
                  <td style={{ padding: "0.4rem", color: "#ccc" }}>{f.confidence}</td>
                  <td style={{ padding: "0.4rem", color: "#ccc" }}>{f.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p style={{ color: "#22c55e", fontWeight: 500 }}>✅ No security issues found</p>
      )}
    </section>
  );
}

function ReportCard({ run }: { run: Run }) {
  const reportRecord = safeRecord(run.report);
  if (!reportRecord) return null;
  const r = reportRecord as unknown as Report;
  const totalSeconds = safeNonNegativeNumber(r.totalTimeSeconds);
  const minutes = totalSeconds === null ? null : Math.floor(totalSeconds / 60);
  const seconds = totalSeconds === null ? null : totalSeconds % 60;
  const usage = safeRecord(r.usageBreakdown);
  const analysis = safeRecord(usage?.analysis);
  const kiro = safeRecord(usage?.kiro);
  const agentCore = safeRecord(usage?.agentCore);
  const security = safeRecord(usage?.security);
  const analysisStatus = safeUsageStatus(analysis?.status);
  const kiroStatus = safeUsageStatus(kiro?.status);
  const agentCoreStatus = safeUsageStatus(agentCore?.status);
  const securityStatus = safeUsageStatus(security?.status);
  const sessions = safeObjectArray<Record<string, unknown>>(agentCore?.sessions);
  const failure = safeRecord(r.failure);
  return (
    <div className="card report">
      <h3>Completion report</h3>
      <p>{safeString(r.headline)}</p>
      {failure && (
        <div className="failure-alert" role="alert">
          <strong>Failure at {safeString(failure.stage)}</strong>
          <code>{safeString(failure.code)}</code>
          <p>{safeString(failure.message)}</p>
          <small>
            {failure.retryable === true
              ? "This failure was classified as retryable. Start a new run when the service is available."
              : "Review the stage inputs and configuration before starting a new run."}
          </small>
        </div>
      )}
      <div className="stats">
        <div>
          <span className="stat-value">
            {minutes === null || seconds === null ? "Unavailable" : `${minutes}m ${seconds}s`}
          </span>
          <span className="stat-label">total time</span>
        </div>
        <div>
          <span className="stat-value">{formatUsageUsd(r.totalCostUsd, "COMPLETE")}</span>
          <span className="stat-label">cost consumed</span>
        </div>
        <div>
          <span className="stat-value">{safeNonNegativeNumber(r.tasksCompleted) ?? "Unavailable"}</span>
          <span className="stat-label">tasks completed</span>
        </div>
        <div>
          <span className="stat-value">{safeNonNegativeNumber(r.fixLoops) ?? "Unavailable"}</span>
          <span className="stat-label">fix loops</span>
        </div>
      </div>

      <section className="usage-breakdown" aria-labelledby="usage-breakdown-title">
        <div className="usage-heading">
          <div>
            <span className="eyebrow">MEASURED USAGE</span>
            <h4 id="usage-breakdown-title">Usage &amp; cost breakdown</h4>
          </div>
          {!usage && (
            <span className="muted small">Unavailable for this historical run</span>
          )}
        </div>
        <div className="usage-card-grid">
          <article className="usage-card analysis-usage">
            <div className="usage-card-heading">
              <div>
                <span className="usage-icon">A</span>
                <strong>Analysis</strong>
              </div>
              <UsageStatusPill status={analysisStatus} />
            </div>
            <dl className="usage-metrics">
              <div className="usage-wide">
                <dt>Model</dt>
                <dd><code>{safeString(analysis?.modelId ?? r.analysisModel)}</code></dd>
              </div>
              <div><dt>Calls</dt><dd>{formatUsageNumber(analysis?.calls, analysisStatus)}</dd></div>
              <div><dt>Input tokens</dt><dd>{formatUsageNumber(analysis?.inputTokens, analysisStatus)}</dd></div>
              <div><dt>Output tokens</dt><dd>{formatUsageNumber(analysis?.outputTokens, analysisStatus)}</dd></div>
              <div><dt>Total tokens</dt><dd>{formatUsageNumber(analysis?.totalTokens, analysisStatus)}</dd></div>
              <div><dt>Cost</dt><dd>{formatUsageUsd(analysis?.costUsd, analysisStatus)}</dd></div>
            </dl>
            <p className="usage-note">Triage and draft calls using the selected analysis model only.</p>
          </article>

          <article className="usage-card kiro-usage">
            <div className="usage-card-heading">
              <div>
                <span className="usage-icon">K</span>
                <strong>Kiro</strong>
              </div>
              <UsageStatusPill status={kiroStatus} />
            </div>
            <dl className="usage-metrics">
              <div><dt>Credits</dt><dd>{formatUsageNumber(kiro?.credits, kiroStatus, 4)}</dd></div>
              <div><dt>Attempts</dt><dd>{safeNonNegativeNumber(kiro?.attempts ?? r.fixLoops) ?? "Unavailable"}</dd></div>
              <div className="usage-wide"><dt>Cost</dt><dd>{formatUsageUsd(kiro?.costUsd, kiroStatus)}</dd></div>
            </dl>
            <p className="usage-note">
              {kiroStatus === "NOT_APPLICABLE"
                ? "This historical run did not execute Kiro, so credits do not apply."
                : "Credits parsed from Kiro output for immutable implementation attempts."}
            </p>
          </article>

          <article className="usage-card agentcore-usage">
            <div className="usage-card-heading">
              <div>
                <span className="usage-icon">C</span>
                <strong>AgentCore runtime</strong>
              </div>
              <UsageStatusPill status={agentCoreStatus} />
            </div>
            <dl className="usage-metrics">
              <div><dt>CPU seconds</dt><dd>{formatUsageNumber(agentCore?.cpuSeconds, agentCoreStatus, 3)}</dd></div>
              <div><dt>Peak memory</dt><dd>{formatUsageNumber(agentCore?.peakMemoryMiB, agentCoreStatus, 2)}{safeNonNegativeNumber(agentCore?.peakMemoryMiB) !== null && agentCoreStatus !== "NOT_APPLICABLE" ? " MiB" : ""}</dd></div>
              <div className="usage-wide"><dt>Attempts</dt><dd>{safeNonNegativeNumber(agentCore?.attempts ?? r.fixLoops) ?? "Unavailable"}</dd></div>
            </dl>
            <div className="usage-sessions">
              <span>Sessions</span>
              {sessions.length ? (
                <ul>
                  {sessions.map((session, index) => (
                    <li key={`${safeNonNegativeNumber(session.attempt) ?? index}-${safeString(session.runtimeSessionId, "unavailable")}`}>
                      <span>Attempt {safeNonNegativeNumber(session.attempt) ?? "Unavailable"}</span>
                      <code>{safeString(session.runtimeSessionId)}</code>
                      {optionalString(session.traceId) && <small>Trace: {safeString(session.traceId)}</small>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">
                  {agentCoreStatus === "NOT_APPLICABLE"
                    ? "No AgentCore implementation attempts."
                    : "Session telemetry unavailable."}
                </p>
              )}
            </div>
            <p className="usage-source">
              Source: {safeString(agentCore?.source, "cgroup-v2 usage log")}. Session-correlated runtime data; not account-wide metrics.
            </p>
          </article>

          {securityStatus !== "NOT_APPLICABLE" && (
            <article className="usage-card security-usage">
              <div className="usage-card-heading">
                <div>
                  <span className="usage-icon">🔒</span>
                  <strong>Security review</strong>
                </div>
                <UsageStatusPill status={securityStatus} />
              </div>
              <dl className="usage-metrics">
                <div className="usage-wide"><dt>Mode</dt><dd>{safeString(security?.mode, "skip")}</dd></div>
                <div><dt>Task hours</dt><dd>{formatUsageNumber(security?.taskHours, securityStatus, 2)}</dd></div>
                <div><dt>Rate</dt><dd>$50/hr</dd></div>
                <div className="usage-wide"><dt>Cost</dt><dd>{formatUsageUsd(security?.costUsd, securityStatus)}</dd></div>
              </dl>
              <p className="usage-note">
                AWS Security Agent pentest — billed at $50 per task-hour. Code review is free.
              </p>
            </article>
          )}
        </div>
      </section>

      {optionalString(r.fixBranch) && (
        <p className="muted small">
          Fix branch: <code>{safeString(r.fixBranch)}</code>
          {optionalString(r.engine) ? ` — implemented by ${safeString(r.engine)}` : ""}
        </p>
      )}
    </div>
  );
}

export function RunDetail({
  run,
  onChanged,
  onInspectFix,
}: {
  run: Run;
  onChanged: () => void;
  onInspectFix: (runId: string) => void;
}) {
  const runId = optionalString(run.runId);
  const status = optionalString(run.status);
  const triage = safeRecord(run.triage);
  const implementation = safeRecord(run.implementResult);
  const validation = safeRecord(run.validation);
  const issues = safeArray<unknown>(validation?.issues);
  const checks = safeObjectArray<Record<string, unknown>>(validation?.checks);
  const passedChecks = checks.filter((check) => check.pass === true).length;
  const buildOk = typeof implementation?.buildOk === "boolean"
    ? implementation.buildOk
    : null;
  const attempt =
    safeNonNegativeNumber(implementation?.attempt) ??
    safeNonNegativeNumber(validation?.fixAttempts);
  const logs = safeObjectArray<RunLog>(run.logs);
  const events = safeObjectArray<RunEvent>(run.events);
  const displayRunStatus = displayStatus(status);
  return (
    <div>
      <div className="detail-header">
        <h2>{safeString(triage?.title, runId ? `Run ${shortId(runId)}` : "Run unavailable")}</h2>
        <span className={`badge big ${status === "COMPLETED" ? "ok" : status && ["AWAITING_APPROVAL", "CANCELLED"].includes(status) ? "warn" : status && ["FAILED", "REJECTED", "NEEDS_HUMAN"].includes(status) ? "bad" : "info"}`}>
          {displayRunStatus}
        </span>
      </div>

      {!runId && <div className="notice error-notice">This historical item has no usable run ID. Actions are unavailable.</div>}

      {triage && (
        <p className="muted">
          Triage: <strong>{safeString(triage.complexity)}</strong> ({safeNonNegativeNumber(triage.estimatedFiles) ?? "Unavailable"}{" "}
          file(s)) — {safeString(triage.reasoning)}
        </p>
      )}

      <p className="muted model-summary">
        Analysis model: <code>{safeString(run.analysisModel, "default")}</code>
        {" · "}Implementation model: <code>{safeString(run.kiroModel, "auto")}</code>
        {optionalString(implementation?.actualModel) && (
          <> · Actual implementation model: <code>{safeString(implementation?.actualModel)}</code></>
        )}
        {optionalString(implementation?.executionMode) && ` · Mode: ${safeString(implementation?.executionMode)}`}
        {optionalString(implementation?.engine) && ` · Engine: ${safeString(implementation?.engine)}`}
      </p>

      {status === "AWAITING_APPROVAL" && (
        <ApprovalPanel run={run} onChanged={onChanged} />
      )}

      {validation && validation.pass === false && issues.length > 0 && (
        <div className="card bad-border">
          <h3>Validation findings (fix loop in progress)</h3>
          <ul>
            {issues.map((issue, index) => (
              <li key={index}>{safeString(issue)}</li>
            ))}
          </ul>
        </div>
      )}

      <ReportCard run={run} />

      {/* Security Review Section */}
      <SecurityReviewCard securityReview={run.securityReview as SecurityReview | undefined} />

      {(implementation || validation || optionalString(run.fixBranch)) && (
        <section className="card verification-card" aria-labelledby="verification-title">
          <div className="verification-heading">
            <div>
              <span className="eyebrow">DEFENSE IN DEPTH</span>
              <h3 id="verification-title">How this fix is verified</h3>
              <p className="muted">
                Execution evidence is kept separate from the generated implementation claim.
              </p>
            </div>
            {optionalString(run.fixBranch) && (
              <button
                className="primary"
                disabled={!runId}
                onClick={() => runId && onInspectFix(runId)}
              >
                Inspect fix →
              </button>
            )}
          </div>

          <div className="verification-metrics" aria-label="Verification results">
            <div>
              <span>Build gate</span>
              <strong className={buildOk === true ? "text-pass" : buildOk === false ? "text-fail" : ""}>
                {buildOk === true ? "Passed" : buildOk === false ? "Failed" : "Unavailable"}
              </strong>
            </div>
            <div>
              <span>Checks passed</span>
              <strong className={checks.length > 0 && passedChecks === checks.length ? "text-pass" : checks.length > 0 ? "text-fail" : ""}>
                {passedChecks}/{checks.length}
              </strong>
            </div>
            <div>
              <span>Implementation attempt</span>
              <strong>{attempt ?? "—"}/3</strong>
            </div>
          </div>

          <ol className="verification-layers">
            <li><span>1</span><div><strong>Frozen artifact</strong><small>The approved prompt or spec is reused unchanged for every attempt.</small></div></li>
            <li><span>2</span><div><strong>Hard build gate</strong><small>A failed project build cannot be reported as a validated fix.</small></div></li>
            <li><span>3</span><div><strong>Independent validator</strong><small>Validation reviews the repository result against the frozen artifact.</small></div></li>
            <li><span>4</span><div><strong>Three-attempt loop</strong><small>Validation findings can drive bounded retries without changing the approval.</small></div></li>
            <li><span>5</span><div><strong>Security Agent review</strong><small>AWS Security Agent runs automated penetration testing and code security analysis.</small></div></li>
            <li><span>6</span><div><strong>Immutable diff + human inspection</strong><small>The fix branch preserves the source diff and evidence for direct review.</small></div></li>
          </ol>
        </section>
      )}

      <div className="card">
        <div className="log-header">
          <h3>Agent logs</h3>
          <span className="muted small">live · refreshes every 3 seconds</span>
        </div>
        {logs.length === 0 ? (
          <p className="muted">No agent logs yet.</p>
        ) : (
          <div className="log-viewer" role="log" aria-live="polite">
            {logs.map((log, index) => (
              <div className={`log-line ${safeLowerClass(log.level)}`} key={`${safeString(log.ts, "unknown")}-${index}`}>
                <time>{safeTime(log.ts)}</time>
                <span className="log-level">{safeString(log.level)}</span>
                <span className="log-stage">{safeString(log.stage)}</span>
                <span className="log-message">{safeString(log.message)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3>Timeline</h3>
        <ol className="timeline">
          {events.map((event, index) => {
            const phase = safeString(event.phase);
            const cost = safeNonNegativeNumber(event.costUsd);
            return (
            <li key={index}>
              <span className="phase">
                {PHASE_ICONS[phase] ?? "•"} {phase}
              </span>
              <span className="message">{safeString(event.message)}</span>
              <span className="meta">
                {safeTime(event.ts)}
                {cost !== null ? ` · $${safeFixed(cost, 4)}` : ""}
              </span>
            </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
