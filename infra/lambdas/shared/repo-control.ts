import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.REPO_CONTROL_TABLE ?? "";
const REPO_NAME = process.env.REPO_NAME ?? "repository";
const BASE_BRANCH = process.env.BASE_BRANCH ?? "main";
const baseKey = { repoBranch: `${REPO_NAME}:${BASE_BRANCH}` };

async function incrementBaseImplementation(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: baseKey,
      UpdateExpression:
        "SET activeImplementations = if_not_exists(activeImplementations, :zero) + :one, updatedAt = :now",
      ConditionExpression:
        "attribute_not_exists(resetLeaseUntil) OR resetLeaseUntil < :now",
      ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":now": now },
    })
  );
}

async function decrementImplementation(key: { repoBranch: string }): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: key,
        UpdateExpression: "ADD activeImplementations :minusOne SET updatedAt = :now",
        ConditionExpression: "activeImplementations > :zero",
        ExpressionAttributeValues: { ":minusOne": -1, ":zero": 0, ":now": now },
      })
    );
  } catch (error) {
    console.warn("implementation lease release skipped", error);
  }
}

/** Acquire base-reset and branch-delete exclusions for the full writer operation. */
export async function acquireImplementationLease(fixBranch: string): Promise<void> {
  if (!TABLE) return;
  await incrementBaseImplementation();
  try {
    const now = Math.floor(Date.now() / 1000);
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { repoBranch: `${REPO_NAME}:${fixBranch}` },
        UpdateExpression:
          "SET activeImplementations = if_not_exists(activeImplementations, :zero) + :one, updatedAt = :now",
        ConditionExpression:
          "attribute_not_exists(deleteLeaseUntil) OR deleteLeaseUntil < :now",
        ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":now": now },
      })
    );
  } catch (error) {
    await decrementImplementation(baseKey);
    throw error;
  }
}

/** Release both exclusions. Counters are conditionally floored at zero. */
export async function releaseImplementationLease(fixBranch: string): Promise<void> {
  if (!TABLE) return;
  await Promise.all([
    decrementImplementation(baseKey),
    decrementImplementation({ repoBranch: `${REPO_NAME}:${fixBranch}` }),
  ]);
}
