'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { motionSchema } from '@agents/motion';

import { requireUserId } from '@/lib/auth/session';
import { setSlideMotion } from '@/lib/data/slides';

/**
 * Hand edits to a built deck. One verb so far: the animation panel's save.
 *
 * Ownership is re-checked server-side inside `setSlideMotion` even though the
 * panel only renders on the user's own deck — the deck id arrives from the
 * client, so what the UI shows is a courtesy and not a control.
 */

/** More elements than any slide the pipeline produces; a larger payload is not a slide. */
const MAX_ELEMENTS = 64;

const payloadSchema = z.object({
  deckId: z.string().uuid(),
  position: z.number().int().min(0).max(500),
  /**
   * Element index (as rendered) → its new motion. Parsed with the same schema
   * the pipeline writes through, so a browser cannot put a shape in `blocks`
   * that the renderer would then have to survive.
   */
  motions: z.record(z.string().regex(/^\d+$/), motionSchema),
});

export async function updateSlideMotionAction(
  input: unknown,
): Promise<{ error: string | null }> {
  const userId = await requireUserId();

  const parsed = payloadSchema.safeParse(input);
  if (!parsed.success) return { error: 'That animation could not be read.' };

  const { deckId, position, motions } = parsed.data;
  if (Object.keys(motions).length > MAX_ELEMENTS) {
    return { error: 'That slide has more elements than this can edit.' };
  }

  try {
    await setSlideMotion(userId, deckId, position, motions);

    revalidatePath(`/app/decks/${deckId}`);
    return { error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[slides] motion save failed for ${deckId} slide ${position}: ${message}`);
    return { error: 'Could not save the animation.' };
  }
}
