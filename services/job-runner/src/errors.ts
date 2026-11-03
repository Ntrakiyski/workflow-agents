import type { SafeError } from "./types.js";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
  safe(correlation_id: string): SafeError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      correlation_id,
    };
  }
}
export function unavailable() {
  return new ApiError(
    503,
    "dependency_unavailable",
    "A required dependency is unavailable",
    true,
  );
}
export function notFound() {
  return new ApiError(404, "not_found", "Resource not found");
}
