import { describe, expect, it } from 'vitest';
import { APP_NAME } from './index';

describe('shared', () => {
  it('exports the application name', () => {
    expect(APP_NAME).toBe('human-msg');
  });
});
