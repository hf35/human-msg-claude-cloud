import { z } from 'zod';
import { LOCALES } from './texts';

/**
 * Contracts of the web API (ARCHITECTURE.md, section 11): request bodies are validated with these
 * schemas on the server and typed with them in the web client.
 */

/** Language the interface was shown in; used only when the account is created. */
const locale = z.enum(LOCALES);

/** `POST /api/auth/google`: the ID token from Google Identity Services. */
export const googleLoginRequestSchema = z.object({
  idToken: z.string().min(1),
  locale: locale.optional(),
});
export type GoogleLoginRequest = z.infer<typeof googleLoginRequestSchema>;

/** `POST /api/auth/dev`: sign-in without Google, development only. The name picks the account. */
export const devLoginRequestSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[\w .-]+$/),
  locale: locale.optional(),
});
export type DevLoginRequest = z.infer<typeof devLoginRequestSchema>;
