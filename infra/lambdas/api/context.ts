import { createHash, randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  CONTEXT_MAX_ITEMS,
  CONTEXT_MAX_TOTAL_BYTES,
  CONTEXT_QUOTA_KEY,
  CONTEXT_URL_TTL_SECONDS,
  ContextItemRecord,
  contextKind,
  hasExpectedMagic,
  isUploadContentType,
  safeFileName,
  validateUploadSize,
} from "../shared/context";
import { callerIdentity, response } from "./http";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});
const TABLE = process.env.CONTEXT_TABLE!;
const BUCKET = process.env.CONTEXT_BUCKET!;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parseBody(event: APIGatewayProxyEventV2WithJWTAuthorizer): Record<string, unknown> {
  const parsed: unknown = JSON.parse(event.body ?? "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("INVALID_BODY");
  }
  return parsed as Record<string, unknown>;
}

function ownerSub(event: APIGatewayProxyEventV2WithJWTAuthorizer): string {
  const sub = callerIdentity(event).sub;
  if (!sub || sub === "unknown") throw new Error("INVALID_IDENTITY");
  return sub;
}

function itemKey(owner: string, itemId: string) {
  return { ownerSub: owner, itemKey: itemId };
}

function publicItem(item: ContextItemRecord) {
  return {
    itemId: item.itemId,
    kind: item.kind,
    fileName: item.fileName,
    contentType: item.contentType,
    sizeBytes: item.sizeBytes,
    digest: item.digest,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

async function reserveQuota(owner: string, sizeBytes: number): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { ownerSub: owner, itemKey: CONTEXT_QUOTA_KEY },
      UpdateExpression:
        "SET updatedAt = :now ADD itemCount :one, totalBytes :bytes",
      ConditionExpression:
        "(attribute_not_exists(itemCount) OR itemCount < :maxItems) AND " +
        "(attribute_not_exists(totalBytes) OR totalBytes <= :remainingBytes)",
      ExpressionAttributeValues: {
        ":now": new Date().toISOString(),
        ":one": 1,
        ":bytes": sizeBytes,
        ":maxItems": CONTEXT_MAX_ITEMS,
        ":remainingBytes": CONTEXT_MAX_TOTAL_BYTES - sizeBytes,
      },
    })
  );
}

async function releaseQuota(owner: string, sizeBytes: number): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { ownerSub: owner, itemKey: CONTEXT_QUOTA_KEY },
        UpdateExpression:
          "SET updatedAt = :now ADD itemCount :minusOne, totalBytes :minusBytes",
        ConditionExpression: "itemCount >= :one AND totalBytes >= :bytes",
        ExpressionAttributeValues: {
          ":now": new Date().toISOString(),
          ":minusOne": -1,
          ":minusBytes": -sizeBytes,
          ":one": 1,
          ":bytes": sizeBytes,
        },
      })
    );
  } catch (error) {
    console.error("context quota rollback failed", error);
  }
}

async function queryOwner(owner: string): Promise<Record<string, unknown>[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "ownerSub = :owner",
      ExpressionAttributeValues: { ":owner": owner },
      ConsistentRead: true,
    })
  );
  return result.Items ?? [];
}

async function deleteContextRecord(
  item: ContextItemRecord,
  expiresBefore?: number
): Promise<void> {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const purgeAfter = item.status === "DELETING"
    ? Number(item.purgeAfter ?? nowEpoch)
    : item.uploadExpiresAt
      ? Math.max(item.uploadExpiresAt, nowEpoch) + 60
      : nowEpoch;
  if (item.status !== "DELETING") {
    const condition = expiresBefore === undefined
      ? "#status = :expected"
      : "#status = :expected AND uploadExpiresAt < :expiresBefore";
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: itemKey(item.ownerSub, item.itemId),
              UpdateExpression:
                "SET #status = :deleting, deleteRequestedAt = :now, updatedAt = :now, purgeAfter = :purgeAfter",
              ConditionExpression: condition,
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":expected": item.status,
                ":deleting": "DELETING",
                ":now": new Date().toISOString(),
                ":purgeAfter": purgeAfter,
                ...(expiresBefore === undefined ? {} : { ":expiresBefore": expiresBefore }),
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
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: item.s3Key }));
  if (purgeAfter > Math.floor(Date.now() / 1000)) return;
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: itemKey(item.ownerSub, item.itemId),
      ConditionExpression: "#status = :deleting AND purgeAfter <= :nowEpoch",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":deleting": "DELETING",
        ":nowEpoch": Math.floor(Date.now() / 1000),
      },
    })
  );
}

async function cleanupExpiredPending(owner: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const stale = (await queryOwner(owner)).filter(
    (item) =>
      item.itemKey !== CONTEXT_QUOTA_KEY &&
      ((item.status === "DELETING" && Number(item.purgeAfter ?? 0) <= now) ||
        (item.status === "PENDING" && Number(item.uploadExpiresAt ?? 0) < now))
  );
  for (const raw of stale) {
    const item = raw as unknown as ContextItemRecord;
    try {
      await deleteContextRecord(item, item.status === "PENDING" ? now : undefined);
    } catch (error) {
      if ((error as { name?: string }).name !== "TransactionCanceledException") {
        console.warn("stale context cleanup failed", error);
      }
    }
  }
}

async function getOwnedItem(owner: string, itemId: string): Promise<ContextItemRecord | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: itemKey(owner, itemId),
      ConsistentRead: true,
    })
  );
  return result.Item as ContextItemRecord | undefined;
}

async function removeRejectedReservation(item: ContextItemRecord): Promise<void> {
  await deleteContextRecord(item);
}

async function listContext(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const owner = ownerSub(event);
  await cleanupExpiredPending(owner);
  const records = await queryOwner(owner);
  const quota = records.find((item) => item.itemKey === CONTEXT_QUOTA_KEY);
  const items = records
    .filter((item) => item.itemKey !== CONTEXT_QUOTA_KEY && item.status === "READY")
    .map((item) => publicItem(item as unknown as ContextItemRecord))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return response(200, {
    items,
    quota: {
      itemCount: Number(quota?.itemCount ?? 0),
      totalBytes: Number(quota?.totalBytes ?? 0),
      maxItems: CONTEXT_MAX_ITEMS,
      maxTotalBytes: CONTEXT_MAX_TOTAL_BYTES,
    },
  });
}

async function createNote(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const owner = ownerSub(event);
  const body = parseBody(event);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return response(400, { error: "text is required" });
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > CONTEXT_MAX_TOTAL_BYTES) {
    return response(413, { error: "note exceeds the context byte quota" });
  }
  await cleanupExpiredPending(owner);
  await reserveQuota(owner, bytes.length);

  const itemId = randomUUID();
  const now = new Date().toISOString();
  const rawTitle = safeFileName(body.title, "Context note");
  const fileName = rawTitle.toLowerCase().endsWith(".txt") ? rawTitle : `${rawTitle}.txt`.slice(0, 120);
  const s3Key = `users/${owner}/items/${itemId}`;
  const item: ContextItemRecord = {
    ownerSub: owner,
    itemKey: itemId,
    itemId,
    status: "READY",
    kind: "note",
    fileName,
    contentType: "text/plain",
    sizeBytes: bytes.length,
    s3Key,
    digest: createHash("sha256").update(bytes).digest("hex"),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        Body: bytes,
        ContentType: "text/plain",
        ServerSideEncryption: "AES256",
      })
    );
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(ownerSub) AND attribute_not_exists(itemKey)",
      })
    );
    return response(201, { item: publicItem(item) });
  } catch (error) {
    await Promise.allSettled([
      s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: s3Key })),
      releaseQuota(owner, bytes.length),
    ]);
    throw error;
  }
}

async function reserveUpload(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const owner = ownerSub(event);
  const body = parseBody(event);
  const contentType = typeof body.contentType === "string" ? body.contentType : "";
  if (!isUploadContentType(contentType)) {
    return response(415, { error: "only PDF, JPEG, PNG, and WebP files are supported" });
  }
  const sizeBytes = Number(body.sizeBytes);
  const sizeError = validateUploadSize(contentType, sizeBytes);
  if (sizeError) return response(413, { error: sizeError });
  const fileName = safeFileName(body.fileName, "context-file");
  const checksumSha256 = typeof body.checksumSha256 === "string" ? body.checksumSha256 : "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(checksumSha256)) {
    return response(400, { error: "checksumSha256 must be a base64-encoded SHA-256 digest" });
  }

  await cleanupExpiredPending(owner);
  await reserveQuota(owner, sizeBytes);
  const itemId = randomUUID();
  const now = new Date().toISOString();
  const uploadExpiresAt = Math.floor(Date.now() / 1000) + CONTEXT_URL_TTL_SECONDS;
  const s3Key = `users/${owner}/items/${itemId}`;
  const item: ContextItemRecord = {
    ownerSub: owner,
    itemKey: itemId,
    itemId,
    status: "PENDING",
    kind: contextKind(contentType),
    fileName,
    contentType,
    sizeBytes,
    s3Key,
    checksumSha256,
    createdAt: now,
    updatedAt: now,
    uploadExpiresAt,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(ownerSub) AND attribute_not_exists(itemKey)",
      })
    );
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        ContentType: contentType,
        ChecksumSHA256: checksumSha256,
      }),
      { expiresIn: CONTEXT_URL_TTL_SECONDS, signableHeaders: new Set(["content-type"]) }
    );
    return response(201, {
      itemId,
      uploadUrl,
      expiresAt: new Date(uploadExpiresAt * 1000).toISOString(),
      requiredHeaders: { "Content-Type": contentType },
    });
  } catch (error) {
    await Promise.allSettled([
      ddb.send(new DeleteCommand({ TableName: TABLE, Key: itemKey(owner, itemId) })),
      releaseQuota(owner, sizeBytes),
    ]);
    throw error;
  }
}

async function completeUpload(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const owner = ownerSub(event);
  const itemId = event.pathParameters?.itemId ?? "";
  if (!UUID_PATTERN.test(itemId)) return response(400, { error: "invalid itemId" });
  const item = await getOwnedItem(owner, itemId);
  if (!item) return response(404, { error: "context item not found" });
  if (item.status === "READY") return response(200, { item: publicItem(item) });
  if (item.status !== "PENDING") return response(409, { error: "context item is not pending" });
  if (Number(item.uploadExpiresAt ?? 0) < Math.floor(Date.now() / 1000)) {
    await removeRejectedReservation(item);
    return response(410, { error: "upload reservation expired" });
  }
  if (!isUploadContentType(item.contentType)) {
    await removeRejectedReservation(item);
    return response(409, { error: "invalid upload metadata" });
  }

  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: item.s3Key }));
    if (head.ContentLength !== item.sizeBytes || head.ContentType !== item.contentType) {
      await removeRejectedReservation(item);
      return response(400, { error: "uploaded object size or Content-Type does not match the reservation" });
    }
    const sizeError = validateUploadSize(item.contentType, Number(head.ContentLength));
    if (sizeError) {
      await removeRejectedReservation(item);
      return response(413, { error: sizeError });
    }
    const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: item.s3Key }));
    const bytes = await object.Body?.transformToByteArray();
    if (!bytes || bytes.length !== item.sizeBytes || !hasExpectedMagic(item.contentType, bytes)) {
      await removeRejectedReservation(item);
      return response(400, { error: "uploaded object signature does not match its declared Content-Type" });
    }
    const updatedAt = new Date().toISOString();
    const digestBytes = createHash("sha256").update(bytes).digest();
    const digest = digestBytes.toString("hex");
    const checksumSha256 = digestBytes.toString("base64");
    if (!item.checksumSha256 || checksumSha256 !== item.checksumSha256) {
      await removeRejectedReservation(item);
      return response(400, { error: "uploaded object checksum does not match the signed reservation" });
    }
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: itemKey(owner, itemId),
        UpdateExpression: "SET #status = :ready, digest = :digest, updatedAt = :now",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":ready": "READY",
          ":pending": "PENDING",
          ":digest": digest,
          ":now": updatedAt,
        },
      })
    );
    return response(200, { item: publicItem({ ...item, status: "READY", digest, updatedAt }) });
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchKey" || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
      return response(409, { error: "upload has not reached object storage" });
    }
    throw error;
  }
}

async function previewItem(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const owner = ownerSub(event);
  const itemId = event.pathParameters?.itemId ?? "";
  if (!UUID_PATTERN.test(itemId)) return response(400, { error: "invalid itemId" });
  const item = await getOwnedItem(owner, itemId);
  if (!item || item.status !== "READY") return response(404, { error: "context item not found" });
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: item.s3Key,
      ResponseContentType: item.contentType,
      ResponseContentDisposition: `inline; filename="${item.fileName.replace(/["\\]/g, "_")}"`,
    }),
    { expiresIn: CONTEXT_URL_TTL_SECONDS }
  );
  return response(200, { url, expiresInSeconds: CONTEXT_URL_TTL_SECONDS, item: publicItem(item) });
}

async function deleteItem(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const owner = ownerSub(event);
  const itemId = event.pathParameters?.itemId ?? "";
  if (!UUID_PATTERN.test(itemId)) return response(400, { error: "invalid itemId" });
  const item = await getOwnedItem(owner, itemId);
  if (!item) return response(404, { error: "context item not found" });

  await deleteContextRecord(item);
  return response(200, { ok: true, itemId });
}

function errorResponse(error: unknown): APIGatewayProxyResultV2 {
  const name = (error as { name?: string }).name ?? "";
  const message = error instanceof Error ? error.message : "";
  if (message === "INVALID_BODY") return response(400, { error: "JSON body must be an object" });
  if (message === "INVALID_IDENTITY") return response(401, { error: "authenticated subject is required" });
  if (name === "SyntaxError") return response(400, { error: "invalid JSON body" });
  if (name === "ConditionalCheckFailedException") {
    return response(409, { error: "context quota exceeded or context item changed; refresh and try again" });
  }
  if (name === "TransactionCanceledException") {
    return response(409, { error: "context item changed; refresh and try again" });
  }
  console.error("context API failed", error);
  return response(500, { error: "context operation failed" });
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  try {
    const method = event.requestContext.http.method;
    if (method === "GET" && event.rawPath === "/context") return await listContext(event);
    if (method === "POST" && event.rawPath === "/context/notes") return await createNote(event);
    if (method === "POST" && event.rawPath === "/context/uploads") return await reserveUpload(event);
    if (method === "POST" && event.rawPath.endsWith("/complete")) return await completeUpload(event);
    if (method === "GET" && event.rawPath.endsWith("/preview")) return await previewItem(event);
    if (method === "DELETE" && /^\/context\/[^/]+$/.test(event.rawPath)) return await deleteItem(event);
    return response(404, { error: "context route not found" });
  } catch (error) {
    return errorResponse(error);
  }
};
