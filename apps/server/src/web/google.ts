import { OAuth2Client } from 'google-auth-library';

/** The part of a verified Google ID token that the server uses. */
export interface GoogleIdentity {
  /** Stable Google account id (the `sub` claim). */
  sub: string;
}

/** Checks an ID token and returns who it belongs to; rejects when the token is not valid. */
export type GoogleTokenVerifier = (idToken: string) => Promise<GoogleIdentity>;

/**
 * Verifies the signature, the expiry, the issuer and that the token was issued for this app
 * (`aud`). Google's public keys are fetched and cached by the library.
 */
export function createGoogleVerifier(clientId: string): GoogleTokenVerifier {
  const client = new OAuth2Client(clientId);
  return async (idToken) => {
    const ticket = await client.verifyIdToken({ idToken, audience: clientId });
    const sub = ticket.getPayload()?.sub;
    if (!sub) throw new Error('ID token has no subject');
    return { sub };
  };
}
