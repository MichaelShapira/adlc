import {
  CodeCommitClient,
  GetBranchCommand,
  GetCommitCommand,
  GetDifferencesCommand,
  GetFileCommand,
  GetFolderCommand,
} from "@aws-sdk/client-codecommit";

export const codeCommitClient = new CodeCommitClient({});

export interface RepoFile {
  path: string;
  content: string;
  blobId?: string;
  fileMode?: "EXECUTABLE" | "NORMAL" | "SYMLINK";
  size?: number;
}

export interface RepoTreeEntry {
  name: string;
  path: string;
  type: "file" | "folder";
  size?: number;
  blobId?: string;
}

export interface ReviewFile {
  path: string;
  changeType: "A" | "D" | "M";
  before: RepoFile | null;
  after: RepoFile | null;
}

const TEXT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".css",
  ".html",
  ".gitignore",
];
export const MAX_FILE_BYTES = 60_000;
const SAFE_REF = /^(main|fix\/[0-9a-f-]{36})$/;

export function normalizeRepoPath(value: string | undefined, allowRoot = false): string {
  const decoded = (value ?? "").trim().replace(/^\/+/, "");
  if (allowRoot && (decoded === "" || decoded === ".")) return "";
  if (
    !decoded ||
    decoded.length > 500 ||
    decoded.includes("\0") ||
    decoded.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("INVALID_PATH");
  }
  return decoded;
}

export function validateRepoRef(value: string | undefined): string {
  const ref = (value ?? "main").trim();
  if (!SAFE_REF.test(ref)) throw new Error("INVALID_REF");
  return ref;
}

export function isTextFile(path: string): boolean {
  const lower = path.toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export async function resolveBranchCommit(
  repositoryName: string,
  branchName: string
): Promise<string> {
  const res = await codeCommitClient.send(
    new GetBranchCommand({ repositoryName, branchName })
  );
  if (!res.branch?.commitId) throw new Error("BRANCH_NOT_FOUND");
  return res.branch.commitId;
}

export async function getRootCommit(
  repositoryName: string,
  startCommitId: string
): Promise<string> {
  let current = startCommitId;
  for (let depth = 0; depth < 1000; depth += 1) {
    const res = await codeCommitClient.send(
      new GetCommitCommand({ repositoryName, commitId: current })
    );
    const parent = res.commit?.parents?.[0];
    if (!parent) return current;
    current = parent;
  }
  throw new Error("COMMIT_HISTORY_TOO_DEEP");
}

export async function listRepoFolder(
  repositoryName: string,
  ref: string,
  folderPath = ""
): Promise<{ commitId: string; entries: RepoTreeEntry[] }> {
  const res = await codeCommitClient.send(
    new GetFolderCommand({
      repositoryName,
      commitSpecifier: ref,
      folderPath: folderPath ? `/${folderPath}` : "/",
    })
  );
  const entries: RepoTreeEntry[] = [];
  for (const folder of res.subFolders ?? []) {
    if (!folder.absolutePath) continue;
    const path = folder.absolutePath.replace(/^\/+/, "");
    entries.push({
      name: path.split("/").pop() ?? path,
      path,
      type: "folder",
    });
  }
  for (const file of res.files ?? []) {
    if (!file.absolutePath) continue;
    const path = file.absolutePath.replace(/^\/+/, "");
    entries.push({
      name: path.split("/").pop() ?? path,
      path,
      type: "file",
      blobId: file.blobId,
    });
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1
  );
  return { commitId: res.commitId ?? ref, entries };
}

export async function getRepoFile(
  repositoryName: string,
  ref: string,
  filePath: string,
  requireText = true
): Promise<RepoFile> {
  if (requireText && !isTextFile(filePath)) throw new Error("UNSUPPORTED_FILE");
  const res = await codeCommitClient.send(
    new GetFileCommand({ repositoryName, commitSpecifier: ref, filePath })
  );
  const size = res.fileSize ?? res.fileContent?.byteLength ?? 0;
  if (size > MAX_FILE_BYTES && requireText) throw new Error("FILE_TOO_LARGE");
  return {
    path: filePath,
    content: Buffer.from(res.fileContent ?? new Uint8Array()).toString("utf-8"),
    blobId: res.blobId,
    fileMode: res.fileMode,
    size,
  };
}

/** Recursively fetch all files. Text-only mode is used for LLM prompts. */
export async function getRepoSnapshot(
  repositoryName: string,
  ref: string,
  folderPath = "/",
  textOnly = true
): Promise<RepoFile[]> {
  const normalizedFolder = folderPath.replace(/^\/+/, "");
  const folder = await listRepoFolder(repositoryName, ref, normalizedFolder);
  const files: RepoFile[] = [];
  for (const entry of folder.entries) {
    if (entry.type === "folder") {
      if (entry.path.includes("node_modules")) continue;
      files.push(...(await getRepoSnapshot(repositoryName, ref, entry.path, textOnly)));
      continue;
    }
    if (textOnly && !isTextFile(entry.path)) continue;
    const file = await getRepoFile(repositoryName, ref, entry.path, textOnly);
    if (!textOnly || (file.size ?? 0) <= MAX_FILE_BYTES) files.push(file);
  }
  return files;
}

export function snapshotToPrompt(files: RepoFile[]): string {
  return files
    .map((f) => `===== FILE: ${f.path} =====\n${f.content}`)
    .join("\n\n");
}

async function getOptionalTextFile(
  repositoryName: string,
  ref: string,
  path: string | undefined
): Promise<RepoFile | null> {
  if (!path || !isTextFile(path)) return null;
  return getRepoFile(repositoryName, ref, path, true);
}

export async function getReviewDiff(
  repositoryName: string,
  beforeRef: string,
  afterRef: string
): Promise<ReviewFile[]> {
  const files: ReviewFile[] = [];
  let nextToken: string | undefined;
  do {
    const res = await codeCommitClient.send(
      new GetDifferencesCommand({
        repositoryName,
        beforeCommitSpecifier: beforeRef,
        afterCommitSpecifier: afterRef,
        NextToken: nextToken,
        MaxResults: 100,
      })
    );
    for (const difference of res.differences ?? []) {
      const beforePath = difference.beforeBlob?.path?.replace(/^\/+/, "");
      const afterPath = difference.afterBlob?.path?.replace(/^\/+/, "");
      const path = afterPath ?? beforePath;
      if (!path) continue;
      files.push({
        path,
        changeType: !beforePath ? "A" : !afterPath ? "D" : "M",
        before: await getOptionalTextFile(repositoryName, beforeRef, beforePath),
        after: await getOptionalTextFile(repositoryName, afterRef, afterPath),
      });
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return files;
}

export interface BranchDiff {
  changedFiles: string[];
  afterContents: RepoFile[];
}

export async function getBranchDiff(
  repositoryName: string,
  beforeRef: string,
  afterRef: string
): Promise<BranchDiff> {
  const review = await getReviewDiff(repositoryName, beforeRef, afterRef);
  return {
    changedFiles: review.map((file) => file.path),
    afterContents: review.flatMap((file) => (file.after ? [file.after] : [])),
  };
}
