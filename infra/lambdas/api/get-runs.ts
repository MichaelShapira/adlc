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
import { response } from "./http";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.RUNS_TABLE!;

/** GET /runs and GET /runs/{runId} — task tokens are never returned. */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const runId = event.pathParameters?.runId;

  if (runId) {
    const res = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { runId } })
    );
    if (!res.Item) return response(404, { error: "run not found" });
    const { taskToken: _omit, ...safe } = res.Item;
    return response(200, safe);
  }

  // PoC-scale listing: small table, scan is acceptable here.
  const res = await ddb.send(
    new ScanCommand({
      TableName: TABLE,
      ProjectionExpression:
        "runId, #s, createdAt, updatedAt, costUsd, startedBy, kiroModel, analysisModel, workflowVersion, selectedMode, triage, report",
      ExpressionAttributeNames: { "#s": "status" },
      Limit: 100,
    })
  );
  const items = (res.Items ?? []).sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt))
  );
  return response(200, { runs: items });
};
