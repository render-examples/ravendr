import type { AppError, ErrorCode } from "./errors.js";

/** Canonical response envelope for every HTTP endpoint. */
export type Envelope<T> =
  | { data: T; error: null; meta?: Record<string, unknown> }
  | { data: null; error: { code: ErrorCode; message: string }; meta?: Record<string, unknown> };

export function ok<T>(data: T, meta?: Record<string, unknown>): Envelope<T> {
  return { data, error: null, meta };
}

export function fail(error: AppError, meta?: Record<string, unknown>): Envelope<never> {
  return {
    data: null,
    error: { code: error.code, message: error.message },
    meta,
  };
}
