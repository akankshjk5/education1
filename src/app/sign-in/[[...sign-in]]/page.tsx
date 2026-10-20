import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

import { ClerkConfigState } from "@/components/auth/clerk-config-state";

export default async function SignInPage() {
  const hasClerkConfig = Boolean(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() && process.env.CLERK_SECRET_KEY?.trim(),
  );

  if (!hasClerkConfig) {
    return <ClerkConfigState />;
  }

  const { userId } = await auth();
  if (userId) redirect('/app');

  const { SignIn } = await import('@clerk/nextjs');

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--background)] px-4 py-8">
      <SignIn />
    </div>
  );
}
