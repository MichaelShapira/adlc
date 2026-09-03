import { appendEvent, updateRun } from "../shared/db";
import { validateArtifact } from "../shared/workflow";

interface AutoDecisionInput {
  runId: string;
  draft: {
    simplePrompt?: unknown;
  };
}

/** Automatically approve the generated SIMPLE prompt when the run explicitly opts in. */
export const handler = async (input: AutoDecisionInput) => {
  const artifact =
    typeof input.draft?.simplePrompt === "string" ? input.draft.simplePrompt : "";
  const artifactError = validateArtifact("SIMPLE", artifact);
  if (artifactError) throw new Error(artifactError);

  const approval = {
    action: "execute" as const,
    approved: true,
    selectedMode: "SIMPLE" as const,
    selectedArtifact: artifact,
    feedback: "",
    reviewer: "Automatic SIMPLE execution",
    reviewerSub: "system:auto-execute-simple",
    decidedAt: new Date().toISOString(),
  };

  await updateRun(input.runId, {
    approval,
    selectedMode: approval.selectedMode,
    selectedArtifact: approval.selectedArtifact,
  });
  await appendEvent(
    input.runId,
    "GATE",
    "SIMPLE artifact automatically approved for Kiro execution"
  );

  return approval;
};
