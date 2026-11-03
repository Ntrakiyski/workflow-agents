import { Logger } from "graphile-worker";
export type LogSink = (record: Record<string, unknown>) => void;
export const stdoutSink: LogSink = (record) =>
  process.stdout.write(JSON.stringify(record) + "\n");
export function createLogSink(minimum: string): LogSink {
  const levels: Record<string, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 100,
  };
  return (record) => {
    if (
      (levels[String(record.level ?? "info")] ?? 20) >= (levels[minimum] ?? 20)
    )
      stdoutSink(record);
  };
}
export function log(sink: LogSink, fields: Record<string, unknown>) {
  sink({
    timestamp: new Date().toISOString(),
    service: "job-runner",
    level: "info",
    duration_ms: 0,
    outcome: "ok",
    ...fields,
  });
}
// Graphile messages can contain SQL, payloads, and connection strings. Only its
// operational level and scope are emitted; application audit holds safe details.
export function graphileLogger(sink: LogSink) {
  return new Logger((scope) => (level) => {
    log(sink, {
      action: "queue." + level,
      level,
      outcome: level === "error" ? "failed" : "ok",
      queue_task: scope.taskIdentifier ?? null,
    });
  });
}
