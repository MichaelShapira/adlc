import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE = process.env.RUNS_TABLE ?? "";

export interface RunEvent {
  ts: string;
  phase: string;
  message: string;
  costUsd?: number;
  detail?: Record<string, unknown>;
}

export async function getRun(runId: string): Promise<Record<string, unknown> | undefined> {
  const res = await client.send(
    new GetCommand({ TableName: TABLE, Key: { runId } })
  );
  return res.Item;
}

/** Append a timeline event and accumulate cost on the run record. */
export async function appendEvent(
  runId: string,
  phase: string,
  message: string,
  costUsd?: number,
  detail?: Record<string, unknown>
): Promise<void> {
  const measuredCost =
    typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0
      ? costUsd
      : undefined;
  const event: RunEvent = {
    ts: new Date().toISOString(),
    phase,
    message,
    ...(measuredCost !== undefined ? { costUsd: measuredCost } : {}),
    ...(detail ? { detail } : {}),
  };
  await client.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { runId },
      UpdateExpression:
        "SET events = list_append(if_not_exists(events, :empty), :e), updatedAt = :now " +
        "ADD costUsd :c",
      ExpressionAttributeValues: {
        ":e": [event],
        ":empty": [],
        ":now": new Date().toISOString(),
        ":c": measuredCost ?? 0,
      },
    })
  );
}

/** Set arbitrary top-level fields on the run record. */
export async function updateRun(
  runId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ":now": new Date().toISOString() };
  const sets: string[] = ["updatedAt = :now"];
  Object.entries(fields).forEach(([k, v], i) => {
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    sets.push(`#f${i} = :v${i}`);
  });
  await client.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { runId },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}

/** Remove a top-level field (e.g. the task token once consumed). */
export async function removeField(runId: string, field: string): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { runId },
      UpdateExpression: "REMOVE #f SET updatedAt = :now",
      ExpressionAttributeNames: { "#f": field },
      ExpressionAttributeValues: { ":now": new Date().toISOString() },
    })
  );
}

/** Atomically increment a numeric counter field, returning the new value. */
export async function incrementCounter(
  runId: string,
  field: string
): Promise<number> {
  const res = await client.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { runId },
      UpdateExpression: "ADD #f :one SET updatedAt = :now",
      ExpressionAttributeNames: { "#f": field },
      ExpressionAttributeValues: { ":one": 1, ":now": new Date().toISOString() },
      ReturnValues: "UPDATED_NEW",
    })
  );
  return Number(res.Attributes?.[field] ?? 0);
}
