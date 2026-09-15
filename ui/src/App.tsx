import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Authenticator } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";
import { api } from "./api";
import type { ModelOption, Run } from "./types";
import { RunDetail } from "./RunDetail";
import { RepositoryBrowser } from "./RepositoryBrowser";
import { ContextTab } from "./ContextTab";
import { McpTab } from "./McpTab";
import { UserGuide } from "./UserGuide";
import { ErrorBoundary } from "./ErrorBoundary";
import {
  displayStatus,
  optionalString,
  safeFixed,
  safeNonNegativeNumber,
  safeObjectArray,
  safeRecord,
  safeString,
  shortId,
} from "./safe";

const SIDEBAR_STORAGE_KEY = "adlc-poc.workflowSidebarWidth";
const DEFAULT_SIDEBAR_WIDTH = 380;
const MIN_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 720;
const MIN_DETAIL_WIDTH = 420;
const SPLITTER_WIDTH = 8;

function initialSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (raw === null) return DEFAULT_SIDEBAR_WIDTH;
    const stored = Number(raw);
    return Number.isFinite(stored)
      ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, stored))
      : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function modelOptions(value: unknown): ModelOption[] {
  return safeObjectArray<ModelOption>(value).filter(
    (model) => optionalString(model.id) !== null && optionalString(model.name) !== null
  );
}

const PRESETS: Array<{ label: string; text: string }> = [
  {
    label: "BUG-001 — Build broken (TS2345)",
    text: `BUG-001 — Build is broken: npm run build fails with TS2345

Running npm run build fails:
src/todos.ts: error TS2345: Argument of type 'TodoRow | undefined' is not assignable to parameter of type 'TodoRow'.

The project no longer compiles, which blocks every deployment. The failure was introduced with the completeTodo change that made the row lookup return an optional value.

Expected: npm run build succeeds and completeTodo returns undefined for a non-existent todo id (the HTTP layer already handles that case with a 404).`,
  },
  {
    label: "BUG-002 — SQL injection in search",
    text: `BUG-002 — SQL injection in todo search endpoint

The GET /todos/search?q=... endpoint builds its SQL query by string concatenation with the raw user-supplied search term. A crafted q parameter can change the query structure (classic SQL injection), e.g. q=%' OR '1'='1 returns every row regardless of the search term.

Expected: the search term is passed to the database as a bound parameter (parameterized query), never concatenated into the SQL string. Search behavior for normal terms must not change.`,
  },
];

function NewRunForm({ onStarted }: { onStarted: (runId: string) => void }) {
  const [bugText, setBugText] = useState("");
  const [kiroModel, setKiroModel] = useState("auto");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [analysisModel, setAnalysisModel] = useState("");
  const [analysisModels, setAnalysisModels] = useState<ModelOption[]>([]);
  const [triageInstruction, setTriageInstruction] = useState("");
  const [includeContext, setIncludeContext] = useState(false);
  const [autoExecuteSimple, setAutoExecuteSimple] = useState(false);
  const [securityMode, setSecurityMode] = useState<"skip" | "scan" | "remediate">("scan");
  const [kiroConfigured, setKiroConfigured] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelError, setModelError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    api
      .listModels()
      .then((resultValue) => {
        if (!active) return;
        const result = safeRecord(resultValue);
        if (!result) throw new Error("Model catalog is unavailable");
        setModels(modelOptions(result.models));
        setAnalysisModels(modelOptions(result.analysisModels));
        setAnalysisModel(safeString(result.defaultAnalysisModel, ""));
        setTriageInstruction(safeString(result.defaultTriageInstruction, ""));
        setKiroConfigured(result.kiroConfigured === true);
        setModelError(optionalString(result.error) ?? "");
      })
      .catch((e) => {
        if (active) setModelError(`Model discovery failed: ${String(e)}`);
      })
      .finally(() => {
        if (active) setModelsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const submit = async () => {
    if (!bugText.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = safeRecord(await api.startRun({
        bugText: bugText.trim(),
        kiroModel,
        analysisModel,
        triageInstruction: triageInstruction.trim(),
        includeContext,
        autoExecuteSimple,
        securityMode,
      }));
      const runId = optionalString(result?.runId);
      if (!runId) throw new Error("The run started without a usable run ID.");
      setBugText("");
      onStarted(runId);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Start a bug-fix run</h2>
      <p className="muted">
        Paste a bug ticket, or load one of the seeded bugs from the demo repo.
      </p>
      <div className="preset-row">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            className="preset"
            onClick={() => setBugText(p.text)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <textarea
        value={bugText}
        onChange={(e) => setBugText(e.target.value)}
        placeholder="Bug number or full bug content…"
        rows={8}
      />
      <label className="field-label" htmlFor="analysis-model">
        Analysis model
      </label>
      <select
        id="analysis-model"
        value={analysisModel}
        onChange={(e) => setAnalysisModel(e.target.value)}
        disabled={modelsLoading}
      >
        {analysisModels.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name} ({model.id})
          </option>
        ))}
      </select>
      <label className="field-label" htmlFor="triage-instruction">
        Triage guidance
      </label>
      <textarea
        id="triage-instruction"
        value={triageInstruction}
        onChange={(e) => setTriageInstruction(e.target.value)}
        placeholder="Explain how Simple versus Complex should be recommended…"
        rows={5}
        maxLength={4000}
      />
      <p className="muted small">
        Editable guidance for the complexity recommendation ({triageInstruction.length}/4000).
      </p>
      <label className="include-context-option">
        <input
          type="checkbox"
          checked={includeContext}
          onChange={(event) => setIncludeContext(event.target.checked)}
        />
        <span><strong>Include context</strong><small>Use all READY items from your private context library during triage.</small></span>
      </label>
      <label className="include-context-option">
        <input
          type="checkbox"
          checked={autoExecuteSimple}
          onChange={(event) => setAutoExecuteSimple(event.target.checked)}
        />
        <span><strong>Auto-execute simple fixes</strong><small>Skip human approval only when triage returns SIMPLE. Complex fixes always pause for review.</small></span>
      </label>
      <label className="include-context-option">
        <span><strong>Security review</strong><small>Run code review &amp; pentest via AWS Security Agent after validation.</small></span>
        <select
          value={securityMode}
          onChange={(e) => setSecurityMode(e.target.value as "skip" | "scan" | "remediate")}
          style={{ marginLeft: "auto" }}
        >
          <option value="skip">Skip</option>
          <option value="scan">Scan only (async)</option>
          <option value="remediate">Scan &amp; remediate</option>
        </select>
      </label>
      <label className="field-label" htmlFor="kiro-model">
        Implementation model
      </label>
      <select
        id="kiro-model"
        value={kiroModel}
        onChange={(e) => setKiroModel(e.target.value)}
        disabled={modelsLoading}
      >
        <option value="auto">Kiro default (automatic)</option>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name} ({model.id})
          </option>
        ))}
      </select>
      <p className={`model-status ${kiroConfigured ? "configured" : "fallback"}`}>
        {modelsLoading
          ? "Loading models from the AgentCore runtime…"
          : kiroConfigured
            ? `${models.length} Kiro model(s) available for this account.`
            : "Kiro key is not configured. Implementation runs Kiro CLI only and will fail until the key is set."}
      </p>
      {modelError && <p className="error">{modelError}</p>}
      {error && <p className="error">{error}</p>}
      <button
        className="primary"
        disabled={busy || !bugText.trim() || !analysisModel || !triageInstruction.trim()}
        onClick={submit}
      >
        {busy ? "Starting…" : "Start run"}
      </button>
    </section>
  );
}

function statusClass(statusValue: unknown): string {
  const status = optionalString(statusValue);
  if (status === "COMPLETED") return "ok";
  if (status && ["FAILED", "REJECTED", "NEEDS_HUMAN"].includes(status)) return "bad";
  if (status && ["AWAITING_APPROVAL", "CANCELLED"].includes(status)) return "warn";
  return "info";
}

function RunList({
  runs,
  selected,
  onSelect,
}: {
  runs: Run[];
  selected?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="card">
      <h2>Runs</h2>
      {safeObjectArray<Run>(runs).length === 0 && <p className="muted">No runs yet.</p>}
      <ul className="run-list">
        {safeObjectArray<Run>(runs).map((run, index) => {
          const runId = optionalString(run.runId);
          const title = safeString(safeRecord(run.triage)?.title, runId ? shortId(runId) : "Unavailable run");
          const cost = safeNonNegativeNumber(run.costUsd);
          return (
          <li key={runId ?? `unavailable-${index}`} className={runId === selected ? "selected" : ""}>
            <button type="button" disabled={!runId} onClick={() => runId && onSelect(runId)}>
              <span className={`badge ${statusClass(run.status)}`}>{displayStatus(run.status)}</span>
              <span className="run-title">{title}</span>
              <span className="muted small">
                {cost === null ? "Unavailable" : `$${safeFixed(cost, 3)}`}
              </span>
            </button>
          </li>
          );
        })}
      </ul>
    </section>
  );
}

function Dashboard({ signOut, user }: { signOut?: () => void; user?: { username?: string } }) {
  const [view, setView] = useState<"runs" | "repository" | "context" | "mcp">("runs");
  const [showGuide, setShowGuide] = useState(false);
  const [inspectRunId, setInspectRunId] = useState<string | undefined>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [selectedRun, setSelectedRun] = useState<Run | undefined>();
  const [dataError, setDataError] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [draggingSplitter, setDraggingSplitter] = useState(false);
  const workflowRef = useRef<HTMLElement | null>(null);

  const effectiveMax = useCallback(() => {
    const width = workflowRef.current?.getBoundingClientRect().width;
    if (typeof width !== "number" || !Number.isFinite(width)) return MAX_SIDEBAR_WIDTH;
    return Math.max(
      MIN_SIDEBAR_WIDTH,
      Math.min(MAX_SIDEBAR_WIDTH, width - SPLITTER_WIDTH - MIN_DETAIL_WIDTH)
    );
  }, []);

  const clampSidebarWidth = useCallback(
    (value: number) => Math.min(effectiveMax(), Math.max(MIN_SIDEBAR_WIDTH, value)),
    [effectiveMax]
  );

  const refreshList = useCallback(async () => {
    try {
      const result = safeRecord(await api.listRuns());
      if (!result) throw new Error("Run list response is unavailable.");
      setRuns(safeObjectArray<Run>(result.runs));
      setDataError("");
    } catch (e) {
      setDataError(`Run list unavailable: ${String(e)}`);
    }
  }, []);

  const refreshSelected = useCallback(async () => {
    if (!selectedId) return;
    try {
      const result = safeRecord(await api.getRun(selectedId));
      if (!result) throw new Error("Run detail response is unavailable.");
      setSelectedRun(result as unknown as Run);
      setDataError("");
    } catch (e) {
      setDataError(`Run detail unavailable: ${String(e)}`);
    }
  }, [selectedId]);

  useEffect(() => {
    void refreshList();
    const t = setInterval(refreshList, 10_000);
    return () => clearInterval(t);
  }, [refreshList]);

  useEffect(() => {
    void refreshSelected();
    const t = setInterval(refreshSelected, 3_000);
    return () => clearInterval(t);
  }, [refreshSelected]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // Storage can be unavailable in privacy modes; resizing still works in memory.
    }
  }, [sidebarWidth]);

  useEffect(() => {
    const reclamp = () => setSidebarWidth((width) => clampSidebarWidth(width));
    window.addEventListener("resize", reclamp);
    reclamp();
    return () => window.removeEventListener("resize", reclamp);
  }, [clampSidebarWidth]);

  useEffect(() => {
    if (!draggingSplitter) return;
    const move = (event: PointerEvent) => {
      const left = workflowRef.current?.getBoundingClientRect().left ?? 0;
      setSidebarWidth(clampSidebarWidth(event.clientX - left));
    };
    const stop = () => setDraggingSplitter(false);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
    };
  }, [clampSidebarWidth, draggingSplitter]);

  const startSplitterDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDraggingSplitter(true);
  };

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = sidebarWidth - 16;
    if (event.key === "ArrowRight") next = sidebarWidth + 16;
    if (event.key === "Home") next = MIN_SIDEBAR_WIDTH;
    if (event.key === "End") next = effectiveMax();
    if (next === null) return;
    event.preventDefault();
    setSidebarWidth(clampSidebarWidth(next));
  };

  const workflowStyle = {
    "--workflow-sidebar-width": `${sidebarWidth}px`,
  } as CSSProperties;

  return (
    <div className="layout">
      <header>
        <div className="brand-lockup"><span className="brand-mark">A</span><div><h1>ADLC Bug-Fix PoC</h1><small>Agentic delivery control plane</small></div></div>
        <nav className="top-nav">
          <button className={view === "runs" ? "active" : ""} onClick={() => setView("runs")}>Workflow</button>
          <button className={view === "context" ? "active" : ""} onClick={() => setView("context")}>Context</button>
          <button className={view === "mcp" ? "active" : ""} onClick={() => setView("mcp")}>MCP</button>
          <button className={view === "repository" ? "active" : ""} onClick={() => { setInspectRunId(undefined); setView("repository"); }}>Repository</button>
        </nav>
        <div className="header-actions">
          <button className="guide-button" onClick={() => setShowGuide(true)}>
            <span aria-hidden="true">📖</span> User guide
          </button>
          <span className="muted">{safeString(user?.username, "Signed in")}</span>{" "}
          <button onClick={signOut}>Sign out</button>
        </div>
      </header>
      {showGuide && <UserGuide onClose={() => setShowGuide(false)} />}
      <ErrorBoundary key={view}>
      {view === "context" ? (
        <ContextTab />
      ) : view === "mcp" ? (
        <McpTab />
      ) : view === "repository" ? (
        <RepositoryBrowser initialRunId={inspectRunId} />
      ) : (
      <main ref={workflowRef} className="workflow-layout" style={workflowStyle}>
        <aside className="workflow-sidebar">
          {dataError && <div className="notice error-notice" role="status">{dataError}</div>}
          <NewRunForm
            onStarted={(id) => {
              setSelectedId(id);
              void refreshList();
            }}
          />
          <RunList runs={runs} selected={selectedId} onSelect={setSelectedId} />
        </aside>
        <div
          className={`workflow-splitter ${draggingSplitter ? "dragging" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={effectiveMax()}
          aria-valuenow={sidebarWidth}
          aria-label="Resize workflow sidebar"
          tabIndex={0}
          onPointerDown={startSplitterDrag}
          onKeyDown={resizeWithKeyboard}
        />
        <section className="detail">
          {selectedRun ? (
            <RunDetail run={selectedRun} onChanged={refreshSelected} onInspectFix={(runId) => { setInspectRunId(runId); setView("repository"); }} />
          ) : (
            <p className="muted center">
              Select a run, or start a new one to watch the pipeline: configurable
              triage → Simple and Complex artifact generation → execution gate →
              Kiro implementation → validation loop → security review → report.
            </p>
          )}
        </section>
      </main>
      )}
      </ErrorBoundary>
    </div>
  );
}

export default function App() {
  return (
    <Authenticator hideSignUp>
      {({ signOut, user }) => <Dashboard signOut={signOut} user={user} />}
    </Authenticator>
  );
}
