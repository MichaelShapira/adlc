import type { Context } from "aws-lambda";
import { appendEvent, updateRun } from "../shared/db";
import { BedrockInvocationError, invokeModel, parseJsonResponse } from "../shared/bedrock";
import { getBranchDiff, snapshotToPrompt } from "../shared/codecommit";
import {
  type ExecutionMode,
  validateArtifact,
} from "../shared/workflow";

const MODEL_ID = process.env.VALIDATE_MODEL_ID!;
const REPO_NAME = process.env.REPO_NAME!;
const BASE_BRANCH = process.env.BASE_BRANCH ?? "main";

interface Validation {
  pass: boolean;
  checks: Array<{ requirement: string; pass: boolean; note: string }>;
  issues: string[];
  fixAttempts: number;
}

const SYSTEM = `You are the INDEPENDENT validation agent in an Agentic SDLC bug-fix pipeline. You did not write this code change. Validate it strictly against the frozen human-approved execution artifact. A change passes only if it fully addresses that artifact and the reported bug, its build passed, it introduces no obvious defect or security issue, and it stays in scope.

Respond ONLY with JSON:
{
  "pass": true | false,
  "checks": [{"requirement": "<short name>", "pass": true|false, "note": "<why>"}],
  "issues": ["<actionable finding for the coding agent to fix>", ...]
}
"issues" must be empty when pass is true.`;

export const handler = async (event: {
  runId: string;
  bugText: string;
  executionMode: ExecutionMode;
  approvedArtifact: string;
  implementResult: {
    fixBranch: string;
    baseCommitId: string;
    fixCommitId?: string;
    buildOk: boolean;
    buildOutput: string;
    summary: string;
    attempt: number;
    ok: boolean;
    error?: string;
  };
}, context: Context): Promise<Validation> => {
  const { runId, bugText, executionMode, approvedArtifact, implementResult } = event;
  if (executionMode !== "SIMPLE" && executionMode !== "COMPLEX") {
    throw new Error("executionMode must be SIMPLE or COMPLEX");
  }
  const artifactError = validateArtifact(executionMode, approvedArtifact);
  if (artifactError) throw new Error(artifactError);

  await updateRun(runId, { status: "VALIDATING" });
  await appendEvent(
    runId,
    "VALIDATE",
    `Independent validation of branch ${implementResult.fixBranch} against the frozen ${executionMode} artifact`
  );

  if (!implementResult.ok) {
    const validation: Validation = {
      pass: false,
      checks: [
        {
          requirement: "Implementation completed",
          pass: false,
          note: implementResult.error ?? "agent reported failure",
        },
      ],
      issues: [
        `The implementation step failed: ${implementResult.error ?? implementResult.summary}. Retry the fix.`,
      ],
      fixAttempts: implementResult.attempt,
    };
    await updateRun(runId, { validation });
    await appendEvent(runId, "VALIDATE", "Validation FAILED: implementation step did not complete");
    return validation;
  }

  if (!implementResult.buildOk) {
    const validation: Validation = {
      pass: false,
      checks: [
        {
          requirement: "Build verification",
          pass: false,
          note: "The implementation build did not pass; validation cannot be green.",
        },
      ],
      issues: [
        `The build failed. Fix the compilation/test failure before validation can pass. Build output: ${implementResult.buildOutput?.slice(-800) ?? "(none)"}`,
      ],
      fixAttempts: implementResult.attempt,
    };
    await updateRun(runId, { validation });
    await appendEvent(runId, "VALIDATE", "Validation FAILED: implementation build did not pass");
    return validation;
  }

  const beforeRef = implementResult.baseCommitId || BASE_BRANCH;
  const afterRef = implementResult.fixCommitId || implementResult.fixBranch;
  const diff = await getBranchDiff(REPO_NAME, beforeRef, afterRef);
  const user = `Original bug report:
---
${bugText}
---

Frozen human-approved execution mode: ${executionMode}
Frozen human-approved artifact:
<approved-artifact>
${approvedArtifact}
</approved-artifact>

Implementation summary from the coding agent: ${implementResult.summary}
Build verification reported by the agent: ${implementResult.buildOk ? "PASSED" : "FAILED"}
Build output (tail):
${implementResult.buildOutput?.slice(-1500) ?? "(none)"}

Changed files: ${diff.changedFiles.join(", ") || "(none detected)"}

Full "after" contents of changed files on ${implementResult.fixBranch}:

${snapshotToPrompt(diff.afterContents)}

Validate the change against the frozen artifact. Respond with the JSON object only.`;

  const res = await invokeModel(MODEL_ID, SYSTEM, user, 1500, {
    getRemainingTimeInMillis: () => context.getRemainingTimeInMillis(),
  });
  let parsed: Omit<Validation, "fixAttempts">;
  try {
    parsed = parseJsonResponse<Omit<Validation, "fixAttempts">>(res.text);
    if (typeof parsed.pass !== "boolean" || !Array.isArray(parsed.checks) || !Array.isArray(parsed.issues)) {
      throw new Error("invalid schema");
    }
  } catch {
    throw new BedrockInvocationError(
      "BEDROCK_INVALID_RESPONSE",
      "Model response did not match the validation schema",
      false
    );
  }
  const validation: Validation = {
    ...parsed,
    fixAttempts: implementResult.attempt,
  };

  await updateRun(runId, { validation });
  await appendEvent(
    runId,
    "VALIDATE",
    validation.pass
      ? `Validation PASSED: all ${validation.checks.length} checks green`
      : `Validation FAILED: ${validation.issues.length} finding(s) — ${validation.issues[0]?.slice(0, 150) ?? ""}`,
    res.costUsd,
    {
      model: MODEL_ID,
      executionMode,
      checks: validation.checks,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      totalTokens: res.inputTokens + res.outputTokens,
      costUsd: res.costUsd,
    }
  );
  return validation;
};
