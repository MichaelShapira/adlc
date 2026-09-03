export interface RunEvent {
  ts?: string;
  phase?: string;
  message?: string;
  costUsd?: number;
  detail?: Record<string, unknown>;
}

export interface RunLog {
  ts?: string;
  level?: "INFO" | "WARN" | "ERROR" | string;
  stage?: string;
  message?: string;
}

export interface ModelOption {
  id: string;
  name: string;
}

export interface McpConfigResponse {
  configJson: string;
  updatedAt?: string;
  serverCount: number;
  enabledCount: number;
  maxBytes?: number;
}
export interface ModelsResponse {
  kiroConfigured: boolean;
  models: ModelOption[];
  analysisModels: ModelOption[];
  defaultAnalysisModel: string;
  defaultTriageInstruction: string;
  error?: string;
}

export type ExecutionMode = "SIMPLE" | "COMPLEX";

export interface StartRunRequest {
  bugText: string;
  kiroModel: string;
  analysisModel: string;
  triageInstruction: string;
  includeContext: boolean;
  autoExecuteSimple: boolean;
}

export interface Draft {
  rootCause: string;
  proposedFix: string;
  filesToChange: string[];
  risks: string;
  simplePrompt: string;
  complexSpec: string;
  draftAttempt: number;
}

export interface Triage {
  complexity: "SIMPLE" | "COMPLEX";
  reasoning: string;
  estimatedFiles: number;
  bugId: string;
  title: string;
}

export interface Validation {
  pass: boolean;
  checks: Array<{ requirement: string; pass: boolean; note: string }>;
  issues: string[];
  fixAttempts: number;
}

export type UsageStatus =
  | "COMPLETE"
  | "PARTIAL"
  | "UNAVAILABLE"
  | "NOT_APPLICABLE";

export interface UsageBreakdown {
  analysis: {
    status: UsageStatus;
    modelId: string | null;
    calls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    costUsd: number | null;
  };
  kiro: {
    status: UsageStatus;
    attempts: number;
    credits: number | null;
    costUsd: number | null;
  };
  agentCore: {
    status: UsageStatus;
    attempts: number;
    cpuSeconds: number | null;
    peakMemoryBytes: number | null;
    peakMemoryMiB: number | null;
    source: "cgroup-v2 usage log";
    sessions: Array<{
      attempt: number;
      runtimeSessionId: string | null;
      requestedRuntimeSessionId: string | null;
      returnedRuntimeSessionId: string | null;
      traceId: string | null;
      cpuSeconds: number | null;
      peakMemoryBytes: number | null;
      startTimestamp: string | null;
      endTimestamp: string | null;
      status: UsageStatus;
    }>;
  };
}

export interface Report {
  headline: string;
  totalTimeSeconds: number;
  totalCostUsd: number;
  tasksCompleted: number;
  fixLoops: number;
  draftAttempts: number;
  fixBranch?: string | null;
  engine?: string | null;
  requestedModel?: string | null;
  actualModel?: string | null;
  executionMode?: ExecutionMode | null;
  analysisModel?: string | null;
  usageBreakdown?: UsageBreakdown;
  failure?: {
    stage?: string;
    code?: string;
    message?: string;
    retryable?: boolean;
  };
}

export interface Run {
  runId?: string;
  status?: string;
  bugText?: string;
  kiroModel?: string;
  analysisModel?: string;
  triageInstruction?: string;
  includeContext?: boolean;
  autoExecuteSimple?: boolean;
  workflowVersion?: number;
  contextAudit?: {
    enabled: boolean;
    itemIds?: string[];
    digests?: string[];
    count: number;
    totalBytes: number;
  };
  selectedMode?: ExecutionMode;
  selectedArtifact?: string;
  createdAt?: string;
  updatedAt?: string;
  costUsd?: number;
  startedBy?: string;
  events?: RunEvent[];
  logs?: RunLog[];
  logCount?: number;
  triage?: Triage;
  draft?: Draft;
  validation?: Validation;
  report?: Report;
  approval?: {
    action?: "execute" | "cancel";
    approved: boolean;
    selectedMode?: ExecutionMode;
    selectedArtifact?: string;
    feedback?: string;
    reviewer?: string;
  };
  implementResult?: {
    engine?: string;
    requestedModel?: string;
    actualModel?: string;
    executionMode?: ExecutionMode;
    summary?: string;
    buildOk?: boolean;
    buildOutput?: string;
    filesChanged?: string[];
    attempt?: number;
    kiroCredits?: number | null;
    kiroCreditsStatus?: UsageStatus;
    requestedRuntimeSessionId?: string;
    returnedRuntimeSessionId?: string;
    traceId?: string;
    cpuSeconds?: number | null;
    peakMemoryBytes?: number | null;
    agentCoreUsageStatus?: UsageStatus;
    agentCoreUsageSource?: string;
    error?: string;
  };
  fixBranch?: string;
}

export interface AppConfig {
  apiUrl: string;
  region: string;
  userPoolId: string;
  userPoolClientId: string;
}

export interface RepositoryRef {
  kind: "base" | "fix";
  name: string;
  commitId: string;
  implementationCommitId?: string;
  label: string;
  runId?: string;
  status?: string;
  validationPass?: boolean;
  completedAt?: string;
}

export interface BugTarget {
  id: string;
  title: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  description: string;
}

export interface RepositoryRefsResponse {
  repositoryName: string;
  refs: RepositoryRef[];
  bugTargets: BugTarget[];
  canDeleteFixBranches: boolean;
}

export interface RepositoryTreeEntry {
  name: string;
  path: string;
  type: "file" | "folder";
  size?: number;
  blobId?: string;
}

export interface RepositoryTreeResponse {
  ref: string;
  commitId: string;
  path: string;
  entries: RepositoryTreeEntry[];
}

export interface RepositoryFile {
  ref?: string;
  commitId?: string;
  baseCommitId?: string;
  fixCommitId?: string;
  path?: string;
  content?: string;
  size?: number;
  blobId?: string;
}

export interface ReviewFile {
  path: string;
  changeType: "A" | "D" | "M";
  before: RepositoryFile | null;
  after: RepositoryFile | null;
}

export interface RunReview {
  runId?: string;
  status?: string;
  base?: { branch?: string; commitId?: string };
  fix?: { branch?: string; commitId?: string };
  files?: ReviewFile[];
  evidence?: {
    implementation?: {
      engine?: string;
      requestedModel?: string;
      actualModel?: string;
      summary?: string;
      filesChanged: string[];
      buildOk: boolean;
      buildOutput: string;
      buildCommand: string;
      attempt?: number;
    };
    validation: Validation | null;
    report: Report | null;
    triage: Triage | null;
    draft: Draft | null;
  };
}

export interface ResetStatus {
  repositoryName: string;
  branch: string;
  mainHeadCommitId: string;
  canonicalCommitId: string;
  seedDigest: string;
  alreadyCanonical: boolean;
  activeRuns: Array<{ runId: string; status: string }>;
  canReset: boolean;
  resetAllowed: boolean;
  requiredConfirmation: string;
}

export type ContextContentType =
  | "text/plain"
  | "application/pdf"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export interface ContextItem {
  itemId: string;
  kind: "note" | "file" | "image";
  fileName: string;
  contentType: ContextContentType;
  sizeBytes: number;
  digest?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContextListResponse {
  items: ContextItem[];
  quota: {
    itemCount: number;
    totalBytes: number;
    maxItems: number;
    maxTotalBytes: number;
  };
}

export interface ContextUploadReservation {
  itemId: string;
  uploadUrl: string;
  expiresAt: string;
  requiredHeaders: { "Content-Type": ContextContentType };
}

export interface ContextPreview {
  url: string;
  expiresInSeconds: number;
  item: ContextItem;
}
