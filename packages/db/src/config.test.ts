import { describe, expect, it } from 'vitest';
import { getDatabaseUrl } from './config';

describe('getDatabaseUrl', () => {
  it('returns the configured url', () => {
    expect(getDatabaseUrl({ DATABASE_URL: ' postgres://u:p@host:5432/db ' })).toBe(
      'postgres://u:p@host:5432/db',
    );
  });

  it.each([undefined, '', '   '])('throws when the url is %j', (value) => {
    expect(() => getDatabaseUrl({ DATABASE_URL: value })).toThrow(/DATABASE_URL/);
  });
});
