import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { appendEvent, getRun, removeField, updateRun } from "../shared/db";
import {
  type ExecutionMode,
  MAX_ARTIFACT_CHARS,
  validateArtifact,
} from "../shared/workflow";
import { callerIdentity, response } from "./http";

const sfn = new SFNClient({});
const MAX_FEEDBACK_CHARS = 4_000;

type V2Action = "execute" | "cancel";

interface DecisionBody {
  action?: unknown;
  mode?: unknown;
  artifact?: unknown;
  feedback?: unknown;
  securityRemediation?: unknown;
}

function recommendedMode(run: Record<string, unknown>): ExecutionMode {
  const draft = run.draft as
    | { simplePrompt?: unknown; complexSpec?: unknown }
    | undefined;
  if (run.workflowVersion !== 2 || (!draft?.simplePrompt && !draft?.complexSpec)) {
    return "SIMPLE";
  }
  const complexity = (run.triage as { complexity?: unknown } | undefined)?.complexity;
  return complexity === "COMPLEX" ? "COMPLEX" : "SIMPLE";
}

function draftArtifact(run: Record<string, unknown>, mode: ExecutionMode): string {
  const draft = run.draft as
    | { simplePrompt?: unknown; complexSpec?: unknown; proposedFix?: unknown }
    | undefined;
  const value =
    mode === "COMPLEX"
      ? draft?.complexSpec
      : draft?.simplePrompt ?? draft?.proposedFix;
  return typeof value === "string" ? value : "";
}

/** POST /runs/{runId}/decision — choose and approve a frozen execution artifact. */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const runId = event.pathParameters?.runId;
  if (!runId) return response(400, { error: "runId is required" });

  let body: DecisionBody;
  try {
    const parsed: unknown = JSON.parse(event.body ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return response(400, { error: "JSON body must be an object" });
    }
    body = parsed as DecisionBody;
  } catch {
    return response(400, { error: "invalid JSON body" });
  }

  const feedback = typeof body.feedback === "string" ? body.feedback : "";
  if (feedback.length > MAX_FEEDBACK_CHARS) {
    return response(400, { error: `feedback exceeds ${MAX_FEEDBACK_CHARS} characters` });
  }

  const run = await getRun(runId);
  if (!run) return response(404, { error: "run not found" });
  if (run.status !== "AWAITING_APPROVAL" || !run.taskToken) {
    return response(409, { error: "run is not awaiting an execution decision" });
  }

  let action: V2Action;
  let mode: ExecutionMode;
  let artifact: string;
  if (body.action === "approve" || body.action === "reject") {
    // Compatibility with the original approval client: approve executes the
    // recommended generated artifact; reject closes the run.
    action = body.action === "approve" ? "execute" : "cancel";
    mode = recommendedMode(run);
    artifact = draftArtifact(run, mode);
    if (body.action === "reject" && !feedback.trim()) {
      return response(400, { error: "feedback is required when rejecting" });
    }
  } else {
    if (body.action !== "execute" && body.action !== "cancel") {
      return response(400, { error: "action must be 'execute' or 'cancel'" });
    }
    if (body.mode !== "SIMPLE" && body.mode !== "COMPLEX") {
      return response(400, { error: "mode must be 'SIMPLE' or 'COMPLEX'" });
    }
    action = body.action;
    mode = body.mode;
    artifact = typeof body.artifact === "string" ? body.artifact : "";
  }

  if (action === "execute") {
    const artifactError = validateArtifact(mode, artifact);
    if (artifactError) return response(400, { error: artifactError });
  } else if (artifact.length > MAX_ARTIFACT_CHARS) {
    return response(400, { error: `artifact exceeds ${MAX_ARTIFACT_CHARS} characters` });
  }

  const reviewer = callerIdentity(event);
  const approved = action === "execute";
  const securityRemediation = body.securityRemediation === true;
  const approval = {
    action,
    approved,
    selectedMode: mode,
    selectedArtifact: artifact,
    feedback,
    securityRemediation,
    reviewer: reviewer.email,
    reviewerSub: reviewer.sub,
    decidedAt: new Date().toISOString(),
  };

  await sfn.send(
    new SendTaskSuccessCommand({
      taskToken: String(run.taskToken),
      output: JSON.stringify(approval),
    })
  );

  await removeField(runId, "taskToken");
  await updateRun(runId, {
    approval,
    selectedMode: mode,
    selectedArtifact: artifact,
  });
  await appendEvent(
    runId,
    "GATE",
    approved
      ? `${mode} artifact approved for Kiro execution by ${reviewer.email}${feedback ? ` — "${feedback.slice(0, 200)}"` : ""}`
      : `Run cancelled at the execution gate by ${reviewer.email}${feedback ? ` — "${feedback.slice(0, 200)}"` : ""}`
  );

  return response(200, { ok: true, action, approved, selectedMode: mode });
};
