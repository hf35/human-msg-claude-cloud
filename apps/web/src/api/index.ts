import { createApiClient } from './client';

/** The client used by the app: same origin, so the session cookie goes with every request. */
export const api = createApiClient();
export * from './client';
