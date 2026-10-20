'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import { getJobStatusAction } from '@/lib/actions/generation';
import { labelForStage } from '@/lib/generation/stages';
import { useSupabase } from '@/lib/supabase/client';
import type { DeckStatus, GenerationJob } from '@/lib/supabase/types';

/**
 * Live build progress for one deck card.
 *
 * Three things keep it honest:
 *
 * 1. **Realtime** on that deck's `generation_jobs` row. The Clerk token is on
 *    the socket and the table's RLS policy is `owner_id = clerk_user_id()`, so
 *    a subscription can only deliver the user's own jobs — the filter is for
 *    traffic, not security.
 * 2. **A poll**, because a socket can fail to connect or miss the one update
 *    that mattered, and a finished or failed build must never sit on
 *    "Generating" forever.
 * 3. **A stage label**, not an estimated percentage. Stages take different
 *    amounts of time, so the pipeline cannot infer completion from them.
 */

const POLL_MS = 4000;

type JobShape = Pick<GenerationJob, 'status' | 'stage' | 'error'>;

export function DeckProgress({
  deckId,
  deckStatus,
  initialJob,
}: {
  deckId: string;
  deckStatus: DeckStatus;
  initialJob: JobShape | null;
}) {
  const supabase = useSupabase();
  const router = useRouter();
  const [job, setJob] = useState<JobShape | null>(initialJob);

  const settled = job?.status === 'succeeded' || job?.status === 'failed';

  const applyJob = useCallback(
    (next: JobShape) => {
      setJob(next);

      if (next.status === 'succeeded' || next.status === 'failed') router.refresh();
    },
    [router],
  );

  useEffect(() => {
    if (deckStatus !== 'generating') return;

    const channel = supabase
      .channel(`deck-job:${deckId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'generation_jobs',
          filter: `deck_id=eq.${deckId}`,
        },
        (payload) => applyJob(payload.new as JobShape),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, deckId, deckStatus, applyJob]);

  useEffect(() => {
    if (deckStatus !== 'generating' || settled) return;

    let cancelled = false;

    async function check() {
      const snapshot = await getJobStatusAction(deckId).catch(() => null);
      if (!cancelled && snapshot) applyJob(snapshot as JobShape);
    }

    // Once immediately: a card rendered from a stale server snapshot should not
    // wait a whole interval to catch up.
    void check();

    const timer = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [deckId, deckStatus, settled, applyJob]);

  if (deckStatus === 'failed' || job?.status === 'failed') {
    return (
      <p className="mt-2 line-clamp-2 text-xs text-red-600 dark:text-red-400">
        {job?.error ?? 'Generation failed.'}
      </p>
    );
  }

  if (deckStatus !== 'generating') return null;

  const stage = job?.stage ?? 'queued';
  const label = job?.status === 'succeeded' ? 'Presentation ready' : labelForStage(stage);

  return (
    <div role="status" aria-live="polite" className="mt-2 flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
      {job?.status === 'succeeded' ? null : <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />}
      <span className="truncate">{label}{job?.status === 'succeeded' ? '.' : '…'}</span>
    </div>
  );
}
