export const ANALYSIS_MODELS = [
  {
    id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    name: "Claude Haiku 4.5",
  },
  {
    id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    name: "Claude Sonnet 4.5",
  },
  {
    id: "us.anthropic.claude-opus-5",
    name: "Claude Opus 5 (advanced)",
  },
] as const;

export const DEFAULT_ANALYSIS_MODEL =
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

export const DEFAULT_TRIAGE_INSTRUCTION = `Classify the fix as SIMPLE when it is estimated to touch fewer than 5 files and does not introduce a new architectural pattern, external dependency, data-model change, or cross-service contract change. Classify it as COMPLEX otherwise. When context is enabled, explicitly consider architecture diagrams, entity-relationship diagrams (ERDs), cross-service contracts, schema constraints, and recorded meeting decisions as evidence. Explain the recommendation against these criteria.`;

export const MAX_TRIAGE_INSTRUCTION_CHARS = 4_000;
export const MAX_ARTIFACT_CHARS = 50_000;

export type ExecutionMode = "SIMPLE" | "COMPLEX";

export function isAllowedAnalysisModel(value: string): boolean {
  return ANALYSIS_MODELS.some((model) => model.id === value);
}

const REQUIRED_SPEC_HEADINGS = [
  "## Requirements",
  "## Design",
  "## Tasks",
  "## Acceptance Criteria",
] as const;

export function hasRequiredComplexSpecHeadings(artifact: string): boolean {
  let previousIndex = -1;
  for (const heading of REQUIRED_SPEC_HEADINGS) {
    const index = artifact.indexOf(heading, previousIndex + 1);
    if (index < 0 || !new RegExp(`^${heading}$`, "m").test(artifact)) return false;
    previousIndex = index;
  }
  return true;
}

export function parseExactJson(text: string, expectedFields: readonly string[]): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("model response must contain one valid JSON object");
  }
  let value: unknown;
  try {
    value = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new Error("model response must contain one valid JSON object");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("model response must be a JSON object");
  }
  const actualFields = Object.keys(value as Record<string, unknown>).sort();
  const requiredFields = [...expectedFields].sort();
  if (
    actualFields.length !== requiredFields.length ||
    actualFields.some((field, index) => field !== requiredFields[index])
  ) {
    throw new Error(`model response fields must be exactly: ${expectedFields.join(", ")}`);
  }
  return value;
}

export function validateArtifact(
  mode: ExecutionMode,
  artifact: string
): string | undefined {
  if (!artifact.trim()) return "artifact is required when executing";
  if (artifact.length > MAX_ARTIFACT_CHARS) {
    return `artifact exceeds ${MAX_ARTIFACT_CHARS} characters`;
  }
  if (mode === "COMPLEX" && !hasRequiredComplexSpecHeadings(artifact)) {
    return "COMPLEX artifact must include ## Requirements, ## Design, ## Tasks, and ## Acceptance Criteria in order";
  }
  return undefined;
}
