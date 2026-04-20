/**
 * Standard JSON response shape for HTTP APIs (not used for SSE stream bodies).
 */
export type ApiErrorBody = {
  code: string;
  message: string;
  details?: unknown;
};

export type ApiEnvelope<T> = {
  data: T | null;
  error: ApiErrorBody | null;
  meta?: Record<string, unknown>;
};

export function ok<T>(data: T, meta?: Record<string, unknown>): ApiEnvelope<T> {
  return { data, error: null, meta };
}

export function fail(
  code: string,
  message: string,
  details?: unknown,
  meta?: Record<string, unknown>
): ApiEnvelope<null> {
  return { data: null, error: { code, message, details }, meta };
}
