import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { users } from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.close());
// Every test starts with empty tables
beforeEach(() => testDb.reset());

describe('test database', () => {
  it('has all migrations applied and allows committed writes', async () => {
    await testDb.db.insert(users).values({ channel: 'web', alias: 'Example', googleSub: 'g' });
    expect(await testDb.db.select().from(users)).toHaveLength(1);
  });

  it('starts the next test with empty tables', async () => {
    expect(await testDb.db.select().from(users)).toHaveLength(0);
  });

  it('is isolated from other test databases', async () => {
    const other = await createTestDatabase();
    try {
      await other.db.insert(users).values({ channel: 'web', alias: 'Other', googleSub: 'o' });
      expect(await testDb.db.select().from(users)).toHaveLength(0);
    } finally {
      await other.close();
    }
  });
});
