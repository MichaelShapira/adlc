import { randomUUID } from "node:crypto";
import { DeleteBranchCommand, GetBranchCommand } from "@aws-sdk/client-codecommit";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { codeCommitClient } from "../shared/codecommit";
import { callerIdentity, response } from "./http";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const REPO_NAME = process.env.REPO_NAME!;
const RUNS_TABLE = process.env.RUNS_TABLE!;
const CONTROL_TABLE = process.env.REPO_CONTROL_TABLE!;
const AUDIT_TABLE = process.env.RESET_AUDIT_TABLE!;
const RESETTER_GROUP = process.env.RESETTER_GROUP ?? "repo-resetters";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT_PATTERN = /^[0-9a-fA-F]{40}$/;
const ACTIVE_STATUSES = new Set([
  "PENDING",
  "TRIAGING",
  "DRAFTING",
  "AWAITING_APPROVAL",
  "IMPLEMENTING",
  "VALIDATING",
]);

async function updateAudit(
  actionId: string,
  status: "SUCCEEDED" | "REJECTED" | "FAILED",
  fields: Record<string, unknown> = {}
): Promise<void> {
  const names: Record<string, string> = { "#status": "status" };
  const values: Record<string, unknown> = {
    ":status": status,
    ":completedAt": new Date().toISOString(),
  };
  const sets = ["#status = :status", "completedAt = :completedAt"];
  Object.entries(fields).forEach(([key, value], index) => {
    names[`#field${index}`] = key;
    values[`:field${index}`] = value;
    sets.push(`#field${index} = :field${index}`);
  });
  await ddb.send(
    new UpdateCommand({
      TableName: AUDIT_TABLE,
      Key: { actionId },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}

async function acquireDeleteLease(branch: string, actionId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await ddb.send(
    new UpdateCommand({
      TableName: CONTROL_TABLE,
      Key: { repoBranch: `${REPO_NAME}:${branch}` },
      UpdateExpression: "SET deleteOwner = :owner, deleteLeaseUntil = :until, updatedAt = :now",
      ConditionExpression:
        "(attribute_not_exists(deleteLeaseUntil) OR deleteLeaseUntil < :now) AND " +
        "(attribute_not_exists(activeImplementations) OR activeImplementations = :zero)",
      ExpressionAttributeValues: {
        ":owner": actionId,
        ":until": now + 60,
        ":now": now,
        ":zero": 0,
      },
    })
  );
}

async function releaseDeleteLease(branch: string, actionId: string): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: CONTROL_TABLE,
        Key: { repoBranch: `${REPO_NAME}:${branch}` },
        UpdateExpression: "REMOVE deleteOwner, deleteLeaseUntil SET updatedAt = :now",
        ConditionExpression: "deleteOwner = :owner",
        ExpressionAttributeValues: {
          ":owner": actionId,
          ":now": Math.floor(Date.now() / 1000),
        },
      })
    );
  } catch (error) {
    console.warn("fix-branch delete lease release skipped", error);
  }
}

async function branchHead(branch: string): Promise<string> {
  const result = await codeCommitClient.send(
    new GetBranchCommand({ repositoryName: REPO_NAME, branchName: branch })
  );
  const commitId = result.branch?.commitId;
  if (!commitId) throw new Error("BRANCH_NOT_FOUND");
  return commitId;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const runId = event.pathParameters?.runId ?? "";
  if (!UUID_PATTERN.test(runId)) return response(400, { error: "invalid runId" });
  const branch = `fix/${runId}`;
  if (branch === "main" || !/^fix\/[0-9a-f-]{36}$/.test(branch)) {
    return response(400, { error: "invalid fix branch" });
  }

  const caller = callerIdentity(event);
  const actionId = randomUUID();
  const startedAt = new Date().toISOString();
  await ddb.send(
    new PutCommand({
      TableName: AUDIT_TABLE,
      Item: {
        actionId,
        action: "DELETE_FIX_BRANCH",
        repositoryName: REPO_NAME,
        branch,
        runId,
        callerSub: caller.sub,
        callerEmail: caller.email,
        status: "PENDING",
        startedAt,
      },
      ConditionExpression: "attribute_not_exists(actionId)",
    })
  );

  let leaseAcquired = false;
  try {
    if (!caller.groups.includes(RESETTER_GROUP)) {
      await updateAudit(actionId, "REJECTED", { errorCategory: "NOT_AUTHORIZED" });
      return response(403, { error: `membership in ${RESETTER_GROUP} is required` });
    }

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(event.body ?? "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("INVALID_BODY");
      }
      body = parsed as Record<string, unknown>;
    } catch {
      await updateAudit(actionId, "REJECTED", { errorCategory: "INVALID_BODY" });
      return response(400, { error: "JSON body must be an object" });
    }
    const requiredConfirmation = `DELETE ${branch}`;
    if (body.confirmation !== requiredConfirmation) {
      await updateAudit(actionId, "REJECTED", { errorCategory: "CONFIRMATION_MISMATCH" });
      return response(400, { error: `type ${requiredConfirmation} to confirm` });
    }
    if (typeof body.expectedCommitId !== "string" || !COMMIT_PATTERN.test(body.expectedCommitId)) {
      await updateAudit(actionId, "REJECTED", { errorCategory: "INVALID_EXPECTED_COMMIT" });
      return response(400, { error: "expectedCommitId must be a 40-character hexadecimal commit id" });
    }
    const expectedCommitId = body.expectedCommitId.toLowerCase();

    const runResult = await ddb.send(
      new GetCommand({ TableName: RUNS_TABLE, Key: { runId }, ConsistentRead: true })
    );
    const run = runResult.Item;
    if (!run) {
      await updateAudit(actionId, "REJECTED", { errorCategory: "RUN_NOT_FOUND" });
      return response(404, { error: "run or fix branch not found" });
    }
    if (run.fixBranch !== branch) {
      await updateAudit(actionId, "REJECTED", { errorCategory: "RUN_BRANCH_MISMATCH" });
      return response(409, { error: "run does not own the requested fix branch" });
    }
    const status = String(run.status ?? "");
    if (ACTIVE_STATUSES.has(status)) {
      await updateAudit(actionId, "REJECTED", { errorCategory: "RUN_ACTIVE", runStatus: status });
      return response(409, { error: `fix branch cannot be deleted while run status is ${status}` });
    }

    await acquireDeleteLease(branch, actionId);
    leaseAcquired = true;
    const firstHead = await branchHead(branch);
    if (firstHead.toLowerCase() !== expectedCommitId) {
      await updateAudit(actionId, "REJECTED", {
        errorCategory: "HEAD_CHANGED",
        expectedCommitId,
        currentCommitId: firstHead,
      });
      return response(409, {
        error: "fix branch changed after the confirmation was opened; refresh and try again",
        currentCommitId: firstHead,
      });
    }

    const recheckedHead = await branchHead(branch);
    if (recheckedHead.toLowerCase() !== expectedCommitId) {
      await updateAudit(actionId, "REJECTED", {
        errorCategory: "HEAD_CHANGED_ON_RECHECK",
        expectedCommitId,
        currentCommitId: recheckedHead,
      });
      return response(409, {
        error: "fix branch changed immediately before deletion; refresh and try again",
        currentCommitId: recheckedHead,
      });
    }

    const deleted = await codeCommitClient.send(
      new DeleteBranchCommand({ repositoryName: REPO_NAME, branchName: branch })
    );
    const deletedCommitId = deleted.deletedBranch?.commitId ?? recheckedHead;
    await updateAudit(actionId, "SUCCEEDED", {
      expectedCommitId,
      deletedCommitId,
      preservedRunHistory: true,
    });
    return response(200, {
      ok: true,
      actionId,
      branch,
      deletedCommitId,
      preservedRunHistory: true,
    });
  } catch (error) {
    console.error("fix-branch deletion failed", error);
    const name = error instanceof Error ? error.name : "UNKNOWN";
    const category = error instanceof Error && error.message === "BRANCH_NOT_FOUND"
      ? "BRANCH_NOT_FOUND"
      : name;
    await updateAudit(actionId, "FAILED", { errorCategory: category });
    if (name === "ConditionalCheckFailedException") {
      return response(409, { error: "fix branch is busy; refresh and try again" });
    }
    if (category === "BRANCH_NOT_FOUND" || name === "BranchDoesNotExistException") {
      return response(404, { error: "run or fix branch not found" });
    }
    return response(500, { error: "fix branch deletion failed", actionId });
  } finally {
    if (leaseAcquired) await releaseDeleteLease(branch, actionId);
  }
};
