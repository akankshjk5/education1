import assert from 'node:assert/strict';
import test from 'node:test';

import { extractClerkJwt, getFreshSessionTokenFromClerk } from './session-token';

test('extractClerkJwt accepts a raw Clerk JWT string', () => {
  assert.equal(extractClerkJwt('raw-token-123'), 'raw-token-123');
});

test('extractClerkJwt accepts an object containing a jwt field', () => {
  assert.equal(extractClerkJwt({ jwt: 'object-token-456' }), 'object-token-456');
});

test('extractClerkJwt rejects missing payloads', () => {
  assert.equal(extractClerkJwt(undefined), null);
  assert.equal(extractClerkJwt({ token: 'not-used' }), null);
});

test('getFreshSessionTokenFromClerk returns null and warns when no JWT is available', async () => {
  const originalWarn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);

  try {
    const token = await getFreshSessionTokenFromClerk(
      {
        sessions: {
          getToken: async () => ({ ok: false }),
        },
      },
      'session-123',
    );

    assert.equal(token, null);
    assert.equal(warnings.length, 1);
    assert.match(JSON.stringify(warnings[0]), /failed to mint a fresh Clerk session token/i);
    assert.doesNotMatch(JSON.stringify(warnings[0]), /raw-token|object-token|session-123/i);
  } finally {
    console.warn = originalWarn;
  }
});

test('getFreshSessionTokenFromClerk falls back to the object API and keeps error details sanitized', async () => {
  const originalWarn = console.warn;
  let warnCount = 0;
  console.warn = () => {
    warnCount += 1;
  };

  try {
    const token = await getFreshSessionTokenFromClerk(
      {
        sessions: {
          getToken: async (arg: unknown) => {
            if (typeof arg === 'string') {
              throw new Error('session was unavailable');
            }
            return { jwt: 'fallback-token-789' };
          },
        },
      },
      'session-456',
    );

    assert.equal(token, 'fallback-token-789');
    assert.equal(warnCount, 0);
  } finally {
    console.warn = originalWarn;
  }
});
