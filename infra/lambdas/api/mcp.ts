import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { MCP_CONFIG_KEY, MCP_MAX_CONFIG_BYTES, validateMcpConfig } from "../shared/mcp";
import { callerIdentity, response } from "./http";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = process.env.CONTEXT_TABLE!;

function ownerSub(event: APIGatewayProxyEventV2WithJWTAuthorizer): string {
  const sub = callerIdentity(event).sub;
  if (!sub || sub === "unknown") throw new Error("INVALID_IDENTITY");
  return sub;
}

/** GET /mcp/config — return the caller's saved MCP configuration. */
async function getConfig(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const owner = ownerSub(event);
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { ownerSub: owner, itemKey: MCP_CONFIG_KEY },
      ConsistentRead: true,
    })
  );
  const item = result.Item;
  const configJson = typeof item?.configJson === "string" ? item.configJson : "";
  const validation = validateMcpConfig(configJson);
  return response(200, {
    configJson,
    updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : undefined,
    serverCount: validation.serverCount,
    enabledCount: validation.enabledCount,
    maxBytes: MCP_MAX_CONFIG_BYTES,
  });
}

/** POST /mcp/config — save (or clear, with empty configJson) the MCP configuration. */
async function saveConfig(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const owner = ownerSub(event);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(event.body ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return response(400, { error: "JSON body must be an object" });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return response(400, { error: "invalid JSON body" });
  }
  if (typeof body.configJson !== "string") {
    return response(400, { error: "configJson must be a string" });
  }
  const configJson = body.configJson;
  const validation = validateMcpConfig(configJson);
  if (validation.error) return response(400, { error: validation.error });

  const now = new Date().toISOString();
  if (!configJson.trim()) {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { ownerSub: owner, itemKey: MCP_CONFIG_KEY },
      })
    );
    return response(200, { configJson: "", serverCount: 0, enabledCount: 0, updatedAt: now });
  }
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ownerSub: owner,
        itemKey: MCP_CONFIG_KEY,
        configJson,
        serverCount: validation.serverCount,
        enabledCount: validation.enabledCount,
        updatedAt: now,
      },
    })
  );
  return response(200, {
    configJson,
    serverCount: validation.serverCount,
    enabledCount: validation.enabledCount,
    updatedAt: now,
  });
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  try {
    const method = event.requestContext.http.method;
    if (method === "GET" && event.rawPath === "/mcp/config") return await getConfig(event);
    if (method === "POST" && event.rawPath === "/mcp/config") return await saveConfig(event);
    return response(404, { error: "mcp route not found" });
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_IDENTITY") {
      return response(401, { error: "authenticated subject is required" });
    }
    console.error("mcp API failed", error);
    return response(500, { error: "mcp configuration operation failed" });
  }
};
