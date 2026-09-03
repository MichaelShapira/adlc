import {
  ListBranchesCommand,
} from "@aws-sdk/client-codecommit";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  codeCommitClient,
  getRepoFile,
  getReviewDiff,
  listRepoFolder,
  normalizeRepoPath,
  resolveBranchCommit,
  validateRepoRef,
} from "../shared/codecommit";
import { callerIdentity, response } from "./http";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const REPO_NAME = process.env.REPO_NAME!;
const RUNS_TABLE = process.env.RUNS_TABLE!;
const BASE_BRANCH = process.env.BASE_BRANCH ?? "main";

const BUG_TARGETS = [
  {
    id: "BUG-001",
    title: "Compilation failure (TS2345)",
    path: "src/todos.ts",
    lineStart: 34,
    lineEnd: 39,
    description: "completeTodo passes a possibly undefined database row to toTodo.",
  },
  {
    id: "BUG-002",
    title: "SQL injection in search",
    path: "src/todos.ts",
    lineStart: 42,
    lineEnd: 45,
    description: "searchTodos concatenates untrusted input into the SQL statement.",
  },
] as const;

function errorResponse(error: unknown): APIGatewayProxyResultV2 {
  const message = error instanceof Error ? error.message : "UNKNOWN";
  if (message === "INVALID_PATH" || message === "INVALID_REF") {
    return response(400, { error: message.toLowerCase().replace("_", " ") });
  }
  if (message === "UNSUPPORTED_FILE") {
    return response(415, { error: "only small text files can be displayed" });
  }
  if (message === "FILE_TOO_LARGE") {
    return response(413, { error: "file exceeds the 60 KB viewer limit" });
  }
  if (message === "BRANCH_NOT_FOUND") {
    return response(404, { error: "repository ref not found" });
  }
  console.error("repository read failed", error);
  return response(500, { error: "repository read failed" });
}

async function listRefs(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const branches: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await codeCommitClient.send(
      new ListBranchesCommand({ repositoryName: REPO_NAME, nextToken })
    );
    branches.push(...(res.branches ?? []));
    nextToken = res.nextToken;
  } while (nextToken);

  const runs = await ddb.send(
    new ScanCommand({
      TableName: RUNS_TABLE,
      ProjectionExpression:
        "runId, #s, createdAt, updatedAt, fixBranch, baseCommitId, implementResult, triage, validation, report",
      ExpressionAttributeNames: { "#s": "status" },
      Limit: 200,
    })
  );
  const runByBranch = new Map<string, Record<string, unknown>>();
  for (const run of runs.Items ?? []) {
    const fixBranch = String(run.fixBranch ?? "");
    if (fixBranch) runByBranch.set(fixBranch, run);
  }

  const refs = [];
  if (branches.includes(BASE_BRANCH)) {
    refs.push({
      kind: "base",
      name: BASE_BRANCH,
      commitId: await resolveBranchCommit(REPO_NAME, BASE_BRANCH),
      label: "main · canonical demo",
    });
  }
  for (const name of branches.filter((branch) => branch.startsWith("fix/")).sort()) {
    if (!/^fix\/[0-9a-f-]{36}$/.test(name)) continue;
    const run = runByBranch.get(name);
    const triage = run?.triage as { title?: string; bugId?: string } | undefined;
    const validation = run?.validation as { pass?: boolean } | undefined;
    const implement = run?.implementResult as { fixCommitId?: string } | undefined;
    refs.push({
      kind: "fix",
      name,
      commitId: await resolveBranchCommit(REPO_NAME, name),
      implementationCommitId: implement?.fixCommitId,
      runId: run?.runId,
      status: run?.status,
      validationPass: validation?.pass ?? false,
      label: triage?.title ?? `${triage?.bugId ?? "Fix"} · ${String(run?.runId ?? name).slice(0, 8)}`,
      completedAt: run?.updatedAt,
    });
  }
  return response(200, {
    repositoryName: REPO_NAME,
    refs,
    bugTargets: BUG_TARGETS,
    canDeleteFixBranches: callerIdentity(event).groups.includes("repo-resetters"),
  });
}

async function getTree(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const ref = validateRepoRef(event.queryStringParameters?.ref);
  const folderPath = normalizeRepoPath(event.queryStringParameters?.path, true);
  const result = await listRepoFolder(REPO_NAME, ref, folderPath);
  return response(200, { ref, path: folderPath, ...result });
}

async function getFile(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const ref = validateRepoRef(event.queryStringParameters?.ref);
  const filePath = normalizeRepoPath(event.queryStringParameters?.path);
  const commitId = await resolveBranchCommit(REPO_NAME, ref);
  const file = await getRepoFile(REPO_NAME, commitId, filePath, true);
  return response(200, { ref, commitId, ...file, encoding: "utf-8" });
}

async function getRunReview(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const runId = event.pathParameters?.runId;
  if (!runId) return response(400, { error: "runId is required" });
  const result = await ddb.send(
    new GetCommand({ TableName: RUNS_TABLE, Key: { runId } })
  );
  const run = result.Item;
  if (!run) return response(404, { error: "run not found" });
  const fixBranch = String(run.fixBranch ?? "");
  if (!/^fix\/[0-9a-f-]{36}$/.test(fixBranch)) {
    return response(409, { error: "this run has no inspectable fix branch" });
  }

  const implement = (run.implementResult ?? {}) as Record<string, unknown>;
  const baseCommitId = String(
    run.baseCommitId ?? (await resolveBranchCommit(REPO_NAME, BASE_BRANCH))
  );
  const fixCommitId = String(
    implement.fixCommitId ?? (await resolveBranchCommit(REPO_NAME, fixBranch))
  );
  const files = (await getReviewDiff(REPO_NAME, baseCommitId, fixCommitId)).map(
    (file) => ({
      ...file,
      before: file.before
        ? {
            ...file.before,
            ref: BASE_BRANCH,
            commitId: baseCommitId,
            baseCommitId,
            encoding: "utf-8",
          }
        : null,
      after: file.after
        ? {
            ...file.after,
            ref: fixBranch,
            commitId: fixCommitId,
            fixCommitId,
            encoding: "utf-8",
          }
        : null,
    })
  );
  return response(200, {
    runId,
    status: run.status,
    base: { branch: BASE_BRANCH, commitId: baseCommitId },
    fix: { branch: fixBranch, commitId: fixCommitId },
    files,
    evidence: {
      implementation: {
        engine: implement.engine,
        requestedModel: implement.requestedModel,
        actualModel: implement.actualModel,
        summary: implement.summary,
        filesChanged: implement.filesChanged ?? [],
        buildOk: implement.buildOk ?? false,
        buildOutput: implement.buildOutput ?? "",
        buildCommand: "npm install --no-audit --no-fund && npm run build",
        attempt: implement.attempt,
      },
      validation: run.validation ?? null,
      report: run.report ?? null,
      triage: run.triage ?? null,
      draft: run.draft ?? null,
    },
  });
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  try {
    if (event.rawPath === "/repository/refs") return await listRefs(event);
    if (event.rawPath === "/repository/tree") return await getTree(event);
    if (event.rawPath === "/repository/file") return await getFile(event);
    if (event.rawPath.endsWith("/review")) return await getRunReview(event);
    return response(404, { error: "repository route not found" });
  } catch (error) {
    return errorResponse(error);
  }
};
