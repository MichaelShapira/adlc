import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { CodeCommitClient, GetBranchCommand } from "@aws-sdk/client-codecommit";
import { appendEvent, getRun, incrementCounter, updateRun } from "../shared/db";
import {
  type ExecutionMode,
  validateArtifact,
} from "../shared/workflow";
import {
  acquireImplementationLease,
  releaseImplementationLease,
} from "../shared/repo-control";

const client = new BedrockAgentCoreClient({});
const codecommit = new CodeCommitClient({});
const RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN!;
const REPO_NAME = process.env.REPO_NAME!;
const BASE_BRANCH = process.env.BASE_BRANCH ?? "main";

type UsageStatus = "COMPLETE" | "PARTIAL" | "UNAVAILABLE" | "NOT_APPLICABLE";

export interface ImplementResult {
  ok: boolean;
  engine: string;
  requestedModel: string;
  actualModel: string;
  executionMode: ExecutionMode;
  summary: string;
  filesChanged: string[];
  buildOk: boolean;
  buildOutput: string;
  fixBranch: string;
  baseCommitId: string;
  fixCommitId?: string;
  costUsd: number;
  attempt: number;
  kiroCredits: number | null;
  kiroCreditsStatus: UsageStatus;
  requestedRuntimeSessionId: string;
  returnedRuntimeSessionId?: string;
  traceId?: string;
  cpuSeconds?: number | null;
  peakMemoryBytes?: number | null;
  usageStartTimestamp?: string;
  usageEndTimestamp?: string;
  agentCoreUsageStatus?: UsageStatus;
  agentCoreUsageSource?: string;
  error?: string;
}

export const handler = async (event: {
  runId: string;
  bugText: string;
  kiroModel?: string;
  executionMode?: ExecutionMode;
  approvedArtifact?: string;
  validation?: { issues?: string[] };
}): Promise<ImplementResult> => {
  const { runId, bugText } = event;
  const kiroModel = event.kiroModel ?? "auto";
  const executionMode = event.executionMode ?? "SIMPLE";
  const approvedArtifact = event.approvedArtifact ?? "";
  if (executionMode !== "SIMPLE" && executionMode !== "COMPLEX") {
    throw new Error("executionMode must be SIMPLE or COMPLEX");
  }
  const artifactError = validateArtifact(executionMode, approvedArtifact);
  if (artifactError) throw new Error(artifactError);

  const attempt = await incrementCounter(runId, "fixAttempts");
  const runtimeSessionId = `${runId}-implement-${String(attempt).padStart(3, "0")}-session`;
  const fixBranch = `fix/${runId}`;
  const existingRun = await getRun(runId);
  const mcpConfig =
    typeof existingRun?.mcpConfig === "string" ? existingRun.mcpConfig : "";
  let baseCommitId = String(existingRun?.baseCommitId ?? "");
  if (!baseCommitId) {
    const branch = await codecommit.send(
      new GetBranchCommand({ repositoryName: REPO_NAME, branchName: BASE_BRANCH })
    );
    baseCommitId = branch.branch?.commitId ?? "";
    if (!baseCommitId) throw new Error("could not resolve the base commit");
  }

  await updateRun(runId, {
    status: "IMPLEMENTING",
    fixBranch,
    baseCommitId,
    executionMode,
    approvedArtifact,
  });
  await appendEvent(
    runId,
    "IMPLEMENT",
    attempt === 1
      ? `Coding agent implementing the approved ${executionMode} artifact (requested Kiro model: ${kiroModel})`
      : `Fix loop iteration ${attempt}: coding agent addressing validation findings using the frozen ${executionMode} artifact`
  );

  await acquireImplementationLease(fixBranch);
  let result: ImplementResult;
  try {
    const payload = {
      action: "implement",
      runId,
      repoName: REPO_NAME,
      baseBranch: BASE_BRANCH,
      baseCommitId,
      fixBranch,
      bugText,
      kiroModel,
      mode: executionMode,
      artifact: approvedArtifact,
      validationIssues: event.validation?.issues ?? [],
      attempt,
      runtimeSessionId,
      mcpConfig,
    };

    const res = await client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: RUNTIME_ARN,
        qualifier: "DEFAULT",
        runtimeSessionId,
        contentType: "application/json",
        accept: "application/json",
        payload: Buffer.from(JSON.stringify(payload)),
      })
    );

    const bodyText = res.response
      ? Buffer.from(await res.response.transformToByteArray()).toString("utf-8")
      : "{}";

    try {
      const parsed: unknown = JSON.parse(bodyText);
      const inner =
        typeof parsed === "object" && parsed !== null && "result" in parsed
          ? (parsed as { result: unknown }).result
          : parsed;
      const agentResult = inner as ImplementResult;
      result = {
        ...agentResult,
        baseCommitId,
        fixBranch,
        attempt,
        executionMode,
        kiroCredits:
          typeof agentResult.kiroCredits === "number"
            ? agentResult.kiroCredits
            : null,
        kiroCreditsStatus:
          agentResult.kiroCreditsStatus ?? "UNAVAILABLE",
        requestedRuntimeSessionId: runtimeSessionId,
        ...(res.runtimeSessionId
          ? { returnedRuntimeSessionId: res.runtimeSessionId }
          : {}),
        ...(res.traceId ? { traceId: res.traceId } : {}),
      };
    } catch {
      result = {
        ok: false,
        engine: "unknown",
        requestedModel: kiroModel,
        actualModel: "unknown",
        executionMode,
        summary: `Agent returned a non-JSON response (${bodyText.length} bytes)`,
        filesChanged: [],
        buildOk: false,
        buildOutput: "",
        fixBranch,
        baseCommitId,
        costUsd: 0,
        attempt,
        kiroCredits: null,
        kiroCreditsStatus: "UNAVAILABLE",
        requestedRuntimeSessionId: runtimeSessionId,
        ...(res.runtimeSessionId
          ? { returnedRuntimeSessionId: res.runtimeSessionId }
          : {}),
        ...(res.traceId ? { traceId: res.traceId } : {}),
        error: "invalid-agent-response",
      };
    }
  } finally {
    await releaseImplementationLease(fixBranch);
  }

  await appendEvent(
    runId,
    "IMPLEMENT",
    result.ok
      ? `Fix implemented via ${result.engine} in ${executionMode} mode: ${result.summary.slice(0, 200)} (build ${result.buildOk ? "PASSED" : "FAILED"})`
      : `Implementation attempt failed: ${result.error ?? result.summary}`,
    result.costUsd || 0,
    {
      engine: result.engine,
      executionMode,
      requestedModel: result.requestedModel,
      actualModel: result.actualModel,
      filesChanged: result.filesChanged,
      baseCommitId,
      fixCommitId: result.fixCommitId,
      attempt,
      kiroCredits: result.kiroCredits,
      kiroCreditsStatus: result.kiroCreditsStatus,
      cpuSeconds: result.cpuSeconds,
      peakMemoryBytes: result.peakMemoryBytes,
      agentCoreUsageStatus: result.agentCoreUsageStatus,
      agentCoreUsageSource: result.agentCoreUsageSource,
      requestedRuntimeSessionId: result.requestedRuntimeSessionId,
      returnedRuntimeSessionId: result.returnedRuntimeSessionId,
      traceId: result.traceId,
    }
  );
  await updateRun(runId, {
    implementResult: result,
    baseCommitId,
    executionMode,
    ...(result.fixCommitId ? { fixCommitId: result.fixCommitId } : {}),
  });
  return result;
};
