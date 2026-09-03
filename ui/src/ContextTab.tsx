import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type {
  ContextContentType,
  ContextItem,
  ContextListResponse,
  ContextPreview,
} from "./types";

const ALLOWED_TYPES = new Set<ContextContentType>([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = Math.floor(3.75 * 1024 * 1024);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

async function sha256Base64(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

function validateFile(file: File, context?: ContextListResponse): string | undefined {
  if (!ALLOWED_TYPES.has(file.type as ContextContentType)) {
    return "Choose a PDF, JPEG, PNG, or WebP file.";
  }
  if (file.size <= 0 || file.size >= MAX_FILE_BYTES) {
    return "Files must be smaller than 4 MiB.";
  }
  if (file.type.startsWith("image/") && file.size > MAX_IMAGE_BYTES) {
    return "Images must not exceed 3.75 MiB.";
  }
  if (context && context.quota.itemCount >= context.quota.maxItems) {
    return "The 10-item context limit has been reached.";
  }
  if (context && context.quota.totalBytes + file.size > context.quota.maxTotalBytes) {
    return "This file would exceed the 8 MiB context quota.";
  }
  return undefined;
}

function ItemIcon({ item }: { item: ContextItem }) {
  return <span className={`context-item-icon ${item.kind}`}>{item.kind === "note" ? "T" : item.kind === "image" ? "I" : "P"}</span>;
}

export function ContextTab() {
  const [context, setContext] = useState<ContextListResponse>();
  const [noteTitle, setNoteTitle] = useState("");
  const [noteText, setNoteText] = useState("");
  const [file, setFile] = useState<File>();
  const [selected, setSelected] = useState<ContextItem>();
  const [preview, setPreview] = useState<ContextPreview>();
  const [previewText, setPreviewText] = useState("");
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const result = await api.listContext();
    setContext(result);
    setSelected((current) =>
      current ? result.items.find((item) => item.itemId === current.itemId) : undefined
    );
  }, []);

  useEffect(() => {
    setBusy(true);
    refresh()
      .catch((cause) => setError(String(cause)))
      .finally(() => setBusy(false));
  }, [refresh]);

  const quotaPercent = useMemo(() => {
    if (!context) return 0;
    return Math.min(100, (context.quota.totalBytes / context.quota.maxTotalBytes) * 100);
  }, [context]);

  const createNote = async () => {
    if (!noteText.trim()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.createContextNote(noteTitle.trim(), noteText.trim());
      setNoteTitle("");
      setNoteText("");
      setNotice("Text note added to your context library.");
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const upload = async () => {
    if (!file) return;
    const validation = validateFile(file, context);
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    setProgress(5);
    try {
      const contentType = file.type as ContextContentType;
      const checksumSha256 = await sha256Base64(file);
      const reservation = await api.reserveContextUpload(
        file.name,
        contentType,
        file.size,
        checksumSha256
      );
      setProgress(15);
      await api.uploadContextFile(
        reservation.uploadUrl,
        file,
        contentType,
        (value) => {
          setProgress(15 + Math.round(value * 0.7));
        }
      );
      setProgress(90);
      await api.completeContextUpload(reservation.itemId);
      setProgress(100);
      setFile(undefined);
      const input = document.getElementById("context-file") as HTMLInputElement | null;
      if (input) input.value = "";
      setNotice("File verified and added to your context library.");
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
      window.setTimeout(() => setProgress(0), 600);
    }
  };

  const openPreview = async (item: ContextItem) => {
    setSelected(item);
    setPreview(undefined);
    setPreviewText("");
    setError("");
    try {
      const result = await api.previewContextItem(item.itemId);
      setPreview(result);
      if (item.contentType === "text/plain") {
        const response = await fetch(result.url);
        if (!response.ok) throw new Error(`Preview failed with status ${response.status}`);
        setPreviewText(await response.text());
      }
    } catch (cause) {
      setError(String(cause));
    }
  };

  const remove = async (item: ContextItem) => {
    if (!window.confirm(`Delete ${item.fileName}? This removes it from your context library.`)) return;
    setBusy(true);
    setError("");
    try {
      await api.deleteContextItem(item.itemId);
      if (selected?.itemId === item.itemId) {
        setSelected(undefined);
        setPreview(undefined);
        setPreviewText("");
      }
      setNotice(`${item.fileName} deleted.`);
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="context-page">
      <section className="context-hero">
        <div>
          <span className="eyebrow">PRIVATE RUN EVIDENCE</span>
          <h2>Context library</h2>
          <p>Add notes, diagrams, contracts, and decisions. Context is included in triage only when you explicitly enable it for a new run.</p>
        </div>
        <div className="context-quota-card">
          <strong>{context?.quota.itemCount ?? 0} / {context?.quota.maxItems ?? 10} items</strong>
          <span>{formatBytes(context?.quota.totalBytes ?? 0)} / 8 MiB</span>
          <div className="quota-track"><span style={{ width: `${quotaPercent}%` }} /></div>
        </div>
      </section>

      {notice && <div className="notice success">{notice}</div>}
      {error && <div className="notice error-notice">{error}</div>}

      <section className="context-create-grid">
        <article className="context-card">
          <span className="context-card-kicker">TEXT NOTE</span>
          <h3>Capture a decision</h3>
          <p className="muted">Store meeting outcomes, schema constraints, or cross-service assumptions.</p>
          <input value={noteTitle} onChange={(event) => setNoteTitle(event.target.value)} maxLength={116} placeholder="Note title (optional)" />
          <textarea value={noteText} onChange={(event) => setNoteText(event.target.value)} rows={7} placeholder="What should triage know?" />
          <button className="primary" onClick={() => void createNote()} disabled={busy || !noteText.trim()}>Add note</button>
        </article>

        <article className="context-card">
          <span className="context-card-kicker">FILE EVIDENCE</span>
          <h3>Upload a document or diagram</h3>
          <p className="muted">PDF, JPEG, PNG, or WebP. Files are uploaded directly to private object storage with a five-minute signed URL.</p>
          <label className="context-drop" htmlFor="context-file">
            <strong>{file?.name ?? "Choose a file"}</strong>
            <span>{file ? `${formatBytes(file.size)} · ${file.type}` : "PDF or image · under 4 MiB"}</span>
          </label>
          <input
            id="context-file"
            className="context-file-input"
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            onChange={(event) => {
              const next = event.target.files?.[0];
              setFile(next);
              setError(next ? validateFile(next, context) ?? "" : "");
            }}
          />
          {progress > 0 && <div className="upload-progress" aria-label={`Upload ${progress}%`}><span style={{ width: `${progress}%` }} /></div>}
          <button className="primary" onClick={() => void upload()} disabled={busy || !file}>Upload and verify</button>
        </article>
      </section>

      <section className="context-library">
        <div className="context-library-header"><div><span className="context-card-kicker">READY ITEMS</span><h3>Your context</h3></div><button className="context-refresh" onClick={() => void refresh()} disabled={busy}>Refresh</button></div>
        {context?.items.length === 0 && <div className="context-empty">No context yet. Add a note or upload supporting evidence.</div>}
        <div className="context-item-grid">
          {(context?.items ?? []).map((item) => (
            <article className={`context-item ${selected?.itemId === item.itemId ? "selected" : ""}`} key={item.itemId}>
              <button className="context-item-open" onClick={() => void openPreview(item)}>
                <ItemIcon item={item} />
                <span><strong>{item.fileName}</strong><small>{formatBytes(item.sizeBytes)} · {new Date(item.createdAt).toLocaleString()}</small></span>
              </button>
              <button className="context-delete" onClick={() => void remove(item)} aria-label={`Delete ${item.fileName}`}>Delete</button>
            </article>
          ))}
        </div>
      </section>

      {selected && (
        <section className="context-preview-card">
          <div className="context-library-header"><div><span className="context-card-kicker">PREVIEW</span><h3>{selected.fileName}</h3></div><button className="context-refresh" onClick={() => void openPreview(selected)}>Refresh URL</button></div>
          {!preview && <div className="context-empty">Loading preview…</div>}
          {preview && selected.kind === "image" && <img className="context-image-preview" src={preview.url} alt={selected.fileName} />}
          {preview && selected.contentType === "application/pdf" && (
            <object
              className="context-pdf-preview"
              data={preview.url}
              type="application/pdf"
              aria-label={`Preview ${selected.fileName}`}
            >
              <p>
                PDF preview is unavailable in this browser. {" "}
                <a href={preview.url} target="_blank" rel="noreferrer">Open the PDF</a>
              </p>
            </object>
          )}
          {preview && selected.contentType === "text/plain" && <pre className="context-text-preview">{previewText}</pre>}
        </section>
      )}
    </section>
  );
}
