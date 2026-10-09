import {
  authResponseSchema,
  errorResponseSchema,
  historyResponseSchema,
  meResponseSchema,
  questionRefResponseSchema,
  sendMessageResponseSchema,
  stateResponseSchema,
  type DevLoginRequest,
  type GoogleLoginRequest,
  type HistoryQuery,
  type ReportRequest,
} from '@human-msg/shared';
import type { z } from 'zod';

/** A refused request: the HTTP status and the reason code the server sent (`ACTION_ERRORS`). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** Machine-readable reason; `network` when the server could not be reached. */
    readonly code: string,
  ) {
    super(`${status} ${code}`);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  /** Base URL; empty means the same origin (the dev proxy or Caddy). */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Typed client of the web API. Every answer is checked against its schema from `shared`, so a
 * server that drifts from the contract fails loudly here instead of breaking a screen later.
 */
export function createApiClient({ baseUrl = '', fetch: fetchImpl }: ApiClientOptions = {}) {
  /** Sends the request and returns the response of a success; throws `ApiError` otherwise. */
  async function send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      // Looked up on each call so a test can replace the global `fetch`
      response = await (fetchImpl ?? fetch)(`${baseUrl}${path}`, {
        method,
        credentials: 'same-origin',
        ...(body !== undefined && {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      });
    } catch {
      throw new ApiError(0, 'network');
    }

    if (!response.ok) {
      const parsed = errorResponseSchema.safeParse(await response.json().catch(() => null));
      throw new ApiError(response.status, parsed.success ? parsed.data.error : 'unknown');
    }
    return response;
  }

  async function request<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<z.infer<S>> {
    return schema.parse(await (await send(method, path, body)).json());
  }

  return {
    me: () => request('GET', '/api/me', meResponseSchema),
    state: () => request('GET', '/api/state', stateResponseSchema),
    history: (query: Partial<HistoryQuery> = {}) => {
      const params = new URLSearchParams();
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      if (query.cursor) params.set('cursor', query.cursor);
      const suffix = params.size > 0 ? `?${params}` : '';
      return request('GET', `/api/history${suffix}`, historyResponseSchema);
    },
    sendMessage: (text: string) =>
      request('POST', '/api/messages', sendMessageResponseSchema, { text }),
    skip: () => request('POST', '/api/assignment/skip', questionRefResponseSchema),
    report: (target: ReportRequest) =>
      request('POST', '/api/reports', questionRefResponseSchema, target),
    loginGoogle: (body: GoogleLoginRequest) =>
      request('POST', '/api/auth/google', authResponseSchema, body),
    loginDev: (body: DevLoginRequest) => request('POST', '/api/auth/dev', authResponseSchema, body),
    logout: async (): Promise<void> => void (await send('POST', '/api/auth/logout')),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
