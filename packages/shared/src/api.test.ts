import { describe, expect, it } from 'vitest';
import {
  devLoginRequestSchema,
  googleLoginRequestSchema,
  meResponseSchema,
  stateResponseSchema,
} from './api';

describe('login requests', () => {
  it('accept a token with an optional locale', () => {
    expect(googleLoginRequestSchema.safeParse({ idToken: 'x' }).success).toBe(true);
    expect(googleLoginRequestSchema.safeParse({ idToken: 'x', locale: 'en' }).success).toBe(true);
    expect(googleLoginRequestSchema.safeParse({ idToken: 'x', locale: 'de' }).success).toBe(false);
    expect(googleLoginRequestSchema.safeParse({ idToken: '' }).success).toBe(false);
  });

  it('dev login trims the name and limits its characters', () => {
    expect(devLoginRequestSchema.parse({ name: ' Alice ' }).name).toBe('Alice');
    expect(devLoginRequestSchema.safeParse({ name: 'a/b' }).success).toBe(false);
  });
});

describe('state responses', () => {
  it('describe an empty state', () => {
    expect(stateResponseSchema.safeParse({ assignment: null, pendingQuestion: null }).success).toBe(
      true,
    );
  });

  it('describe a profile', () => {
    expect(
      meResponseSchema.safeParse({
        alias: 'Green Rabbit',
        locale: 'ru',
        awaitingAnswer: false,
        busy: false,
        cooldownUntil: null,
        questionLimit: { limit: 10, used: 0, remaining: 10 },
        messageMaxLength: 2000,
      }).success,
    ).toBe(true);
  });
});
