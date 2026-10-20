import { clerkClient } from '@clerk/nextjs/server';

type ClerkSessionClient = {
  sessions: {
    getToken: (sessionId: string | { sessionId: string }) => Promise<unknown>;
  };
};

export function extractClerkJwt(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'jwt' in value && typeof value.jwt === 'string') {
    return value.jwt;
  }
  return null;
}

export async function mintFreshSessionToken(sessionId: string): Promise<string | null> {
  const clerk = await clerkClient();
  return getFreshSessionTokenFromClerk(clerk as unknown as ClerkSessionClient, sessionId);
}

export async function getFreshSessionTokenFromClerk(
  clerk: ClerkSessionClient,
  sessionId: string,
): Promise<string | null> {
  const attempts = [
    () => clerk.sessions.getToken(sessionId as never),
    () => clerk.sessions.getToken({ sessionId } as never),
  ];

  const warnings: string[] = [];

  for (const attempt of attempts) {
    try {
      const jwt = extractClerkJwt(await attempt());
      if (jwt) return jwt;
      warnings.push('Clerk returned no JWT.');
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (warnings.length > 0) {
    console.warn('[supabase] failed to mint a fresh Clerk session token', {
      attempts: warnings.length,
      errors: warnings.map((warning) => warning.slice(0, 220)),
    });
  }

  return null;
}
