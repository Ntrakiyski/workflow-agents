import { z } from "zod";

export const progress = {
  preparing: "Preparing your workspace in the background.",
  installing: "Preparing your workspace: installing and checking shared tools.",
  stopping: "Preparing your saved workspace for the next request.",
  starting: "Starting your saved workspace.",
  inputs: "Preparing this request’s input files.",
  queued:
    "Your request is queued. It will start when a session slot is available.",
  working: "Pi is working on this request in its own session.",
  saving: "Saving and validating the result files.",
};
export function uploadProgress(percent: number) {
  return `Preparing your workspace: uploading shared tools (${percent}%). This happens once.`;
}
const milestones: Record<string, string> = {
  "request.submitted": "Request submitted.",
  "sandbox.prepared": "Sandbox created for this request.",
  "request.dispatched": "Request sent for execution.",
  "request.completed": "Result files saved and ready.",
  "request.failed": "Request failed. See the error below for details.",
};
export function timelineMessage(action: string, detail: unknown) {
  if (action !== "request.progress") return milestones[action];
  const parsed = z.object({ message: z.string() }).safeParse(detail);
  if (!parsed.success) return undefined;
  const message = parsed.data.message;
  // Only application-owned status text is public; arbitrary audit detail stays private.
  return Object.values(progress).includes(message) ||
    /^Preparing your workspace: uploading shared tools \((?:100|[1-9]?\d)%\). This happens once\.$/.test(
      message,
    )
    ? message
    : undefined;
}
