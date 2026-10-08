/** Outcome of a command: a value, or a refusal with a machine-readable reason. */
export type Result<T, R extends string = string> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: R };

export function ok(): Result<void, never>;
export function ok<T>(value: T): Result<T, never>;
export function ok<T>(value?: T): Result<T | undefined, never> {
  return { ok: true, value };
}

export function fail<R extends string>(reason: R): Result<never, R> {
  return { ok: false, reason };
}
