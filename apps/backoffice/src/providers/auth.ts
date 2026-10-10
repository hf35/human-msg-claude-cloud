import type { AuthProvider } from '@refinedev/core';
import { errorText, texts } from '../texts';
import { AdminApiError, http } from './http';

/** Sign-in of the back office: one login and password, the session is an `httpOnly` cookie. */
export const authProvider: AuthProvider = {
  async login({ login, password }: { login: string; password: string }) {
    try {
      await http('POST', '/login', { body: { login, password } });
      return { success: true, redirectTo: '/' };
    } catch (error) {
      const code = error instanceof AdminApiError ? error.code : 'unknown';
      const message = errorText(code);
      return { success: false, error: { name: texts.login.failed, message } };
    }
  },

  async logout() {
    // The cookie is cleared by the server; a failure still leaves the person on the sign-in page
    await http('POST', '/logout').catch(() => undefined);
    return { success: true, redirectTo: '/login' };
  },

  async check() {
    try {
      await http('GET', '/me');
      return { authenticated: true };
    } catch {
      // Also when the server is unreachable: the sign-in page then tells so on the next attempt
      return { authenticated: false, redirectTo: '/login' };
    }
  },

  async onError(error) {
    if (error instanceof AdminApiError && error.status === 401) {
      return { logout: true, redirectTo: '/login' };
    }
    return { error };
  },
};
