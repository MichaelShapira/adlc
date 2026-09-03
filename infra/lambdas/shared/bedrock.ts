import {
  BedrockRuntimeClient,
  ContentBlock,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({ maxAttempts: 1 });
const MAX_ATTEMPTS = 3;
const MIN_REMAINING_TIME_MS = 1_500;

/** USD per million tokens, by inference profile / model id substring. */
const PRICING: Array<{ match: string; inPerM: number; outPerM: number }> = [
  { match: "claude-haiku-4-5", inPerM: 1.0, outPerM: 5.0 },
  { match: "claude-sonnet-4-5", inPerM: 3.0, outPerM: 15.0 },
  { match: "claude-sonnet-4", inPerM: 3.0, outPerM: 15.0 },
  { match: "claude-opus", inPerM: 15.0, outPerM: 75.0 },
  { match: "nova-pro", inPerM: 0.8, outPerM: 3.2 },
  { match: "nova-lite", inPerM: 0.06, outPerM: 0.24 },
];

export function costOf(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const p = PRICING.find((x) => modelId.includes(x.match));
  if (!p) return 0;
  return (inputTokens * p.inPerM + outputTokens * p.outPerM) / 1_000_000;
}

export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface BedrockInvokeOptions {
  getRemainingTimeInMillis?: () => number;
}

export type BedrockErrorCode =
  | "BEDROCK_TRANSIENT"
  | "BEDROCK_ACCESS_DENIED"
  | "BEDROCK_MODEL_NOT_FOUND"
  | "BEDROCK_INVALID_REQUEST"
  | "BEDROCK_INVALID_RESPONSE"
  | "BEDROCK_REQUEST_FAILED";

export class BedrockInvocationError extends Error {
  readonly code: BedrockErrorCode;
  readonly retryable: boolean;

  constructor(code: BedrockErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = code;
    this.code = code;
    this.retryable = retryable;
  }
}

type ClassifiedError = {
  code: BedrockErrorCode;
  retryable: boolean;
  message: string;
};

function errorRecord(error: unknown): Record<string, unknown> {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)
    : {};
}

function sanitizeMessage(value: unknown): string {
  const message = typeof value === "string" ? value : "Bedrock request failed";
  return message
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/arn:(?:aws[a-zA-Z-]*)?:[^\s,;]+/g, "[resource]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(?:request[\s_-]*id|x-amzn-requestid)\s*[:=]\s*[^\s,;]+/gi, "requestId=[redacted]")
    .replace(/\b(?:access[_-]?key|api[_-]?key|secret(?:[_-]?access)?[_-]?key|secret|session[_-]?token|task[_-]?token|token|authorization|credential|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300) || "Bedrock request failed";
}

function classifyBedrockError(error: unknown): ClassifiedError {
  const record = errorRecord(error);
  const metadata = errorRecord(record.$metadata);
  const name = typeof record.name === "string" ? record.name : "";
  const status = typeof metadata.httpStatusCode === "number"
    ? metadata.httpStatusCode
    : undefined;
  const message = sanitizeMessage(record.message);

  if (name === "AccessDeniedException") {
    return { code: "BEDROCK_ACCESS_DENIED", retryable: false, message };
  }
  if (name === "ResourceNotFoundException") {
    return { code: "BEDROCK_MODEL_NOT_FOUND", retryable: false, message };
  }
  if (name === "ValidationException") {
    return { code: "BEDROCK_INVALID_REQUEST", retryable: false, message };
  }
  if (
    name === "ThrottlingException" ||
    name === "ServiceUnavailableException" ||
    name === "InternalServerException" ||
    name === "ModelTimeoutException" ||
    name === "ModelNotReadyException" ||
    status === 429 ||
    (status !== undefined && status >= 500)
  ) {
    return { code: "BEDROCK_TRANSIENT", retryable: true, message };
  }
  return { code: "BEDROCK_REQUEST_FAILED", retryable: false, message };
}

function remainingTime(options?: BedrockInvokeOptions): number {
  const value = options?.getRemainingTimeInMillis?.();
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : Number.POSITIVE_INFINITY;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function invokeModelWithContent(
  modelId: string,
  system: string,
  content: ContentBlock[],
  maxTokens = 2000,
  options?: BedrockInvokeOptions
): Promise<LlmResult> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const available = remainingTime(options);
      if (available <= MIN_REMAINING_TIME_MS) {
        throw new BedrockInvocationError(
          "BEDROCK_TRANSIENT",
          "Bedrock request could not complete before the function timeout",
          true
        );
      }
      const abortAfter = Number.isFinite(available)
        ? Math.max(1, available - 1_000)
        : undefined;
      const res = await client.send(
        new ConverseCommand({
          modelId,
          system: [{ text: system }],
          messages: [{ role: "user", content }],
          inferenceConfig: { maxTokens },
        }),
        abortAfter === undefined
          ? undefined
          : { abortSignal: AbortSignal.timeout(abortAfter) }
      );
      const text =
        res.output?.message?.content
          ?.map((c) => ("text" in c ? c.text : ""))
          .join("") ?? "";
      const inputTokens = res.usage?.inputTokens ?? 0;
      const outputTokens = res.usage?.outputTokens ?? 0;
      return {
        text,
        inputTokens,
        outputTokens,
        costUsd: costOf(modelId, inputTokens, outputTokens),
      };
    } catch (error) {
      if (error instanceof BedrockInvocationError) throw error;
      const classified = classifyBedrockError(error);
      if (!classified.retryable || attempt === MAX_ATTEMPTS) {
        throw new BedrockInvocationError(
          classified.code,
          classified.message,
          classified.retryable
        );
      }
      const backoff = 250 * 2 ** (attempt - 1);
      const delay = Math.min(1_500, backoff + Math.floor(Math.random() * backoff));
      if (remainingTime(options) <= delay + MIN_REMAINING_TIME_MS) {
        throw new BedrockInvocationError(
          "BEDROCK_TRANSIENT",
          "Bedrock request retries were stopped before the function timeout",
          true
        );
      }
      await sleep(delay);
    }
  }
  throw new BedrockInvocationError(
    "BEDROCK_REQUEST_FAILED",
    "Bedrock request failed",
    false
  );
}

export async function invokeModel(
  modelId: string,
  system: string,
  user: string,
  maxTokens = 2000,
  options?: BedrockInvokeOptions
): Promise<LlmResult> {
  return invokeModelWithContent(
    modelId,
    system,
    [{ text: user }],
    maxTokens,
    options
  );
}

/** Parse a JSON object out of an LLM response, tolerating code fences and prose. */
export function parseJsonResponse<T>(text: string): T {
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("missing JSON object");
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    throw new BedrockInvocationError(
      "BEDROCK_INVALID_RESPONSE",
      "Model response did not contain the required JSON object",
      false
    );
  }
}
