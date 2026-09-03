import { appendEvent, updateRun } from "../shared/db";

/** Store the callback token and pause for a human execution decision. */
export const handler = async (event: {
  runId: string;
  taskToken: string;
}): Promise<void> => {
  const { runId, taskToken } = event;
  await updateRun(runId, { status: "AWAITING_APPROVAL", taskToken });
  await appendEvent(
    runId,
    "GATE",
    "Execution gate: choose Simple/Vibe or Complex/Spec, edit the artifact, then execute with Kiro or cancel"
  );
};
