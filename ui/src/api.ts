import { fetchAuthSession } from "aws-amplify/auth";
import type {
  ContextContentType,
  ContextItem,
  ContextListResponse,
  ContextPreview,
  ContextUploadReservation,
  ExecutionMode,
  McpConfigResponse,
  ModelsResponse,
  RepositoryFile,
  RepositoryRefsResponse,
  RepositoryTreeResponse,
  ResetStatus,
  Run,
  RunReview,
  StartRunRequest,
} from "./types";

let apiUrl = "";

export function setApiUrl(url: string): void {
  apiUrl = url.replace(/\/$/, "");
}

async function authHeaders(forceRefresh = false): Promise<Record<string, string>> {
  const session = await fetchAuthSession(forceRefresh ? { forceRefresh: true } : undefined);
  const token = session.tokens?.idToken?.toString();
  if (!token) throw new Error("not authenticated");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function authenticatedFetch(
  path: string,
  init: RequestInit | undefined,
  forceRefresh: boolean
): Promise<Response> {
  return fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { ...(await authHeaders(forceRefresh)), ...(init?.headers ?? {}) },
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res = await authenticatedFetch(path, init, false);
  if (res.status === 401 || res.status === 403) {
    res = await authenticatedFetch(path, init, true);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export const api = {
  listModels: () => request<ModelsResponse>("/models"),
  listRuns: () => request<{ runs: Run[] }>("/runs"),
  getRun: (runId: string) => request<Run>(`/runs/${runId}`),
  startRun: (input: StartRunRequest) =>
    request<{ runId: string }>("/runs", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  decide: (
    runId: string,
    action: "execute" | "cancel",
    mode: ExecutionMode,
    artifact: string,
    feedback: string
  ) =>
    request<{ ok: boolean; action: "execute" | "cancel"; selectedMode: ExecutionMode }>(
      `/runs/${runId}/decision`,
      {
        method: "POST",
        body: JSON.stringify({ action, mode, artifact, feedback }),
      }
    ),
  repositoryRefs: () => request<RepositoryRefsResponse>("/repository/refs"),
  repositoryTree: (ref: string, path = "") =>
    request<RepositoryTreeResponse>(
      `/repository/tree?${new URLSearchParams({ ref, path }).toString()}`
    ),
  repositoryFile: (ref: string, path: string) =>
    request<RepositoryFile>(
      `/repository/file?${new URLSearchParams({ ref, path }).toString()}`
    ),
  runReview: (runId: string) => request<RunReview>(`/runs/${runId}/review`),
  resetStatus: () => request<ResetStatus>("/repository/reset-status"),
  resetRepository: (confirmation: string, expectedHeadCommitId: string) =>
    request<{
      ok: boolean;
      actionId: string;
      newCommitId: string;
      alreadyCanonical: boolean;
    }>("/repository/reset", {
      method: "POST",
      body: JSON.stringify({ confirmation, expectedHeadCommitId }),
    }),
  deleteFixBranch: (runId: string, confirmation: string, expectedCommitId: string) =>
    request<{
      ok: boolean;
      actionId: string;
      branch: string;
      deletedCommitId: string;
      preservedRunHistory: boolean;
    }>(`/repository/fix-branches/${runId}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmation, expectedCommitId }),
    }),
  getMcpConfig: () => request<McpConfigResponse>("/mcp/config"),
  saveMcpConfig: (configJson: string) =>
    request<McpConfigResponse>("/mcp/config", {
      method: "POST",
      body: JSON.stringify({ configJson }),
    }),
  listContext: () => request<ContextListResponse>("/context"),
  createContextNote: (title: string, text: string) =>
    request<{ item: ContextItem }>("/context/notes", {
      method: "POST",
      body: JSON.stringify({ title, text }),
    }),
  reserveContextUpload: (
    fileName: string,
    contentType: ContextContentType,
    sizeBytes: number,
    checksumSha256: string
  ) =>
    request<ContextUploadReservation>("/context/uploads", {
      method: "POST",
      body: JSON.stringify({ fileName, contentType, sizeBytes, checksumSha256 }),
    }),
  uploadContextFile: (
    uploadUrl: string,
    file: File,
    contentType: ContextContentType,
    onProgress?: (fraction: number) => void
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadUrl);
      xhr.setRequestHeader("Content-Type", contentType);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(event.loaded / event.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Upload failed with status ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error("Upload failed due to a network error"));
      xhr.send(file);
    }),
  completeContextUpload: (itemId: string) =>
    request<{ item: ContextItem }>(`/context/${itemId}/complete`, { method: "POST" }),
  previewContextItem: (itemId: string) =>
    request<ContextPreview>(`/context/${itemId}/preview`),
  deleteContextItem: (itemId: string) =>
    request<{ ok: boolean; itemId: string }>(`/context/${itemId}`, { method: "DELETE" }),
};
