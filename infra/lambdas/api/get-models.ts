import { randomUUID } from "node:crypto";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  ANALYSIS_MODELS,
  DEFAULT_ANALYSIS_MODEL,
  DEFAULT_TRIAGE_INSTRUCTION,
} from "../shared/workflow";
import { response } from "./http";

const client = new BedrockAgentCoreClient({});
const RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN!;

interface ModelOption {
  id: string;
  name: string;
}

interface ModelsResult {
  kiroConfigured: boolean;
  models: ModelOption[];
  error?: string;
}

/** List the models available to the Kiro API key used by AgentCore. */
export const handler = async (
  _event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  try {
    const res = await client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: RUNTIME_ARN,
        qualifier: "DEFAULT",
        runtimeSessionId: `models-${randomUUID()}-session`,
        contentType: "application/json",
        accept: "application/json",
        payload: Buffer.from(JSON.stringify({ action: "listModels" })),
      })
    );
    const bodyText = res.response
      ? Buffer.from(await res.response.transformToByteArray()).toString("utf-8")
      : "{}";
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const result =
      parsed && typeof parsed === "object" && "result" in parsed
        ? (parsed.result as ModelsResult)
        : (parsed as unknown as ModelsResult);
    return response(200, {
      ...result,
      analysisModels: ANALYSIS_MODELS,
      defaultAnalysisModel: DEFAULT_ANALYSIS_MODEL,
      defaultTriageInstruction: DEFAULT_TRIAGE_INSTRUCTION,
    });
  } catch (error) {
    console.error("model discovery failed", error);
    return response(200, {
      kiroConfigured: false,
      models: [],
      analysisModels: ANALYSIS_MODELS,
      defaultAnalysisModel: DEFAULT_ANALYSIS_MODEL,
      defaultTriageInstruction: DEFAULT_TRIAGE_INSTRUCTION,
      error: "Kiro model discovery is temporarily unavailable",
    });
  }
};
