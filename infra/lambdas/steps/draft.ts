import type { Context } from "aws-lambda";
import { appendEvent, incrementCounter, updateRun } from "../shared/db";
import { BedrockInvocationError, invokeModel } from "../shared/bedrock";
import { getRepoSnapshot, snapshotToPrompt } from "../shared/codecommit";
import {
  DEFAULT_ANALYSIS_MODEL,
  hasRequiredComplexSpecHeadings,
  isAllowedAnalysisModel,
  MAX_ARTIFACT_CHARS,
  parseExactJson,
} from "../shared/workflow";

const REPO_NAME = process.env.REPO_NAME!;
const BASE_BRANCH = process.env.BASE_BRANCH ?? "main";

interface DraftMetadata {
  rootCause: string;
  proposedFix: string;
  filesToChange: string[];
  risks: string;
  simplePrompt: string;
}

interface Draft extends DraftMetadata {
  complexSpec: string;
  draftAttempt: number;
}

const METADATA_SYSTEM = `Respond ONLY with one JSON object matching this schema:
{
  "rootCause": "<nonempty bounded string>",
  "proposedFix": "<nonempty bounded string>",
  "filesToChange": ["<relative repository path>", ...],
  "risks": "<nonempty bounded string>",
  "simplePrompt": "<complete concise imperative implementation prompt>"
}
Do not include Markdown fences, commentary, or fields outside the JSON object.`;

const SPEC_SYSTEM = `Produce ONLY a complete Markdown implementation specification. Do not wrap it in a JSON object. Do not add commentary before or after it.
It must contain these headings in this exact order:
## Requirements
## Design
## Tasks
## Acceptance Criteria
Under ## Tasks, use ordered Markdown checkboxes. Keep the plan scoped to the supplied bug and repository.`;

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${field} must be a nonempty string of at most ${max} characters`);
  }
  return value.trim();
}

function validateMetadata(value: unknown): DraftMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata response must be a JSON object");
  }
  const result = value as Record<string, unknown>;
  if (
    !Array.isArray(result.filesToChange) ||
    result.filesToChange.length === 0 ||
    result.filesToChange.length > 100
  ) {
    throw new Error("filesToChange must contain between 1 and 100 paths");
  }
  return {
    rootCause: boundedString(result.rootCause, "rootCause", 5000),
    proposedFix: boundedString(result.proposedFix, "proposedFix", 5000),
    filesToChange: result.filesToChange.map((path, index) =>
      boundedString(path, `filesToChange[${index}]`, 300)
    ),
    risks: boundedString(result.risks, "risks", 3000),
    simplePrompt: boundedString(result.simplePrompt, "simplePrompt", MAX_ARTIFACT_CHARS),
  };
}

function normalizeSpec(value: string): string {
  const fenced = value.trim().match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/i);
  const spec = (fenced?.[1] ?? value).trim();
  if (!spec || spec.length > MAX_ARTIFACT_CHARS) {
    throw new Error(`complexSpec must be between 1 and ${MAX_ARTIFACT_CHARS} characters`);
  }
  if (!hasRequiredComplexSpecHeadings(spec)) {
    throw new Error(
      "complexSpec is missing required Requirements, Design, Tasks, or Acceptance Criteria headings"
    );
  }
  return spec;
}

function invalidResponse(message: string): BedrockInvocationError {
  return new BedrockInvocationError(
    "BEDROCK_INVALID_RESPONSE",
    `Model response did not match the draft schema: ${message}`.slice(0, 300),
    false
  );
}

export const handler = async (
  event: {
    runId: string;
    bugText: string;
    analysisModel?: string;
    triage?: { complexity?: string; reasoning?: string };
  },
  context: Context
): Promise<Draft> => {
  const { runId, bugText } = event;
  const analysisModel = event.analysisModel ?? DEFAULT_ANALYSIS_MODEL;
  if (!isAllowedAnalysisModel(analysisModel)) {
    throw new Error("analysisModel is not in the supported allowlist");
  }

  const attempt = await incrementCounter(runId, "draftAttempts");
  await updateRun(runId, { status: "DRAFTING" });
  await appendEvent(
    runId,
    "DRAFT",
    `Generating Simple prompt and Complex specification (attempt ${attempt})`
  );

  const snapshot = await getRepoSnapshot(REPO_NAME, BASE_BRANCH);
  const recommendation = event.triage
    ? `${event.triage.complexity ?? "UNKNOWN"}: ${event.triage.reasoning ?? ""}`
    : "UNKNOWN";
  const repository = snapshotToPrompt(snapshot);
  const baseUser = `Bug report:
---
${bugText}
---

Complexity recommendation (advisory only): ${recommendation}

Repository snapshot (branch ${BASE_BRANCH}):

${repository}`;
  const remaining = () => context.getRemainingTimeInMillis();

  const metadataResult = await invokeModel(
    analysisModel,
    METADATA_SYSTEM,
    `${baseUser}\n\nAnalyze the bug and produce the compact analysis plus Simple/Vibe implementation prompt.`,
    3000,
    { getRemainingTimeInMillis: remaining }
  );

  let metadata: DraftMetadata;
  try {
    metadata = validateMetadata(
      parseExactJson(metadataResult.text, [
        "rootCause",
        "proposedFix",
        "filesToChange",
        "risks",
        "simplePrompt",
      ])
    );
  } catch (error) {
    throw invalidResponse(error instanceof Error ? error.message : "invalid metadata response");
  }

  const specResult = await invokeModel(
    analysisModel,
    SPEC_SYSTEM,
    `${baseUser}

Approved analysis inputs for planning:
- Root cause: ${metadata.rootCause}
- Proposed fix: ${metadata.proposedFix}
- Files: ${metadata.filesToChange.join(", ")}
- Risks: ${metadata.risks}

Create the detailed Complex/Spec artifact now.`,
    6000,
    { getRemainingTimeInMillis: remaining }
  );

  let complexSpec: string;
  try {
    complexSpec = normalizeSpec(specResult.text);
  } catch (error) {
    throw invalidResponse(error instanceof Error ? error.message : "invalid specification response");
  }

  const draft: Draft = { ...metadata, complexSpec, draftAttempt: attempt };
  const inputTokens = metadataResult.inputTokens + specResult.inputTokens;
  const outputTokens = metadataResult.outputTokens + specResult.outputTokens;
  const costUsd = metadataResult.costUsd + specResult.costUsd;

  await updateRun(runId, { draft });
  await appendEvent(
    runId,
    "DRAFT",
    `Both execution artifacts are ready (attempt ${attempt}): ${draft.proposedFix.slice(0, 160)}`,
    costUsd,
    {
      model: analysisModel,
      calls: 2,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd,
    }
  );
  return draft;
};
