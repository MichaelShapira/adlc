import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { CONTEXT_QUOTA_KEY, ContextItemRecord } from "../shared/context";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const TABLE = process.env.CONTEXT_TABLE!;
const BUCKET = process.env.CONTEXT_BUCKET!;

async function markDeleting(
  item: ContextItemRecord,
  nowEpoch: number,
  purgeAfter: number
): Promise<void> {
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE,
            Key: { ownerSub: item.ownerSub, itemKey: item.itemKey },
            UpdateExpression:
              "SET #status = :deleting, deleteRequestedAt = :now, updatedAt = :now, purgeAfter = :purgeAfter",
            ConditionExpression: "#status = :pending AND uploadExpiresAt < :nowEpoch",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":pending": "PENDING",
              ":deleting": "DELETING",
              ":now": new Date().toISOString(),
              ":nowEpoch": nowEpoch,
              ":purgeAfter": purgeAfter,
            },
          },
        },
        {
          Update: {
            TableName: TABLE,
            Key: { ownerSub: item.ownerSub, itemKey: CONTEXT_QUOTA_KEY },
            UpdateExpression: "SET updatedAt = :now ADD itemCount :minusOne, totalBytes :minusBytes",
            ConditionExpression: "itemCount >= :one AND totalBytes >= :bytes",
            ExpressionAttributeValues: {
              ":now": new Date().toISOString(),
              ":minusOne": -1,
              ":minusBytes": -item.sizeBytes,
              ":one": 1,
              ":bytes": item.sizeBytes,
            },
          },
        },
      ],
    })
  );
}

async function finalize(item: ContextItemRecord, nowEpoch: number): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: item.s3Key }));
  if (Number(item.purgeAfter ?? 0) > nowEpoch) return;
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { ownerSub: item.ownerSub, itemKey: item.itemKey },
      ConditionExpression: "#status = :deleting AND purgeAfter <= :nowEpoch",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":deleting": "DELETING",
        ":nowEpoch": nowEpoch,
      },
    })
  );
}

export const handler = async (): Promise<void> => {
  const nowEpoch = Math.floor(Date.now() / 1000);
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let cleanedCount = 0;
  let cleanedBytes = 0;
  let failedCount = 0;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression:
          "(#status = :deleting AND purgeAfter <= :nowEpoch) OR " +
          "(#status = :pending AND uploadExpiresAt < :nowEpoch)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":deleting": "DELETING",
          ":pending": "PENDING",
          ":nowEpoch": nowEpoch,
        },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    for (const raw of result.Items ?? []) {
      const item = raw as unknown as ContextItemRecord;
      try {
        const purgeAfter = item.status === "PENDING"
          ? Math.max(Number(item.uploadExpiresAt ?? 0), nowEpoch) + 60
          : Number(item.purgeAfter ?? nowEpoch);
        if (item.status === "PENDING") await markDeleting(item, nowEpoch, purgeAfter);
        await finalize({ ...item, status: "DELETING", purgeAfter }, nowEpoch);
        cleanedCount += 1;
        cleanedBytes += item.sizeBytes;
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (name !== "TransactionCanceledException" && name !== "ConditionalCheckFailedException") {
          failedCount += 1;
          console.warn("context cleanup item failed", { name });
        }
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  console.log("context cleanup complete", { cleanedCount, cleanedBytes, failedCount });
};
