import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt parameters (N, r, p) are stored in the hash, so they can be raised later without
// invalidating old hashes
const COST = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;
const PREFIX = 'scrypt';

const derive = (password: string, salt: Buffer, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, options, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );

/** Hash of a password in the form `scrypt$N$r$p$salt$key` (base64), for `BACKOFFICE_PASSWORD_HASH`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return [PREFIX, COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join(
    '$',
  );
}

/** Whether the string looks like a hash made by `hashPassword`. */
export function isPasswordHash(value: string): boolean {
  return /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(value);
}

/** Checks a password against a stored hash in constant time. A malformed hash never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!isPasswordHash(stored)) return false;
  const [, n, r, p, salt, key] = stored.split('$') as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const expected = Buffer.from(key, 'base64');
  try {
    const actual = await derive(password, Buffer.from(salt, 'base64'), {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    // Parameters the machine cannot afford or that scrypt refuses
    return false;
  }
}
