/** Reads the PostgreSQL connection string. Throws if `DATABASE_URL` is not set. */
export function getDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error('DATABASE_URL is not set (see .env.example)');
  }
  return url;
}
