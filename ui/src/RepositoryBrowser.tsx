import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type {
  BugTarget,
  RepositoryFile,
  RepositoryRef,
  RepositoryRefsResponse,
  RepositoryTreeEntry,
  ResetStatus,
  ReviewFile,
  RunReview,
} from "./types";
import {
  optionalString,
  safeArray,
  safeNonNegativeNumber,
  safeObjectArray,
  safePathParts,
  safeLines,
  safeRecord,
  safeString,
  shortId,
} from "./safe";

function CodeViewer({
  file,
  highlight,
  tone = "neutral",
}: {
  file: RepositoryFile | null;
  highlight?: { start: number; end: number };
  tone?: "neutral" | "before" | "after";
}) {
  const activeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [file?.path, highlight?.start]);
  if (!file) return <div className="code-empty">Select a file to inspect its source.</div>;
  const path = safeString(file.path);
  const content = typeof file.content === "string" ? file.content : null;
  const commitId = file.commitId ?? file.baseCommitId ?? file.fixCommitId;
  const size = safeNonNegativeNumber(file.size) ?? content?.length;
  if (content === null) {
    return <div className="code-empty">Source content is unavailable for this revision.</div>;
  }
  return (
    <div className={`source-viewer ${tone}`}>
      <div className="source-toolbar">
        <span>{path}</span>
        <span>{shortId(commitId, 9)} · {size ?? "Unavailable"} bytes</span>
      </div>
      <div className="source-code">
        {safeLines(content).map((line, index) => {
          const number = index + 1;
          const active = !!highlight && number >= highlight.start && number <= highlight.end;
          return (
            <div
              className={`source-line ${active ? "problem-line" : ""}`}
              key={number}
              ref={active && number === highlight?.start ? activeRef : undefined}
            >
              <span className="line-number">{number}</span>
              <code>{line || " "}</code>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EvidencePanel({
  review,
  panelRef,
}: {
  review: RunReview;
  panelRef?: React.Ref<HTMLElement>;
}) {
  const evidence = safeRecord(review.evidence);
  const implementation = safeRecord(evidence?.implementation) ?? {};
  const validation = safeRecord(evidence?.validation);
  const validationPass = validation?.pass === true;
  const buildOk = implementation.buildOk === true;
  const checks = safeObjectArray<Record<string, unknown>>(validation?.checks);
  const agentSummary = safeString(implementation.summary, "");
  return (
    <aside className="evidence-panel" ref={panelRef}>
      <div className="evidence-title">
        <span className={`status-dot ${validationPass ? "pass" : "fail"}`} />
        <div>
          <strong>{validationPass ? "Fix verified" : "Verification not green"}</strong>
          <small>Independent validation evidence</small>
        </div>
      </div>
      <div className="evidence-grid">
        <div><span>Build</span><strong className={buildOk ? "text-pass" : "text-fail"}>{buildOk ? "Passed" : "Failed"}</strong></div>
        <div><span>Engine</span><strong>{safeString(implementation.engine)}</strong></div>
        <div><span>Model</span><strong>{safeString(implementation.actualModel)}</strong></div>
        <div><span>Attempt</span><strong>{safeNonNegativeNumber(implementation.attempt) ?? "Unavailable"}</strong></div>
      </div>
      {agentSummary && agentSummary !== "Unavailable" && (
        <div className="agent-report">
          <h4>Coding agent's implementation report</h4>
          <p className="muted small">
            The agent's own account of the steps it took, captured verbatim from the
            run. Treat it as a claim — the build gate and validation checks below are
            the independent evidence.
          </p>
          <div className="agent-report-text">{agentSummary}</div>
        </div>
      )}
      <div className="commit-pair">
        <span>Base <code>{shortId(safeRecord(review.base)?.commitId, 10)}</code></span>
        <span>Fix <code>{shortId(safeRecord(review.fix)?.commitId, 10)}</code></span>
      </div>
      <h4>Validation checks</h4>
      {checks.length ? (
        <ul className="check-list">
          {checks.map((check, index) => {
            const passed = check.pass === true;
            return (
              <li key={index} className={passed ? "passed" : "failed"}>
                <span>{passed ? "✓" : "×"}</span>
                <div><strong>{safeString(check.requirement)}</strong><small>{safeString(check.note)}</small></div>
              </li>
            );
          })}
        </ul>
      ) : <p className="muted small">Validation checks are unavailable.</p>}
      <details>
        <summary>Build gate evidence</summary>
        <p className="muted small">
          Raw output of the verification build that ran against the fixed code.
          This is the hard gate: a fix cannot be reported as validated unless this
          command exited 0.
        </p>
        <pre className="build-output">$ {safeString(implementation.buildCommand)}{"\n"}{safeString(implementation.buildOutput, "(no output)")}</pre>
        {buildOk && (
          <p className="muted small">
            A passing TypeScript build is silent — the compiler prints errors only.
            Seeing just the command above means zero compile errors.
          </p>
        )}
      </details>
    </aside>
  );
}

export function RepositoryBrowser({ initialRunId }: { initialRunId?: string }) {
  const [metadata, setMetadata] = useState<RepositoryRefsResponse>();
  const [selectedRef, setSelectedRef] = useState("main");
  const [folderPath, setFolderPath] = useState("");
  const [entries, setEntries] = useState<RepositoryTreeEntry[]>([]);
  const [file, setFile] = useState<RepositoryFile | null>(null);
  const [highlight, setHighlight] = useState<{ start: number; end: number }>();
  const [review, setReview] = useState<RunReview>();
  const [reviewPath, setReviewPath] = useState("");
  const [resetStatus, setResetStatus] = useState<ResetStatus>();
  const [showReset, setShowReset] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const evidenceRef = useRef<HTMLElement | null>(null);
  const [pendingEvidenceScroll, setPendingEvidenceScroll] = useState(false);

  const loadFolder = useCallback(async (ref: string, path = "") => {
    const tree = await api.repositoryTree(ref, path);
    setEntries(safeObjectArray<RepositoryTreeEntry>(safeRecord(tree)?.entries));
    setFolderPath(path);
  }, []);

  const refresh = useCallback(async () => {
    const [refsValue, statusValue] = await Promise.all([api.repositoryRefs(), api.resetStatus()]);
    const refs = safeRecord(refsValue);
    if (!refs) throw new Error("Repository metadata is unavailable.");
    setMetadata(refs as unknown as RepositoryRefsResponse);
    const status = safeRecord(statusValue);
    setResetStatus(status ? status as unknown as ResetStatus : undefined);
    return refs as unknown as RepositoryRefsResponse;
  }, []);

  useEffect(() => {
    setBusy(true);
    refresh()
      .then(async (refs) => {
        const target = initialRunId
          ? safeObjectArray<RepositoryRef>(refs.refs).find((ref) => ref.runId === initialRunId)
          : undefined;
        if (target?.runId) {
          setSelectedRef(safeString(target.name, "main"));
          const loadedValue = await api.runReview(target.runId);
          const loaded = safeRecord(loadedValue);
          if (!loaded) throw new Error("Code review data is unavailable.");
          const reviewValue = loaded as unknown as RunReview;
          setReview(reviewValue);
          setReviewPath(safeString(safeObjectArray<ReviewFile>(reviewValue.files)[0]?.path, ""));
          setPendingEvidenceScroll(true);
        } else {
          await loadFolder("main");
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  }, [initialRunId, loadFolder, refresh]);

  useEffect(() => {
    if (!pendingEvidenceScroll || !review) return;
    const frame = requestAnimationFrame(() => {
      evidenceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      setPendingEvidenceScroll(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingEvidenceScroll, review]);

  const openFile = async (ref: string, path: string, lines?: { start: number; end: number }) => {
    setBusy(true);
    setError("");
    try {
      setFile(await api.repositoryFile(ref, path));
      setHighlight(lines);
      setReview(undefined);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const selectRef = async (ref: RepositoryRef) => {
    const refName = safeString(ref.name, "main");
    setSelectedRef(refName);
    setFile(null);
    setHighlight(undefined);
    setError("");
    setBusy(true);
    try {
      if (ref.kind === "fix" && typeof ref.runId === "string" && ref.runId) {
        const loadedValue = await api.runReview(ref.runId);
        const loaded = safeRecord(loadedValue);
        if (!loaded) throw new Error("Code review data is unavailable.");
        const reviewValue = loaded as unknown as RunReview;
        setReview(reviewValue);
        setReviewPath(safeString(safeObjectArray<ReviewFile>(reviewValue.files)[0]?.path, ""));
      } else {
        setReview(undefined);
        await loadFolder(refName);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const jumpToBug = async (target: BugTarget) => {
    const targetPath = safeString(target.path, "");
    if (!targetPath) {
      setError("Bug target source path is unavailable.");
      return;
    }
    const parts = safePathParts(targetPath);
    setSelectedRef("main");
    setFolderPath(parts.slice(0, -1).join("/"));
    await openFile("main", targetPath, {
      start: safeNonNegativeNumber(target.lineStart) ?? 1,
      end: safeNonNegativeNumber(target.lineEnd) ?? 1,
    });
  };

  const runReset = async () => {
    if (!resetStatus || !requiredConfirmation || confirmation !== requiredConfirmation) {
      setError("Repository reset confirmation is unavailable or does not match.");
      return;
    }
    const mainHeadCommitId = optionalString(resetStatus.mainHeadCommitId);
    if (!mainHeadCommitId) {
      setError("Repository reset metadata is unavailable.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = safeRecord(await api.resetRepository(confirmation, mainHeadCommitId));
      if (!result) throw new Error("Repository reset response is unavailable.");
      setNotice(result.alreadyCanonical === true ? "Repository was already in the canonical buggy state." : "Canonical buggy state restored. Fix branches and run history were preserved.");
      setShowReset(false);
      setConfirmation("");
      setSelectedRef("main");
      setReview(undefined);
      setFile(null);
      await refresh();
      await loadFolder("main");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteFixRevision = async () => {
    const target = safeObjectArray<RepositoryRef>(metadata?.refs).find(
      (candidate) => candidate.name === selectedRef
    );
    const targetRunId = optionalString(target?.runId);
    const targetName = optionalString(target?.name);
    const targetCommitId = optionalString(target?.commitId);
    if (!target || target.kind !== "fix" || !targetRunId || !targetName || !targetCommitId || targetName === "main") return;
    setBusy(true);
    setError("");
    try {
      await api.deleteFixBranch(targetRunId, deleteConfirmation, targetCommitId);
      setNotice(`Deleted ${targetName}. Its code review is no longer available, but run history remains.`);
      setShowDelete(false);
      setDeleteConfirmation("");
      setSelectedRef("main");
      setReview(undefined);
      setFile(null);
      await refresh();
      await loadFolder("main");
    } catch (e) {
      setError(String(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const refs = safeObjectArray<RepositoryRef>(metadata?.refs);
  const reviewFiles = safeObjectArray<ReviewFile>(review?.files);
  const selectedRefRecord = useMemo(
    () => refs.find((candidate) => candidate.name === selectedRef),
    [refs, selectedRef]
  );
  const selectedReviewFile = useMemo(
    () => reviewFiles.find((candidate) => candidate.path === reviewPath),
    [reviewFiles, reviewPath]
  );
  const breadcrumbs = safePathParts(folderPath);
  const activeRuns = safeObjectArray<{ runId?: string; status?: string }>(resetStatus?.activeRuns);
  const requiredConfirmation = optionalString(resetStatus?.requiredConfirmation);
  const selectedRefName = optionalString(selectedRefRecord?.name);
  const selectedRefRunId = optionalString(selectedRefRecord?.runId);

  return (
    <section className="repository-page">
      <div className="repository-hero">
        <div>
          <span className="eyebrow">READ-ONLY CODE EXPLORER</span>
          <h2>{safeString(metadata?.repositoryName, "Demo repository")}</h2>
          <p>Inspect real source, jump to seeded defects, and verify agent fixes against independent build and validation evidence.</p>
        </div>
        <div className="hero-actions">
          <span className={`repo-state ${resetStatus?.alreadyCanonical ? "buggy" : "changed"}`}>
            {resetStatus?.alreadyCanonical ? "● Buggy demo state ready" : "● main differs from seed"}
          </span>
          {resetStatus?.resetAllowed && (
            <button className="danger-outline" onClick={() => setShowReset(true)} disabled={!resetStatus.canReset || busy}>
              Restore buggy state
            </button>
          )}
        </div>
      </div>

      <div className="bug-jump-grid">
        {safeObjectArray<BugTarget>(metadata?.bugTargets).map((target, index) => (
          <button className="bug-jump-card" key={safeString(target.id, `target-${index}`)} onClick={() => void jumpToBug(target)}>
            <span>{safeString(target.id)}</span><strong>{safeString(target.title)}</strong><small>{safeString(target.description)}</small><em>Jump to lines {safeNonNegativeNumber(target.lineStart) ?? "Unavailable"}–{safeNonNegativeNumber(target.lineEnd) ?? "Unavailable"} →</em>
          </button>
        ))}
      </div>

      {notice && <div className="notice success">{notice}</div>}
      {error && <div className="notice error-notice">{error}</div>}

      <div className="repo-workbench">
        <aside className="repo-sidebar">
          <label>Revision</label>
          <select value={selectedRef} onChange={(event) => {
            const ref = refs.find((candidate) => candidate.name === event.target.value);
            if (ref) void selectRef(ref);
          }}>
            {refs.map((ref, index) => <option value={safeString(ref.name, `ref-${index}`)} key={safeString(ref.name, `ref-${index}`)}>{ref.kind === "fix" ? `${ref.validationPass ? "✓" : "○"} ` : ""}{safeString(ref.label)}</option>)}
          </select>
          <div className="ref-meta"><code>{shortId(selectedRefRecord?.commitId, 12)}</code></div>
          {metadata?.canDeleteFixBranches === true && selectedRefRecord?.kind === "fix" && selectedRefName && selectedRefName !== "main" && selectedRefRunId && (
            <button className="delete-revision" onClick={() => { setDeleteConfirmation(""); setShowDelete(true); }} disabled={busy}>
              Delete revision
            </button>
          )}
          {!review && (
            <>
              <div className="breadcrumbs">
                <button onClick={() => void loadFolder(selectedRef, "")}>root</button>
                {breadcrumbs.map((part, index) => {
                  const path = breadcrumbs.slice(0, index + 1).join("/");
                  return <span key={path}>/ <button onClick={() => void loadFolder(selectedRef, path)}>{part}</button></span>;
                })}
              </div>
              <div className="file-list">
                {folderPath && <button className="file-row" onClick={() => void loadFolder(selectedRef, safePathParts(folderPath).slice(0, -1).join("/"))}><span>↩</span><strong>..</strong></button>}
                {safeObjectArray<RepositoryTreeEntry>(entries).map((entry, index) => {
                  const entryPath = safeString(entry.path, "");
                  return <button className={`file-row ${file?.path === entryPath ? "active" : ""}`} key={entryPath || index} onClick={() => entryPath && (entry.type === "folder" ? void loadFolder(selectedRef, entryPath) : void openFile(selectedRef, entryPath))}><span>{entry.type === "folder" ? "▸" : "◇"}</span><strong>{safeString(entry.name)}</strong></button>;
                })}
              </div>
            </>
          )}
          {review && (
            <div className="file-list review-files">
              <h4>Changed files</h4>
              {reviewFiles.length === 0 && <p className="muted small">Changed-file details are unavailable.</p>}
              {reviewFiles.map((changed, index) => {
                const path = safeString(changed.path, `Unavailable file ${index + 1}`);
                const changeType = changed.changeType === "A" || changed.changeType === "D" || changed.changeType === "M" ? changed.changeType : "?";
                return <button className={`file-row ${reviewPath === path ? "active" : ""}`} key={`${path}-${index}`} onClick={() => setReviewPath(path)}><span className={`change-badge ${changeType}`}>{changeType}</span><strong>{path}</strong></button>;
              })}
            </div>
          )}
        </aside>

        <section className="repo-content">
          {busy && <div className="loading-bar">Loading repository data…</div>}
          {review && selectedReviewFile ? (
            <div className="review-layout">
              <div className="review-code">
                <div className="review-heading"><h3>Before</h3><span>{safeString(safeRecord(review.base)?.branch)}</span><h3>After</h3><span>{safeString(safeRecord(review.fix)?.branch)}</span></div>
                <div className="diff-columns"><CodeViewer file={safeRecord(selectedReviewFile.before) as RepositoryFile | null} tone="before" /><CodeViewer file={safeRecord(selectedReviewFile.after) as RepositoryFile | null} tone="after" /></div>
              </div>
              <EvidencePanel review={review} panelRef={evidenceRef} />
            </div>
          ) : review ? (
            <div className="code-empty">Changed-file review data is unavailable.</div>
          ) : (
            <CodeViewer file={file} highlight={highlight} />
          )}
        </section>
      </div>

      {showReset && resetStatus && (
        <div className="modal-backdrop" role="presentation">
          <div className="reset-modal" role="dialog" aria-modal="true" aria-labelledby="reset-title">
            <span className="modal-icon">↺</span><h3 id="reset-title">Restore canonical buggy state?</h3>
            <p>This creates a new commit on <code>main</code> from the immutable seed. It does not delete fix branches, run history, logs, or audit records.</p>
            {activeRuns.length > 0 && <div className="notice error-notice">Blocked by {activeRuns.length} active run(s).</div>}
            <label>Type <strong>{requiredConfirmation ?? "Unavailable"}</strong> to continue</label>
            <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoFocus />
            <div className="button-row"><button onClick={() => setShowReset(false)}>Cancel</button><button className="danger" disabled={!requiredConfirmation || confirmation !== requiredConfirmation || resetStatus.canReset !== true || busy} onClick={() => void runReset()}>Restore buggy state</button></div>
          </div>
        </div>
      )}

      {showDelete && selectedRefRecord?.kind === "fix" && selectedRefName && selectedRefName !== "main" && selectedRefRunId && (
        <div className="modal-backdrop" role="presentation">
          <div className="reset-modal" role="dialog" aria-modal="true" aria-labelledby="delete-revision-title">
            <span className="modal-icon">×</span><h3 id="delete-revision-title">Delete fix revision?</h3>
            <p><code>{selectedRefName}</code> will be permanently removed from the repository. Its code review will become unavailable, but the run history and audit record remain.</p>
            <label>Type <strong>DELETE {selectedRefName}</strong> to continue</label>
            <input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} autoFocus />
            <div className="button-row"><button onClick={() => setShowDelete(false)}>Cancel</button><button className="danger" disabled={deleteConfirmation !== `DELETE ${selectedRefName}` || busy} onClick={() => void deleteFixRevision()}>Delete revision</button></div>
          </div>
        </div>
      )}
    </section>
  );
}
