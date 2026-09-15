import { createHash, randomUUID } from "node:crypto";
import {
  CreateCommitCommand,
  NoChangeException,
} from "@aws-sdk/client-codecommit";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  SFNClient,
  ListExecutionsCommand,
  StopExecutionCommand,
} from "@aws-sdk/client-sfn";
import {
  codeCommitClient,
  getRepoSnapshot,
  getRootCommit,
  resolveBranchCommit,
} from "../shared/codecommit";
import { callerIdentity, response } from "./http";
import * as https from "node:https";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";

const sfnClient = new SFNClient({});
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;
const AGENT_SPACE_ID = process.env.AGENT_SPACE_ID;
const REGION = process.env.AWS_REGION ?? "us-east-1";

const signer = new SignatureV4({
  credentials: defaultProvider(),
  region: REGION,
  service: "securityagent",
  sha256: Sha256,
});

async function securityAgentApi(operation: string, body: Record<string, unknown>): Promise<unknown> {
  const hostname = `securityagent.${REGION}.api.aws`;
  const path = `/${operation}`;
  const bodyStr = JSON.stringify(body);
  const signed = await signer.sign({
    method: "POST", protocol: "https:", hostname, path,
    headers: { host: hostname, "content-type": "application/json" },
    body: bodyStr,
  });
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "POST", headers: signed.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(text)); } catch { resolve(text); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

async function stopRunningExecutions(): Promise<number> {
  if (!STATE_MACHINE_ARN) return 0;
  let stopped = 0;
  const resp = await sfnClient.send(new ListExecutionsCommand({
    stateMachineArn: STATE_MACHINE_ARN,
    statusFilter: "RUNNING",
    maxResults: 20,
  }));
  for (const exec of resp.executions ?? []) {
    try {
      await sfnClient.send(new StopExecutionCommand({
        executionArn: exec.executionArn,
        cause: "Repository reset — cleaning up",
      }));
      stopped++;
    } catch { /* ignore */ }
  }
  return stopped;
}

async function stopSecurityAgentJobs(): Promise<{ stoppedPentests: number; stoppedCodeReviews: number }> {
  if (!AGENT_SPACE_ID) return { stoppedPentests: 0, stoppedCodeReviews: 0 };
  let stoppedPentests = 0;
  let stoppedCodeReviews = 0;

  // Stop running pentests
  try {
    const pentests = (await securityAgentApi("ListPentests", { agentSpaceId: AGENT_SPACE_ID })) as {
      pentestSummaries?: Array<{ pentestId: string }>;
    };
    for (const pt of pentests.pentestSummaries ?? []) {
      const jobs = (await securityAgentApi("ListPentestJobsForPentest", {
        pentestId: pt.pentestId, agentSpaceId: AGENT_SPACE_ID,
      })) as { pentestJobSummaries?: Array<{ pentestJobId: string; status: string }> };
      for (const j of jobs.pentestJobSummaries ?? []) {
        if (j.status === "IN_PROGRESS") {
          try {
            await securityAgentApi("StopPentestJob", {
              pentestId: pt.pentestId, pentestJobId: j.pentestJobId, agentSpaceId: AGENT_SPACE_ID,
            });
            stoppedPentests++;
          } catch { /* ignore */ }
        }
      }
    }
  } catch (err) { console.warn("Failed to stop pentests:", err); }

  // Stop running code reviews
  try {
    const reviews = (await securityAgentApi("ListCodeReviews", { agentSpaceId: AGENT_SPACE_ID })) as {
      codeReviewSummaries?: Array<{ codeReviewId: string }>;
    };
    for (const cr of reviews.codeReviewSummaries ?? []) {
      const jobs = (await securityAgentApi("ListCodeReviewJobsForCodeReview", {
        codeReviewId: cr.codeReviewId, agentSpaceId: AGENT_SPACE_ID,
      })) as { codeReviewJobSummaries?: Array<{ codeReviewJobId: string; status: string }> };
      for (const j of jobs.codeReviewJobSummaries ?? []) {
        if (j.status === "IN_PROGRESS") {
          try {
            await securityAgentApi("StopCodeReviewJob", {
              codeReviewId: cr.codeReviewId, codeReviewJobId: j.codeReviewJobId, agentSpaceId: AGENT_SPACE_ID,
            });
            stoppedCodeReviews++;
          } catch { /* ignore */ }
        }
      }
    }
  } catch (err) { console.warn("Failed to stop code reviews:", err); }

  return { stoppedPentests, stoppedCodeReviews };
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const REPO_NAME = process.env.REPO_NAME!;
const BASE_BRANCH = process.env.BASE_BRANCH ?? "main";
const RUNS_TABLE = process.env.RUNS_TABLE!;
const CONTROL_TABLE = process.env.REPO_CONTROL_TABLE!;
const AUDIT_TABLE = process.env.RESET_AUDIT_TABLE!;
const RESETTER_GROUP = process.env.RESETTER_GROUP ?? "repo-resetters";
const CONTROL_KEY = { repoBranch: `${REPO_NAME}:${BASE_BRANCH}` };
const ACTIVE_STATUSES = new Set([
  "PENDING",
  "TRIAGING",
  "DRAFTING",
  "AWAITING_APPROVAL",
  "IMPLEMENTING",
  "VALIDATING",
]);

async function getActiveRuns(): Promise<Array<{ runId: string; status: string }>> {
  const active: Array<{ runId: string; status: string }> = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: RUNS_TABLE,
        ProjectionExpression: "runId, #s",
        ExpressionAttributeNames: { "#s": "status" },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    for (const item of res.Items ?? []) {
      const status = String(item.status ?? "");
      if (ACTIVE_STATUSES.has(status)) {
        active.push({ runId: String(item.runId), status });
      }
    }
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return active;
}

function seedDigest(files: Array<{ path: string; content: string }>): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function repositoryState() {
  const mainHeadCommitId = await resolveBranchCommit(REPO_NAME, BASE_BRANCH);
  const canonicalCommitId = await getRootCommit(REPO_NAME, mainHeadCommitId);
  const seedFiles = await getRepoSnapshot(REPO_NAME, canonicalCommitId, "/", false);
  const currentFiles = await getRepoSnapshot(REPO_NAME, mainHeadCommitId, "/", false);
  const seedMap = new Map(seedFiles.map((file) => [file.path, file.content]));
  const currentMap = new Map(currentFiles.map((file) => [file.path, file.content]));
  const alreadyCanonical =
    seedMap.size === currentMap.size &&
    [...seedMap].every(([path, content]) => currentMap.get(path) === content);
  return {
    mainHeadCommitId,
    canonicalCommitId,
    seedFiles,
    currentFiles,
    seedDigest: seedDigest(seedFiles),
    alreadyCanonical,
  };
}

async function acquireResetLease(owner: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await ddb.send(
    new UpdateCommand({
      TableName: CONTROL_TABLE,
      Key: CONTROL_KEY,
      UpdateExpression:
        "SET resetOwner = :owner, resetLeaseUntil = :until, updatedAt = :now",
      ConditionExpression:
        "(attribute_not_exists(resetLeaseUntil) OR resetLeaseUntil < :now) AND " +
        "(attribute_not_exists(activeImplementations) OR activeImplementations = :zero)",
      ExpressionAttributeValues: {
        ":owner": owner,
        ":until": now + 120,
        ":now": now,
        ":zero": 0,
      },
    })
  );
}

async function releaseResetLease(owner: string): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: CONTROL_TABLE,
        Key: CONTROL_KEY,
        UpdateExpression: "REMOVE resetOwner, resetLeaseUntil SET updatedAt = :now",
        ConditionExpression: "resetOwner = :owner",
        ExpressionAttributeValues: {
          ":owner": owner,
          ":now": Math.floor(Date.now() / 1000),
        },
      })
    );
  } catch (error) {
    console.warn("reset lease release skipped", error);
  }
}

async function getStatus(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const caller = callerIdentity(event);
  const [state, activeRuns] = await Promise.all([repositoryState(), getActiveRuns()]);
  const resetAllowed = caller.groups.includes(RESETTER_GROUP);
  return response(200, {
    repositoryName: REPO_NAME,
    branch: BASE_BRANCH,
    mainHeadCommitId: state.mainHeadCommitId,
    canonicalCommitId: state.canonicalCommitId,
    seedDigest: state.seedDigest,
    alreadyCanonical: state.alreadyCanonical,
    activeRuns,
    canReset: resetAllowed,
    resetAllowed,
    requiredConfirmation: `RESET ${BASE_BRANCH}`,
  });
}

async function resetRepository(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const caller = callerIdentity(event);
  if (!caller.groups.includes(RESETTER_GROUP)) {
    return response(403, { error: `membership in ${RESETTER_GROUP} is required` });
  }

  let body: { confirmation?: unknown; expectedHeadCommitId?: unknown };
  try {
    const parsed: unknown = JSON.parse(event.body ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return response(400, { error: "JSON body must be an object" });
    }
    body = parsed as typeof body;
  } catch {
    return response(400, { error: "invalid JSON body" });
  }
  if (body.confirmation !== `RESET ${BASE_BRANCH}`) {
    return response(400, { error: `type RESET ${BASE_BRANCH} to confirm` });
  }
  if (typeof body.expectedHeadCommitId !== "string" || !/^[0-9a-f]{40}$/.test(body.expectedHeadCommitId)) {
    return response(400, { error: "expectedHeadCommitId is required" });
  }

  // Stop any running Step Function executions and Security Agent jobs
  const [stoppedExecs, secAgentStopped] = await Promise.all([
    stopRunningExecutions(),
    stopSecurityAgentJobs(),
  ]);
  if (stoppedExecs > 0 || secAgentStopped.stoppedPentests > 0 || secAgentStopped.stoppedCodeReviews > 0) {
    console.log(`Reset cleanup: ${stoppedExecs} executions, ${secAgentStopped.stoppedPentests} pentests, ${secAgentStopped.stoppedCodeReviews} code reviews stopped`);
  }

  // Mark any DB-active runs as ABORTED
  const activeRuns = await getActiveRuns();
  for (const run of activeRuns) {
    await ddb.send(new UpdateCommand({
      TableName: RUNS_TABLE,
      Key: { runId: run.runId },
      UpdateExpression: "SET #s = :aborted, updatedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":aborted": "ABORTED", ":now": new Date().toISOString() },
    }));
  }

  const actionId = randomUUID();
  const startedAt = new Date().toISOString();
  await ddb.send(
    new PutCommand({
      TableName: AUDIT_TABLE,
      Item: {
        actionId,
        action: "RESET_CANONICAL_DEMO",
        repositoryName: REPO_NAME,
        branch: BASE_BRANCH,
        callerSub: caller.sub,
        callerEmail: caller.email,
        expectedHeadCommitId: body.expectedHeadCommitId,
        status: "PENDING",
        startedAt,
      },
    })
  );

  let leaseAcquired = false;
  try {
    await acquireResetLease(actionId);
    leaseAcquired = true;
    const state = await repositoryState();
    if (state.mainHeadCommitId !== body.expectedHeadCommitId) {
      await ddb.send(
        new UpdateCommand({
          TableName: AUDIT_TABLE,
          Key: { actionId },
          UpdateExpression: "SET #s = :s, errorCategory = :e, completedAt = :now",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":s": "REJECTED",
            ":e": "HEAD_CHANGED",
            ":now": new Date().toISOString(),
          },
        })
      );
      return response(409, {
        error: "main changed after the reset confirmation was opened; refresh and try again",
        currentHeadCommitId: state.mainHeadCommitId,
      });
    }

    let newCommitId = state.mainHeadCommitId;
    let alreadyCanonical = state.alreadyCanonical;
    if (!alreadyCanonical) {
      const canonicalPaths = new Set(state.seedFiles.map((file) => file.path));
      const deleteFiles = state.currentFiles
        .filter((file) => !canonicalPaths.has(file.path))
        .map((file) => ({ filePath: file.path }));
      try {
        const created = await codeCommitClient.send(
          new CreateCommitCommand({
            repositoryName: REPO_NAME,
            branchName: BASE_BRANCH,
            parentCommitId: state.mainHeadCommitId,
            authorName: "ADLC Demo Reset",
            email: "adlc-demo-reset@example.com",
            commitMessage: `chore: Restore canonical buggy demo state\n\nReset action: ${actionId}`,
            putFiles: state.seedFiles.map((file) => ({
              filePath: file.path,
              fileMode: file.fileMode ?? "NORMAL",
              fileContent: Buffer.from(file.content, "utf-8"),
            })),
            deleteFiles,
          })
        );
        newCommitId = created.commitId ?? state.mainHeadCommitId;
      } catch (error) {
        if (!(error instanceof NoChangeException)) throw error;
        alreadyCanonical = true;
      }
    }

    await ddb.send(
      new UpdateCommand({
        TableName: AUDIT_TABLE,
        Key: { actionId },
        UpdateExpression:
          "SET #s = :s, previousCommitId = :previous, newCommitId = :new, " +
          "canonicalCommitId = :canonical, seedDigest = :digest, alreadyCanonical = :already, completedAt = :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": "SUCCEEDED",
          ":previous": state.mainHeadCommitId,
          ":new": newCommitId,
          ":canonical": state.canonicalCommitId,
          ":digest": state.seedDigest,
          ":already": alreadyCanonical,
          ":now": new Date().toISOString(),
        },
      })
    );
    return response(200, {
      ok: true,
      actionId,
      previousCommitId: state.mainHeadCommitId,
      newCommitId,
      canonicalCommitId: state.canonicalCommitId,
      seedDigest: state.seedDigest,
      alreadyCanonical,
      preservedFixBranches: true,
      preservedRunHistory: true,
    });
  } catch (error) {
    console.error("repository reset failed", error);
    await ddb.send(
      new UpdateCommand({
        TableName: AUDIT_TABLE,
        Key: { actionId },
        UpdateExpression: "SET #s = :s, errorCategory = :e, completedAt = :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": "FAILED",
          ":e": error instanceof Error ? error.name : "UNKNOWN",
          ":now": new Date().toISOString(),
        },
      })
    );
    const name = error instanceof Error ? error.name : "";
    if (name === "ConditionalCheckFailedException") {
      return response(409, { error: "repository is busy; wait for the active operation" });
    }
    return response(500, { error: "repository reset failed", actionId });
  } finally {
    if (leaseAcquired) await releaseResetLease(actionId);
  }
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  return event.requestContext.http.method === "GET"
    ? getStatus(event)
    : resetRepository(event);
};
