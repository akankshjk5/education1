type ClerkConfigStateProps = {
  title?: string;
  description?: string;
};

export function ClerkConfigState({
  title = 'Authentication setup required',
  description = 'Add the required Clerk environment variables before the sign-in page can render.',
}: ClerkConfigStateProps) {
  const missing = [
    !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() ? 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY' : null,
    !process.env.CLERK_SECRET_KEY?.trim() ? 'CLERK_SECRET_KEY' : null,
  ].filter(Boolean) as string[];

  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-6 py-12 text-slate-900">
      <div className="max-w-lg rounded-xl border border-slate-200 bg-slate-50 p-8 shadow-sm">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
          Lumina Deck Pro
        </p>
        <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">{description}</p>
        <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Missing Clerk configuration:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {missing.length > 0 ? (
              missing.map((key) => <li key={key}>{key}</li>)
            ) : (
              <li>Check the Clerk environment configuration and reload the app.</li>
            )}
          </ul>
        </div>
        <p className="mt-5 text-sm text-slate-600">
          Set the values in your local <code>.env</code> file or run <code>clerk env pull</code>, then restart the app.
        </p>
      </div>
    </div>
  );
}
