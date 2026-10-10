import { errorResponseSchema } from '@human-msg/shared';

/** All back office endpoints live under this path; so does the session cookie. */
export const API_URL = '/admin/api';

/** A refused request: the HTTP status and the reason code the server sent. */
export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    /** Machine-readable reason; `network` when the server could not be reached. */
    readonly code: string,
  ) {
    super(`${status} ${code}`);
    this.name = 'AdminApiError';
  }
}

/**
 * Sends a request to the back office API and returns the parsed JSON (`undefined` for 204).
 * Throws `AdminApiError` for a refusal or an unreachable server.
 */
export async function http<T = unknown>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  options: { query?: Record<string, string | number | boolean>; body?: unknown } = {},
): Promise<T> {
  const query = new URLSearchParams(
    Object.entries(options.query ?? {}).map(([key, value]) => [key, String(value)]),
  ).toString();
  let response: Response;
  try {
    // Looked up on each call so a test can replace the global `fetch`
    response = await fetch(`${API_URL}${path}${query ? `?${query}` : ''}`, {
      method,
      credentials: 'same-origin',
      ...(options.body !== undefined && {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(options.body),
      }),
    });
  } catch {
    throw new AdminApiError(0, 'network');
  }
  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(await response.json().catch(() => null));
    throw new AdminApiError(response.status, parsed.success ? parsed.data.error : 'unknown');
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
