import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { optionalString, safeNonNegativeNumber, safeRecord } from "./safe";

const TEMPLATE = `{
  "mcpServers": {
    "awslabs.aws-documentation-mcp-server": {
      "command": "uvx",
      "args": ["awslabs.aws-documentation-mcp-server@latest"],
      "env": {
        "FASTMCP_LOG_LEVEL": "ERROR",
        "AWS_DOCUMENTATION_PARTITION": "aws"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}`;

interface EditorStatus {
  tone: "ok" | "warn" | "error";
  message: string;
}

/** Pretty-print stored JSON for the editor; leave unparseable text as-is. */
function prettify(configJson: string): string {
  if (!configJson.trim()) return "";
  try {
    return JSON.stringify(JSON.parse(configJson), null, 2);
  } catch {
    return configJson;
  }
}

/** Client-side preview validation; the API re-validates authoritatively. */
function validateDraft(draft: string): EditorStatus {
  if (!draft.trim()) {
    return { tone: "warn", message: "Empty configuration — MCP is disabled for new runs." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(draft);
  } catch (e) {
    return { tone: "error", message: `Not valid JSON: ${String((e as Error).message).slice(0, 120)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { tone: "error", message: "Configuration must be a JSON object." };
  }
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return { tone: "error", message: "Configuration must define an mcpServers object." };
  }
  const entries = Object.entries(servers as Record<string, unknown>);
  if (entries.length === 0) {
    return { tone: "error", message: "mcpServers must define at least one server." };
  }
  const enabled = entries.filter(
    ([, server]) => !(server && typeof server === "object" && (server as Record<string, unknown>).disabled === true)
  );
  const missingCommand = entries.find(
    ([, server]) =>
      !server || typeof server !== "object" ||
      typeof (server as Record<string, unknown>).command !== "string"
  );
  if (missingCommand) {
    return { tone: "error", message: `Server "${missingCommand[0]}" needs a command string.` };
  }
  return {
    tone: "ok",
    message: `Valid JSON — ${entries.length} server(s), ${enabled.length} enabled.`,
  };
}

export function McpTab() {
  const [draft, setDraft] = useState("");
  const [savedAt, setSavedAt] = useState<string | undefined>();
  const [savedServers, setSavedServers] = useState(0);
  const [savedEnabled, setSavedEnabled] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const status = useMemo(() => validateDraft(draft), [draft]);

  useEffect(() => {
    let active = true;
    api
      .getMcpConfig()
      .then((value) => {
        if (!active) return;
        const result = safeRecord(value);
        if (!result) throw new Error("MCP configuration response is unavailable.");
        setDraft(prettify(typeof result.configJson === "string" ? result.configJson : ""));
        setSavedAt(optionalString(result.updatedAt) ?? undefined);
        setSavedServers(safeNonNegativeNumber(result.serverCount) ?? 0);
        setSavedEnabled(safeNonNegativeNumber(result.enabledCount) ?? 0);
      })
      .catch((e) => active && setError(String(e)))
      .finally(() => active && setBusy(false));
    return () => {
      active = false;
    };
  }, []);

  const save = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const formatted = prettify(draft);
      const result = safeRecord(await api.saveMcpConfig(formatted));
      if (!result) throw new Error("MCP configuration save response is unavailable.");
      setDraft(formatted);
      setSavedAt(optionalString(result.updatedAt) ?? undefined);
      setSavedServers(safeNonNegativeNumber(result.serverCount) ?? 0);
      setSavedEnabled(safeNonNegativeNumber(result.enabledCount) ?? 0);
      setDirty(false);
      setNotice(
        draft.trim()
          ? "MCP configuration saved. New runs will snapshot this configuration."
          : "MCP configuration cleared. New runs will not use MCP."
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const formatDraft = () => {
    try {
      setDraft(JSON.stringify(JSON.parse(draft), null, 2));
    } catch {
      // validation banner already explains the parse error
    }
  };

  return (
    <section className="context-page">
      <div className="context-hero">
        <div>
          <span className="eyebrow">MODEL CONTEXT PROTOCOL</span>
          <h2>MCP servers for the coding agent</h2>
          <p>
            Define the MCP servers Kiro CLI may use while implementing fixes inside
            AgentCore. The configuration is written to <code>.kiro/settings/mcp.json</code> in
            the agent's workspace, snapshotted per run for auditability, and never
            committed to the repository. MCP tool usage appears in the run's Agent
            logs under the <code>mcp</code> stage.
          </p>
        </div>
        <div className="mcp-summary-card">
          <strong>Saved configuration</strong>
          <span>{savedServers} server(s) · {savedEnabled} enabled</span>
          <small>{savedAt ? `Updated ${new Date(savedAt).toLocaleString()}` : "Nothing saved yet"}</small>
        </div>
      </div>

      {notice && <div className="notice success">{notice}</div>}
      {error && <div className="notice error-notice">{error}</div>}

      <div className="card mcp-editor-card">
        <div className="mcp-editor-heading">
          <h3>mcp.json</h3>
          <div className="mcp-editor-actions">
            <button onClick={() => { setDraft(TEMPLATE); setDirty(true); }} disabled={busy}>
              Insert AWS docs template
            </button>
            <button onClick={formatDraft} disabled={busy || status.tone === "error"}>
              Format JSON
            </button>
            <button onClick={() => { setDraft(""); setDirty(true); }} disabled={busy || !draft}>
              Clear
            </button>
          </div>
        </div>
        <textarea
          className="mcp-editor"
          value={draft}
          onChange={(event) => { setDraft(event.target.value); setDirty(true); }}
          placeholder='{"mcpServers": { ... }}'
          rows={18}
          spellCheck={false}
          aria-label="MCP configuration JSON editor"
        />
        <div className={`mcp-validation ${status.tone}`} role="status">{status.message}</div>
        <div className="button-row">
          <button
            className="primary"
            onClick={() => void save()}
            disabled={busy || status.tone === "error" || !dirty}
          >
            {busy ? "Working…" : "Save configuration"}
          </button>
        </div>
        <ul className="mcp-notes">
          <li>Up to 5 servers, 32 KB total. Only <code>stdio</code> servers are supported.</li>
          <li>The agent container ships with <code>uvx</code> (Python MCP servers) and Node.js (<code>npx</code>-based servers).</li>
          <li>Servers run with the same trust as the coding agent; add only servers you trust.</li>
          <li>Runs already in flight keep the configuration they were started with.</li>
        </ul>
      </div>
    </section>
  );
}
