import { useEffect, useRef } from "react";

const SECTIONS = [
  { id: "overview", label: "1. What this application does" },
  { id: "start-run", label: "2. Starting a bug-fix run" },
  { id: "pipeline", label: "3. The pipeline, stage by stage" },
  { id: "approval", label: "4. The human approval gate" },
  { id: "report", label: "5. Reading the report" },
  { id: "usage", label: "6. Usage & cost breakdown" },
  { id: "repository", label: "7. Repository explorer & fix review" },
  { id: "context", label: "8. Context library" },
  { id: "mcp", label: "9. MCP servers" },
  { id: "logs", label: "10. Agent logs" },
  { id: "troubleshooting", label: "11. Troubleshooting & FAQ" },
  { id: "kiro-setup", label: "12. Admin: connecting Kiro CLI" },
];

export function UserGuide({ onClose }: { onClose: () => void }) {
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const jump = (id: string) => {
    contentRef.current
      ?.querySelector(`#guide-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="guide-backdrop" role="presentation" onClick={onClose}>
      <div
        className="guide-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="guide-header">
          <div>
            <span className="eyebrow">ADLC BUG-FIX PoC</span>
            <h2 id="guide-title">User guide</h2>
          </div>
          <button className="guide-close" onClick={onClose} aria-label="Close the user guide">
            ✕ Close
          </button>
        </header>
        <div className="guide-body">
          <nav className="guide-toc" aria-label="Guide contents">
            {SECTIONS.map((section) => (
              <button key={section.id} onClick={() => jump(section.id)}>
                {section.label}
              </button>
            ))}
          </nav>
          <div className="guide-content" ref={contentRef}>
            <section id="guide-overview">
              <h3>1. What this application does</h3>
              <p>
                This is a proof of concept for an agentic development lifecycle (ADLC).
                You paste a bug report; the system analyzes it, drafts a fix plan, waits
                for your approval (or auto-approves simple cases when you opt in), lets
                the Kiro CLI coding agent implement the fix inside an isolated AWS
                Bedrock AgentCore container, independently validates the result, and
                produces an auditable report with full cost and resource usage.
              </p>
              <p>
                The target is a small demo repository (<code>todo-service</code>, an
                Express + SQLite REST API) seeded with two known bugs: a TypeScript
                compile error (BUG-001) and a SQL injection (BUG-002). Every fix lands
                on its own <code>fix/&lt;run-id&gt;</code> branch — the <code>main</code> branch is never
                modified by the agent, so you can run the demo repeatedly.
              </p>
              <p>Key principles you will see everywhere in the product:</p>
              <ul>
                <li><strong>Frozen artifacts</strong> — what you approve is exactly what executes, byte for byte, on every attempt.</li>
                <li><strong>Independent verification</strong> — the agent's claims are checked by a build gate and a separate validator model.</li>
                <li><strong>Full audit trail</strong> — every stage, decision, log line, credit, and CPU-second is recorded per run.</li>
              </ul>
            </section>

            <section id="guide-start-run">
              <h3>2. Starting a bug-fix run</h3>
              <p>On the <strong>Workflow</strong> tab, the "Start a bug-fix run" form has these fields:</p>
              <dl>
                <dt>Bug text</dt>
                <dd>
                  Paste a full bug ticket, or click a preset to load one of the seeded
                  bugs. The more precise the report (file, symptom, expected behavior),
                  the better the triage and the drafted fix plan.
                </dd>
                <dt>Analysis model</dt>
                <dd>
                  The Bedrock model used for triage, drafting, and validation (for
                  example Claude Haiku, Sonnet, or Opus). This is separate from the
                  model Kiro uses to write code.
                </dd>
                <dt>Triage guidance</dt>
                <dd>
                  Editable instructions that tell the triage step how to decide between
                  a Simple and a Complex fix. Adjust it if you want the system to be
                  more conservative or more aggressive about auto-classification.
                </dd>
                <dt>Include context</dt>
                <dd>
                  When checked, all READY items from your private Context library
                  (notes, PDFs, images) are supplied to the analysis model during
                  triage. See section 8.
                </dd>
                <dt>Auto-execute simple fixes</dt>
                <dd>
                  When checked, a run whose triage verdict is SIMPLE skips the human
                  gate and executes immediately — the auto-approval is recorded in the
                  audit trail. COMPLEX runs always stop and wait for you.
                </dd>
                <dt>Implementation model</dt>
                <dd>
                  The model Kiro CLI uses to write the code. "Kiro default" lets Kiro
                  choose; the list shows the models actually available to the
                  configured Kiro account, discovered live.
                </dd>
              </dl>
            </section>

            <section id="guide-pipeline">
              <h3>3. The pipeline, stage by stage</h3>
              <ol>
                <li>
                  <strong>TRIAGE</strong> — the analysis model reads the bug (plus your
                  context items when enabled) and classifies it SIMPLE or COMPLEX with
                  reasoning, an estimated file count, and a title.
                </li>
                <li>
                  <strong>DRAFT</strong> — the analysis model produces two candidate
                  artifacts: a Simple prompt (a single precise instruction for Kiro)
                  and a Complex specification (a structured Markdown spec with
                  Requirements, Design, Tasks, and Acceptance Criteria).
                </li>
                <li>
                  <strong>GATE</strong> — the run pauses in AWAITING_APPROVAL, unless
                  auto-execute applies (section 4).
                </li>
                <li>
                  <strong>IMPLEMENT</strong> — the approved artifact is sent to the
                  AgentCore container. The agent clones the repo, writes your MCP
                  configuration if present, runs Kiro CLI headlessly, runs the build,
                  and pushes the fix branch.
                </li>
                <li>
                  <strong>VALIDATE</strong> — a hard build gate first: if
                  <code> npm install &amp;&amp; npm run build</code> failed, validation cannot
                  pass. Then the validator model independently reviews the diff
                  against the frozen artifact and produces pass/fail checks.
                </li>
                <li>
                  <strong>FIX LOOP</strong> — on validation failure, the findings are
                  fed back to the agent for another attempt with the same frozen
                  artifact, up to 3 attempts total.
                </li>
                <li>
                  <strong>REPORT</strong> — the final verdict, phases completed, usage
                  breakdown, and links to the fix branch.
                </li>
              </ol>
              <p>
                The timeline on the run page shows each stage as it happens; the
                pipeline area and run list are separated by a draggable splitter you
                can resize.
              </p>
            </section>

            <section id="guide-approval">
              <h3>4. The human approval gate</h3>
              <p>When a run reaches AWAITING_APPROVAL you choose:</p>
              <ul>
                <li>
                  <strong>Mode</strong> — execute the <em>Simple prompt</em> (Kiro in
                  vibe-code mode with a single instruction) or the <em>Complex spec</em>
                  (the approved Markdown spec is placed at
                  <code> .kiro/specs/adlc-run/approved-spec.md</code> and Kiro is directed to
                  implement it).
                </li>
                <li>
                  <strong>Edit the artifact</strong> — you can modify the drafted prompt
                  or spec before approving. What you approve is frozen: retries reuse
                  it unchanged.
                </li>
                <li>
                  <strong>Execute or Cancel</strong> — cancel ends the run with an
                  audit record; nothing touches the repository.
                </li>
              </ul>
              <p>
                With "Auto-execute simple fixes" checked at submission, a SIMPLE triage
                verdict approves the drafted Simple prompt automatically and the run
                proceeds without pausing. The run history shows it was auto-approved.
                COMPLEX verdicts always stop for review regardless of the checkbox.
              </p>
            </section>

            <section id="guide-report">
              <h3>5. Reading the report</h3>
              <ul>
                <li>
                  <strong>Headline & phases</strong> — overall outcome, which phases
                  completed, execution mode, models used, fix loops consumed, and total
                  time and cost.
                </li>
                <li>
                  <strong>"How this fix is verified"</strong> — the defense-in-depth
                  panel: frozen artifact, hard build gate, independent validator,
                  bounded three-attempt loop, and the immutable diff. The metrics show
                  the build result and how many validation checks passed.
                </li>
                <li>
                  <strong>Validation findings</strong> — when a fix loop is in progress,
                  the specific findings the agent must address next.
                </li>
                <li>
                  <strong>Inspect fix →</strong> — jumps to the Repository tab, opens
                  the run's before/after review, and scrolls to the verification
                  evidence.
                </li>
              </ul>
            </section>

            <section id="guide-usage">
              <h3>6. Usage & cost breakdown</h3>
              <ul>
                <li>
                  <strong>Analysis</strong> — input/output tokens and cost for the
                  TRIAGE and DRAFT calls made with your selected analysis model.
                </li>
                <li>
                  <strong>Kiro</strong> — credits consumed by Kiro CLI per
                  implementation attempt, parsed from Kiro's structured output, with an
                  approximate USD conversion. Runs that predate credit capture show
                  "Unavailable" — the data was never emitted, so it cannot be
                  reconstructed.
                </li>
                <li>
                  <strong>AgentCore</strong> — CPU seconds and peak memory measured
                  inside the container (cgroup v2) for each implementation attempt,
                  plus session IDs and trace IDs for cross-referencing with AWS
                  telemetry.
                </li>
              </ul>
            </section>

            <section id="guide-repository">
              <h3>7. Repository explorer & fix review</h3>
              <ul>
                <li>
                  <strong>Browse code</strong> — read-only explorer over the demo
                  repository. The revision dropdown switches between <code>main</code> and each
                  run's fix branch.
                </li>
                <li>
                  <strong>Bug jump cards</strong> — one click opens the exact seeded
                  defect lines in the source.
                </li>
                <li>
                  <strong>Fix review</strong> — selecting a fix revision (or arriving
                  via "Inspect fix") shows a full-width before/after comparison per
                  changed file, followed by the verification evidence: validator
                  verdict, build gate, the coding agent's own implementation report
                  (labeled as a claim, not evidence), validation checks, and the raw
                  build output.
                </li>
                <li>
                  <strong>Restore buggy state</strong> — recreates the canonical seeded
                  bugs on <code>main</code> via a new commit. It requires membership in the
                  repo-resetters group and a typed confirmation; fix branches and run
                  history are preserved.
                </li>
                <li>
                  <strong>Delete revision</strong> — permanently removes a fix branch
                  (never <code>main</code>) after a typed confirmation. The run's history and
                  audit records remain.
                </li>
              </ul>
            </section>

            <section id="guide-context">
              <h3>8. Context library</h3>
              <p>
                The <strong>Context</strong> tab is your private library of material the
                analysis model may use during triage: typed text notes, PDFs (such as a
                design document), and images (such as a screenshot of an error).
                Quotas: 10 items, 8 MB total, files up to 4 MB, images up to 3.75 MB.
                Uploads are checked against their declared type and checksum before
                becoming READY.
              </p>
              <p>
                Context is only used for runs started with "Include context" checked,
                and only items that were READY at submission. Context influences
                analysis (triage and drafting) — it is not handed to the coding agent.
              </p>
            </section>

            <section id="guide-mcp">
              <h3>9. MCP servers</h3>
              <p>
                The <strong>MCP</strong> tab lets you give the coding agent extra
                abilities through Model Context Protocol servers. Paste or edit an
                <code> mcp.json</code> document (the same format Kiro uses everywhere); the
                "Insert AWS docs template" button loads a working example that lets
                Kiro search official AWS documentation while it codes.
              </p>
              <ul>
                <li>Limits: up to 5 <code>stdio</code> servers, 32 KB. The editor validates as you type and the server re-validates on save.</li>
                <li>The configuration is snapshotted when a run starts — later edits never affect runs already in flight.</li>
                <li>Inside the container it is written to <code>.kiro/settings/mcp.json</code> for Kiro CLI and removed before the commit, so it never lands in the repository.</li>
                <li>Every MCP tool Kiro actually calls is logged in the run's Agent logs under the <code>mcp</code> stage, including a per-tool call count. If servers were configured but unused, the log says so explicitly.</li>
                <li>The container ships <code>uvx</code> (Python servers) and Node.js (<code>npx</code> servers). MCP servers run with the same trust as the agent — only add servers you trust.</li>
              </ul>
            </section>

            <section id="guide-logs">
              <h3>10. Agent logs</h3>
              <p>
                The bottom of every run page streams the audit log (refreshed every 3
                seconds). Each line has a timestamp, level (INFO/WARN/ERROR), and a
                stage tag: <code>workflow</code>, <code>triage</code>, <code>draft</code>, <code>engine</code>,
                <code> repository</code>, <code>artifact</code>, <code>mcp</code>, <code>kiro</code>, <code>changes</code>,
                <code> build</code>, <code>validation</code>, and <code>agent</code>. This is the fastest way to
                see what actually happened, including Kiro credit usage and MCP tool
                calls.
              </p>
            </section>

            <section id="guide-troubleshooting">
              <h3>11. Troubleshooting & FAQ</h3>
              <dl>
                <dt>Kiro cost shows "Unavailable"</dt>
                <dd>
                  Normal for runs made before structured credit capture was deployed;
                  historical output cannot be reparsed. New runs always show credits.
                </dd>
                <dt>Kiro credits show "Not applicable"</dt>
                <dd>
                  A historical run that did not execute Kiro. Current runs are Kiro
                  CLI only — if the Kiro API key is missing, the run fails with a clear
                  error instead of switching engines.
                </dd>
                <dt>Run failed at TRIAGE or DRAFT</dt>
                <dd>
                  The failure card names the stage and error code (for example, a
                  model rejecting a parameter). Adjust the analysis model or input and
                  start a new run; nothing was executed against the repository.
                </dd>
                <dt>Validation keeps failing</dt>
                <dd>
                  After 3 attempts the run ends with the findings preserved. Review
                  them, refine the bug text or artifact, and start a fresh run.
                </dd>
                <dt>The repository looks already fixed</dt>
                <dd>
                  Someone merged or edited <code>main</code>. Use "Restore buggy state" on the
                  Repository tab to recreate the canonical seeded bugs.
                </dd>
                <dt>MCP server did not start</dt>
                <dd>
                  Check the <code>mcp</code> lines in Agent logs. Typical causes: a typo in
                  the command, a package name that does not exist, or a server that
                  needs credentials the container does not have.
                </dd>
              </dl>
            </section>

            <section id="guide-kiro-setup">
              <h3>12. Administrator setup: connecting Kiro CLI</h3>
              <p>
                All code changes are made by <strong>Kiro CLI</strong> running headlessly
                inside the AgentCore container. It authenticates with a Kiro API key
                (<code>ksk_…</code>) that lives in AWS Secrets Manager — it is never stored in
                code, CloudFormation, or the browser. Without a valid key, runs fail at
                the implementation stage with a clear error; there is no fallback engine.
              </p>
              <ol>
                <li>
                  <strong>Get a key</strong> — sign in at{" "}
                  <a href="https://kiro.dev" target="_blank" rel="noreferrer">kiro.dev</a>{" "}
                  with an account that has a Kiro subscription and create an API key
                  (it starts with <code>ksk_</code>). Keys are account-scoped: the models
                  offered in the run form are the models that account can use, and
                  credits consumed by runs are billed to it.
                </li>
                <li>
                  <strong>Store it</strong> — the deployment creates a placeholder secret
                  named <code>adlc-poc/kiro-api-key</code>. Replace its value using AWS
                  credentials for the account hosting the stack:
                  <pre className="guide-code">{`aws secretsmanager put-secret-value \\
  --secret-id adlc-poc/kiro-api-key \\
  --secret-string ksk_YOUR_KEY_HERE \\
  --region us-east-1`}</pre>
                  No redeploy is needed — the agent reads the secret at the start of
                  every invocation.
                </li>
                <li>
                  <strong>Verify</strong> — reload this UI and open the start-run form.
                  The "Implementation model" dropdown should say Kiro models are
                  available and list them. That list is fetched live through the agent
                  container using your key, so seeing it proves the whole chain works.
                </li>
                <li>
                  <strong>Rotate or revoke</strong> — run the same
                  <code> put-secret-value</code> command with a new key at any time. Runs
                  already executing finish with the key they read at invocation start.
                </li>
              </ol>
              <p className="muted">
                Deployment itself (CDK stack, demo user creation, seeding) is covered in
                the repository README.
              </p>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
