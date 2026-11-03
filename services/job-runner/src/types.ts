import type { Pool, PoolClient } from "pg";
export const VERSION = "1.0.0-rc.1";
export const TERMINAL = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
export type Status =
  | "queued"
  | "scheduled"
  | "dispatching"
  | "running"
  | "retry_wait"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";
export type SafeError = {
  code: string;
  message: string;
  retryable: boolean;
  correlation_id: string;
};
export type Result = {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  output_truncated: boolean;
  artifacts: Array<{
    ref: string;
    sha256: string;
    size_bytes: number;
    media_type?: string;
  }>;
};
export type Workload = { profile: string; arguments: Record<string, unknown> };
export type Limits = {
  max_duration_seconds: number;
  max_attempts: number;
  retry_backoff_seconds?: number;
  deadline_at?: string;
};
export type JobSubmission = {
  client_reference?: string;
  workload: Workload;
  sandbox: {
    mode: "ensure" | "reuse";
    owner_ref?: string;
    profile?: string;
    persistent?: true;
    sandbox_id?: string;
  };
  limits: Limits;
  priority?: number;
  run_at?: string;
  idle_stop_after_seconds?: number;
};
export type Principal = {
  token: string;
  actor_id: string;
  owner_id: string;
  permissions: string[];
  workload_profiles: string[];
  sandbox_profiles: string[];
  allow_resume?: boolean;
  max_concurrency?: number;
  max_pending_jobs?: number;
};
export type JobRow = {
  job_id: string;
  owner_id: string;
  actor_id: string;
  correlation_id: string;
  client_reference: string | null;
  payload: JobSubmission;
  dispatch_key: string;
  status: Status;
  sandbox_id: string | null;
  run_id: string | null;
  attempt_count: number;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  due_at: Date;
  attempt_started_at: Date | null;
  cancellation_target: "cancelled" | "timed_out" | "failed" | null;
  result: Result | null;
  error: SafeError | null;
};
export type ScheduleSubmission = {
  run_at: string;
  action: "submit_job" | "stop_sandbox" | "cancel_job";
  job?: JobSubmission;
  sandbox_id?: string;
  job_id?: string;
};
export type ScheduleRow = {
  schedule_id: string;
  owner_id: string;
  actor_id: string;
  correlation_id: string;
  action: ScheduleSubmission["action"];
  payload: ScheduleSubmission;
  status: "pending" | "fired" | "cancelled" | "skipped" | "failed";
  run_at: Date;
  job_id: string | null;
  sandbox_id: string | null;
  guard_job_id: string | null;
  created_at: Date;
  updated_at: Date;
  error: SafeError | null;
};
export type Sql = Pick<PoolClient, "query"> | Pool;
export type Sandbox = {
  sandbox_id: string;
  owner_ref: string;
  profile: string;
  persistent: true;
  status: string;
  active_run_id: string | null;
  error: SafeError | null;
  [key: string]: unknown;
};
export type Run = {
  run_id: string;
  sandbox_id: string;
  status: string;
  result: Result | null;
  error: SafeError | null;
  [key: string]: unknown;
};
