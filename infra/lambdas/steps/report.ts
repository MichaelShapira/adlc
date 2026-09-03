import { appendEvent, getRun, updateRun } from "../shared/db";

type Mode =
  | "success"
  | "complex"
  | "needsHuman"
  | "rejected"
  | "cancelled"
  | "failed";

type UsageStatus = "COMPLETE" | "PARTIAL" | "UNAVAILABLE" | "NOT_APPLICABLE";

type TimelineEvent = {
  phase?: unknown;
  costUsd?: unknown;
  detail?: unknown;
};

type UsageAttempt = {
  attempt?: unknown;
  runtimeSessionId?: unknown;
  cpuSeconds?: unknown;
  peakMemoryBytes?: unknown;
  startTimestamp?: unknown;
  endTimestamp?: unknown;
  status?: unknown;
  source?: unknown;
  kiroCredits?: unknown;
  kiroCreditsStatus?: unknown;
  kiroCostUsd?: unknown;
};

const STATUS_BY_MODE: Record<Mode, string> = {
  success: "COMPLETED",
  complex: "COMPLEX_DECISION",
  needsHuman: "NEEDS_HUMAN",
  rejected: "REJECTED",
  cancelled: "CANCELLED",
  failed: "FAILED",
};

const HEADLINE_BY_MODE: Record<Mode, string> = {
  success: "Fix implemented, validated, and pushed. Run complete.",
  complex:
    "Triage classified this bug as COMPLEX. Per PoC scope, the Complex path is recorded as a decision outcome without execution.",
  needsHuman:
    "Maximum fix/re-validate cycles reached without a green validation. The run is handed back to a human.",
  rejected:
    "The reviewer rejected the draft the maximum number of times. Run closed without code changes.",
  cancelled: "The run was cancelled at the execution gate. No implementation was started.",
  failed: "The run failed with an unrecoverable error.",
};

const AGENTCORE_USAGE_SOURCE = "cgroup-v2 usage log";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function positiveInteger(value: unknown): number | null {
  const number = nonNegativeNumber(value);
  return number !== null && Number.isInteger(number) && number > 0
    ? number
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null;
}

function round(value: number | null, places = 6): number | null {
  if (value === null) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function usageStatus(value: unknown): UsageStatus | null {
  return value === "COMPLETE" ||
    value === "PARTIAL" ||
    value === "UNAVAILABLE" ||
    value === "NOT_APPLICABLE"
    ? value
    : null;
}

type FailureDetail = {
  stage: string;
  code: string;
  message: string;
  retryable: boolean;
};

const TRANSIENT_FAILURE_CODES = new Set([
  "BEDROCK_TRANSIENT",
  "Lambda.ServiceException",
  "Lambda.AWSLambdaException",
  "Lambda.SdkClientException",
  "Lambda.TooManyRequestsException",
]);

function sanitizeFailureText(value: unknown, fallback: string, max: number): string {
  const text = typeof value === "string" ? value : fallback;
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/arn:(?:aws[a-zA-Z-]*)?:[^\s,;\]}]+/g, "[resource]")
    .replace(/\bBearer\s+[^\s,;\]}]+/gi, "Bearer [redacted]")
    .replace(/\b(?:request[\s_-]*id|x-amzn-requestid)\s*[:=]\s*[^\s,;\]}]+/gi, "requestId=[redacted]")
    .replace(/\b(?:access[_-]?key|api[_-]?key|secret(?:[_-]?access)?[_-]?key|secret|session[_-]?token|task[_-]?token|token|authorization|credential|password)\s*[:=]\s*[^\s,;\]}]+/gi, "$1=[redacted]")
    .replace(/\s+at\s+(?:async\s+)?[^\s]+\s*\([^)]*\)(?:\s+at\s+.*)?$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max) || fallback;
}

function safeFailureCode(value: unknown): string {
  const code = sanitizeFailureText(value, "WORKFLOW_FAILED", 100);
  return /^[A-Za-z0-9_.-]+$/.test(code) ? code : "WORKFLOW_FAILED";
}

function parseFailure(
  error: { Error?: unknown; Cause?: unknown } | undefined,
  failureStage: unknown
): FailureDetail | null {
  if (!error) return null;
  const stage = sanitizeFailureText(failureStage, "UNKNOWN", 32).toUpperCase();
  let cause: Record<string, unknown> | null = null;
  if (typeof error.Cause === "string") {
    try {
      cause = asRecord(JSON.parse(error.Cause));
    } catch {
      cause = null;
    }
  } else {
    cause = asRecord(error.Cause);
  }
  const code = safeFailureCode(
    cause?.code ?? cause?.errorType ?? cause?.name ?? error.Error
  );
  const message = cause
    ? sanitizeFailureText(
        cause.errorMessage ?? cause.message,
        "The workflow failed without an available error message.",
        400
      )
    : "The workflow failed without a safely readable error message.";
  const retryable =
    typeof cause?.retryable === "boolean"
      ? cause.retryable
      : TRANSIENT_FAILURE_CODES.has(code);
  return { stage, code, message, retryable };
}

/**
 * Final step: compute the completion report — total time, cost consumed,
 * and tasks completed during the run.
 */
export const handler = async (event: {
  runId: string;
  mode: Mode;
  error?: { Error?: unknown; Cause?: unknown };
  failureStage?: unknown;
}): Promise<Record<string, unknown>> => {
  const { runId, mode } = event;
  const run = (await getRun(runId)) ?? {};
  const failure = parseFailure(event.error, event.failureStage);

  const createdAt = stringValue(run.createdAt);
  const createdAtMillis = createdAt ? new Date(createdAt).getTime() : Number.NaN;
  const totalSeconds = Number.isFinite(createdAtMillis)
    ? Math.max(0, Math.round((Date.now() - createdAtMillis) / 1000))
    : 0;
  const events = (Array.isArray(run.events) ? run.events : []) as TimelineEvent[];
  const phasesCompleted = [
    ...new Set(
      events
        .map((item) => stringValue(item.phase))
        .filter((phase): phase is string => phase !== null)
    ),
  ];

  const analysisModel = stringValue(run.analysisModel);
  const analysisEvents = events.filter((item) => {
    const detail = asRecord(item.detail);
    return (
      (item.phase === "TRIAGE" || item.phase === "DRAFT") &&
      analysisModel !== null &&
      detail?.model === analysisModel
    );
  });
  const analysisInputTokens = analysisEvents.map((item) =>
    nonNegativeNumber(asRecord(item.detail)?.inputTokens)
  );
  const analysisOutputTokens = analysisEvents.map((item) =>
    nonNegativeNumber(asRecord(item.detail)?.outputTokens)
  );
  const analysisTotalTokens = analysisEvents.map((item, index) => {
    const reported = nonNegativeNumber(asRecord(item.detail)?.totalTokens);
    if (reported !== null) return reported;
    const input = analysisInputTokens[index];
    const output = analysisOutputTokens[index];
    return input !== null && output !== null ? input + output : null;
  });
  const analysisCosts = analysisEvents.map((item) =>
    nonNegativeNumber(item.costUsd)
  );
  const analysisCalls = analysisEvents.reduce((sum, item) => {
    const reportedCalls = nonNegativeNumber(asRecord(item.detail)?.calls);
    return sum + (reportedCalls ?? 1);
  }, 0);
  const analysisComplete =
    analysisEvents.length > 0 &&
    analysisEvents.every(
      (_item, index) =>
        analysisInputTokens[index] !== null &&
        analysisOutputTokens[index] !== null &&
        analysisTotalTokens[index] !== null &&
        analysisCosts[index] !== null
    );
  const analysisStatus: UsageStatus =
    analysisEvents.length === 0
      ? "UNAVAILABLE"
      : analysisComplete
        ? "COMPLETE"
        : "PARTIAL";

  const rawUsageAttempts = (
    Array.isArray(run.agentCoreUsageAttempts) ? run.agentCoreUsageAttempts : []
  ) as UsageAttempt[];
  const attemptsByNumber = new Map<number, UsageAttempt>();
  for (const usageAttempt of rawUsageAttempts) {
    const attempt = positiveInteger(usageAttempt.attempt);
    if (attempt !== null) attemptsByNumber.set(attempt, usageAttempt);
  }
  const usageAttempts = [...attemptsByNumber.entries()]
    .sort(([left], [right]) => left - right)
    .map(([attempt, usageAttempt]) => ({ attempt, usageAttempt }));
  const reportedAttemptCount = Math.floor(nonNegativeNumber(run.fixAttempts) ?? 0);
  const highestRecordedAttempt = usageAttempts.at(-1)?.attempt ?? 0;
  const implementationAttempts = Math.max(
    reportedAttemptCount,
    highestRecordedAttempt
  );
  const recordsCoverAttempts =
    implementationAttempts > 0 &&
    Array.from(
      { length: implementationAttempts },
      (_unused, index) => index + 1
    ).every((attempt) => attemptsByNumber.has(attempt));

  const implementationDetailsByAttempt = new Map<
    number,
    Record<string, unknown>
  >();
  for (const item of events) {
    if (item.phase !== "IMPLEMENT") continue;
    const detail = asRecord(item.detail);
    const attempt = positiveInteger(detail?.attempt);
    if (detail && attempt !== null) {
      implementationDetailsByAttempt.set(attempt, detail);
    }
  }

  const kiroApplicableAttempts = usageAttempts.filter(
    ({ usageAttempt }) =>
      usageStatus(usageAttempt.kiroCreditsStatus) !== "NOT_APPLICABLE"
  );
  const kiroCredits = kiroApplicableAttempts.map(({ usageAttempt }) =>
    nonNegativeNumber(usageAttempt.kiroCredits)
  );
  const kiroCosts = kiroApplicableAttempts.map(({ usageAttempt }) =>
    nonNegativeNumber(usageAttempt.kiroCostUsd)
  );
  const hasKiroValues = kiroCredits.some((value) => value !== null);
  const allKiroValuesAvailable =
    kiroApplicableAttempts.length > 0 &&
    kiroApplicableAttempts.every(
      ({ usageAttempt }, index) =>
        usageStatus(usageAttempt.kiroCreditsStatus) === "COMPLETE" &&
        kiroCredits[index] !== null &&
        kiroCosts[index] !== null
    );
  let kiroStatus: UsageStatus;
  if (implementationAttempts === 0) {
    kiroStatus = "NOT_APPLICABLE";
  } else if (
    recordsCoverAttempts &&
    usageAttempts.length > 0 &&
    kiroApplicableAttempts.length === 0 &&
    usageAttempts.every(
      ({ usageAttempt }) =>
        usageStatus(usageAttempt.kiroCreditsStatus) === "NOT_APPLICABLE"
    )
  ) {
    kiroStatus = "NOT_APPLICABLE";
  } else if (hasKiroValues) {
    kiroStatus =
      recordsCoverAttempts && allKiroValuesAvailable ? "COMPLETE" : "PARTIAL";
  } else {
    kiroStatus = "UNAVAILABLE";
  }

  const cpuValues = usageAttempts.map(({ usageAttempt }) =>
    nonNegativeNumber(usageAttempt.cpuSeconds)
  );
  const memoryValues = usageAttempts.map(({ usageAttempt }) =>
    nonNegativeNumber(usageAttempt.peakMemoryBytes)
  );
  const hasAgentCoreValues = [...cpuValues, ...memoryValues].some(
    (value) => value !== null
  );
  const allAgentCoreValuesAvailable =
    recordsCoverAttempts &&
    usageAttempts.every(
      ({ usageAttempt }, index) =>
        usageStatus(usageAttempt.status) === "COMPLETE" &&
        cpuValues[index] !== null &&
        memoryValues[index] !== null
    );
  const agentCoreStatus: UsageStatus =
    implementationAttempts === 0
      ? "NOT_APPLICABLE"
      : allAgentCoreValuesAvailable
        ? "COMPLETE"
        : hasAgentCoreValues
          ? "PARTIAL"
          : "UNAVAILABLE";
  const peakMemoryBytes =
    memoryValues.filter((value): value is number => value !== null).length > 0
      ? Math.max(
          ...memoryValues.filter((value): value is number => value !== null)
        )
      : null;

  const sessions = usageAttempts.map(({ attempt, usageAttempt }) => {
    const implementationDetail = implementationDetailsByAttempt.get(attempt);
    const runtimeSessionId =
      stringValue(usageAttempt.runtimeSessionId) ??
      stringValue(implementationDetail?.requestedRuntimeSessionId);
    return {
      attempt,
      runtimeSessionId,
      requestedRuntimeSessionId: runtimeSessionId,
      returnedRuntimeSessionId: stringValue(
        implementationDetail?.returnedRuntimeSessionId
      ),
      traceId: stringValue(implementationDetail?.traceId),
      cpuSeconds: nonNegativeNumber(usageAttempt.cpuSeconds),
      peakMemoryBytes: nonNegativeNumber(usageAttempt.peakMemoryBytes),
      startTimestamp: stringValue(usageAttempt.startTimestamp),
      endTimestamp: stringValue(usageAttempt.endTimestamp),
      status: usageStatus(usageAttempt.status) ?? "UNAVAILABLE",
    };
  });

  const report = {
    headline: HEADLINE_BY_MODE[mode],
    totalTimeSeconds: totalSeconds,
    totalCostUsd: Math.round(Number(run.costUsd ?? 0) * 10000) / 10000,
    tasksCompleted: events.length,
    phasesCompleted,
    fixLoops: Number(run.fixAttempts ?? 0),
    draftAttempts: Number(run.draftAttempts ?? 0),
    fixBranch: run.fixBranch ?? null,
    engine:
      (run.implementResult as { engine?: string } | undefined)?.engine ?? null,
    requestedModel:
      (run.implementResult as { requestedModel?: string } | undefined)
        ?.requestedModel ??
      run.kiroModel ??
      null,
    actualModel:
      (run.implementResult as { actualModel?: string } | undefined)?.actualModel ??
      null,
    executionMode:
      (run.implementResult as { executionMode?: string } | undefined)
        ?.executionMode ??
      run.selectedMode ??
      null,
    analysisModel: run.analysisModel ?? null,
    usageBreakdown: {
      analysis: {
        status: analysisStatus,
        modelId: analysisModel,
        calls: analysisCalls,
        inputTokens: round(sumKnown(analysisInputTokens), 0),
        outputTokens: round(sumKnown(analysisOutputTokens), 0),
        totalTokens: round(sumKnown(analysisTotalTokens), 0),
        costUsd: round(sumKnown(analysisCosts)),
      },
      kiro: {
        status: kiroStatus,
        attempts: implementationAttempts,
        credits:
          kiroStatus === "NOT_APPLICABLE"
            ? 0
            : round(sumKnown(kiroCredits)),
        costUsd:
          kiroStatus === "NOT_APPLICABLE" ? 0 : round(sumKnown(kiroCosts)),
      },
      agentCore: {
        status: agentCoreStatus,
        attempts: implementationAttempts,
        cpuSeconds: round(sumKnown(cpuValues)),
        peakMemoryBytes,
        peakMemoryMiB:
          peakMemoryBytes === null
            ? null
            : round(peakMemoryBytes / (1024 * 1024), 2),
        source: AGENTCORE_USAGE_SOURCE,
        sessions,
      },
    },
    ...(failure ? { failure } : {}),
  };

  await updateRun(runId, { status: STATUS_BY_MODE[mode], report });
  const failureMessage = failure
    ? ` Failure at ${failure.stage} (${failure.code}): ${failure.message}${
        failure.retryable ? " Retry may succeed." : " Review the stage inputs and configuration."
      }`
    : "";
  await appendEvent(
    runId,
    "REPORT",
    `${HEADLINE_BY_MODE[mode]}${failureMessage} Time: ${totalSeconds}s, cost: $${report.totalCostUsd}, tasks: ${report.tasksCompleted}, fix loops: ${report.fixLoops}`
  );
  return report;
};
