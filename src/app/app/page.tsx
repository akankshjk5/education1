import { ArrowRight, BookOpen, Clapperboard, Film, Presentation } from 'lucide-react';
import Link from 'next/link';

import { CreateDeckDialog } from '@/components/decks/create-deck-dialog';
import { DeckCard } from '@/components/decks/deck-card';
import { requireUserId } from '@/lib/auth/session';
import { DECK_PAGE_SIZE, coverSlides, listDecks } from '@/lib/data/decks';
import { latestJobsByDeck } from '@/lib/data/generation';
import { listCloudLessons } from '@/lib/data/cloud-lessons';
import { listLessonVideoProjects } from '@/lib/data/lesson-videos';
import { ensureProfile } from '@/lib/data/profiles';
import type { Deck, GenerationJob, Slide } from '@/lib/supabase/types';
import type { CloudLessonProject } from '@/lib/videos/cloud-lesson-contracts';
import type { LessonVideoProject } from '@/lib/videos/lesson-contracts';

export const metadata = { title: 'Dashboard · Lumina' };

export default async function AppPage({ searchParams }: PageProps<'/app'>) {
  const userId = await requireUserId();
  const params = await searchParams;
  const requested = Number(Array.isArray(params.page) ? params.page[0] : params.page);
  const page = Number.isInteger(requested) && requested > 1 ? requested : 1;

  let decks: Deck[] = [];
  let lessonVideos: LessonVideoProject[] = [];
  let cloudLessons: CloudLessonProject[] = [];
  let total = 0;
  let jobs = new Map<string, GenerationJob>();
  let covers = new Map<string, Slide>();
  const dataErrors: string[] = [];

  let profileReady = true;
  let deckLoadError = false;
  try {
    await ensureProfile(userId);
  } catch (error) {
    profileReady = false;
    deckLoadError = true;
    dataErrors.push(error instanceof Error ? error.message : 'Your profile could not be loaded.');
  }

  if (profileReady) {
    const [listed, narrated, cloud] = await Promise.allSettled([
      listDecks(userId, { offset: (page - 1) * DECK_PAGE_SIZE }),
      listLessonVideoProjects(userId, 4),
      listCloudLessons(userId),
    ]);

    if (listed.status === 'fulfilled') {
      decks = listed.value.decks;
      total = listed.value.total;
      const deckIds = decks.map((deck) => deck.id);
      const [latestJobs, slideCovers] = await Promise.allSettled([
        latestJobsByDeck(userId, deckIds),
        coverSlides(deckIds),
      ]);
      if (latestJobs.status === 'fulfilled') jobs = latestJobs.value;
      else dataErrors.push('Presentation progress is temporarily unavailable.');
      if (slideCovers.status === 'fulfilled') covers = slideCovers.value;
      else dataErrors.push('Presentation previews are temporarily unavailable.');
    } else {
      deckLoadError = true;
      dataErrors.push('Your presentations could not be loaded.');
    }

    if (narrated.status === 'fulfilled') lessonVideos = narrated.value;
    else dataErrors.push('Your narrated videos could not be loaded.');

    if (cloud.status === 'fulfilled') cloudLessons = cloud.value.slice(0, 4);
    else dataErrors.push('Your Lesson Video projects could not be loaded.');
  }

  const pages = Math.max(1, Math.ceil(total / DECK_PAGE_SIZE));
  const hasRecentWork = lessonVideos.length > 0 || cloudLessons.length > 0;
  const dataError = dataErrors.length > 0;

  return (
    <div className="lm-page">
      <section className="lm-card relative overflow-hidden px-5 py-7 sm:px-8 sm:py-8">
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-violet-200/35 blur-3xl dark:bg-violet-500/10" />
        <div className="relative max-w-3xl">
          <p className="lm-eyebrow">Lumina learning studio</p>
          <h1 className="mt-3 max-w-2xl text-[clamp(1.8rem,3vw,2.45rem)] font-semibold leading-[1.16] tracking-[-0.04em]">
            Make the next lesson easier to teach.
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--muted)] sm:text-base sm:leading-7">
            Create classroom-ready presentations and narrated learning videos from the topics you already teach.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <CreateDeckDialog />
            <Link href="/app/videos" className="lm-button-secondary">
              <Clapperboard className="h-4 w-4" /> Create a video
            </Link>
          </div>
        </div>
      </section>

      <section aria-labelledby="workflows-heading">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="lm-eyebrow">Start creating</p>
            <h2 id="workflows-heading" className="lm-section-title mt-1.5">Choose a format</h2>
          </div>
          <p className="max-w-sm text-sm leading-6 text-[var(--muted)]">Choose the learning experience that fits your lesson.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <WorkflowCard
            href="/app#presentations"
            icon={Presentation}
            title="Presentations"
            description="Build a designed, editable slide deck from your lesson topic."
            action="Explore presentations"
            tone="indigo"
          />
          <WorkflowCard
            href="/app/videos"
            icon={Clapperboard}
            title="Narrated videos"
            description="Create a lesson plan with scene visuals, voice-over and a finished video."
            action="Create a narrated video"
            tone="indigo"
          />
          <WorkflowCard
            href="/app/cloud-lessons"
            icon={Film}
            title="Lesson Video"
            description="Turn one topic into a concise illustrated or storybook-style lesson."
            action="Create a lesson video"
            tone="violet"
          />
        </div>
      </section>

      {dataError ? (
        <div role="alert" className="rounded-2xl border border-amber-300 bg-amber-50 px-5 py-4 text-sm text-amber-950 dark:border-amber-400/25 dark:bg-amber-500/10 dark:text-amber-100">
          <p className="font-semibold">Recent work could not be loaded</p>
          <ul className="mt-1 list-inside list-disc text-amber-900/80 dark:text-amber-100/80">
            {dataErrors.map((error) => <li key={error}>{error}</li>)}
          </ul>
        </div>
      ) : null}

      <section id="presentations" aria-labelledby="presentations-heading" className="scroll-mt-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="lm-eyebrow">Your library</p>
            <h2 id="presentations-heading" className="lm-section-title mt-1.5">Presentations</h2>
            {total > 0 ? <p className="mt-1 text-sm text-[var(--muted)]">{total} {total === 1 ? 'presentation' : 'presentations'} in your library</p> : null}
          </div>
          {total > 0 ? <CreateDeckDialog /> : null}
        </div>

        {!deckLoadError && decks.length === 0 ? (
          <div className="lm-empty-state">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
              <BookOpen className="h-5 w-5" />
            </span>
            <h3 className="mt-4 font-semibold">Your presentation library starts here</h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--muted)]">
              Create a deck from a topic, then review its outline before the full presentation is built.
            </p>
          </div>
        ) : decks.length > 0 ? (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {decks.map((deck) => (
              <DeckCard key={deck.id} deck={deck} job={jobs.get(deck.id) ?? null} cover={covers.get(deck.id) ?? null} />
            ))}
          </div>
        ) : null}

        {pages > 1 ? (
          <nav aria-label="Presentation pages" className="mt-6 flex items-center justify-center gap-4 text-sm">
            <PageLink page={page - 1} disabled={page === 1} label="Previous page" />
            <span className="tabular-nums text-neutral-500 dark:text-neutral-400">{page} / {pages}</span>
            <PageLink page={page + 1} disabled={page === pages} label="Next page" />
          </nav>
        ) : null}
      </section>

      <section aria-labelledby="recent-heading">
        <div className="mb-5">
          <p className="lm-eyebrow">Your learning library</p>
          <h2 id="recent-heading" className="lm-section-title mt-1.5">Learning videos</h2>
        </div>
        {!dataError && !hasRecentWork ? (
          <div className="lm-empty-state">
            <p className="font-medium">No videos yet</p>
            <p className="mt-1 text-sm text-[var(--muted)]">Your generated videos will appear here when they are ready or in progress.</p>
            <div className="mt-4 flex flex-wrap justify-center gap-3">
              <Link href="/app/videos" className="text-sm font-semibold text-indigo-700 hover:underline dark:text-indigo-300">Create a narrated video</Link>
              <Link href="/app/cloud-lessons" className="text-sm font-semibold text-indigo-700 hover:underline dark:text-indigo-300">Create a Lesson Video</Link>
            </div>
          </div>
        ) : hasRecentWork ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <RecentVideoGroup
              title="Narrated videos"
              href="/app/videos"
              projects={lessonVideos.map((project) => ({
                id: project.id,
                title: project.title,
                detail: `Class ${project.class_level} · ${project.subject} · ${project.target_duration_seconds} sec · ${project.language_name}`,
                status: project.status,
                statusLabel: videoStatusLabel(project.status),
                href: `/app/videos?video=${encodeURIComponent(project.id)}`,
              }))}
            />
            <RecentVideoGroup
              title="Lesson Video"
              href="/app/cloud-lessons"
              projects={cloudLessons.map((project) => ({
                id: project.id,
                title: project.title ?? project.topic,
                detail: `Class ${project.class_level} · ${project.subject} · ${project.target_duration_seconds} sec`,
                status: project.status,
                statusLabel: videoStatusLabel(project.status),
                href: `/app/cloud-lessons?lesson=${encodeURIComponent(project.id)}`,
              }))}
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}

function WorkflowCard({
  href,
  icon: Icon,
  title,
  description,
  action,
  tone,
}: {
  href: string;
  icon: typeof Presentation;
  title: string;
  description: string;
  action: string;
  tone: 'indigo' | 'violet';
}) {
  const accent = {
    indigo: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
    violet: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  }[tone];

  return (
    <Link
      href={href}
      className="lm-card group flex min-h-[190px] flex-col p-5 transition duration-200 hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md dark:hover:border-indigo-300/30"
    >
      <span className="relative flex items-center justify-between">
        <span className={`flex h-11 w-11 items-center justify-center rounded-xl ${accent}`}><Icon className="h-5 w-5" strokeWidth={1.8} /></span>
      </span>
      <h3 className="mt-4 text-base font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 flex-1 text-sm leading-6 text-[var(--muted)]">{description}</p>
      <span className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-indigo-800 dark:text-indigo-200">
        {action}<ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
      </span>
    </Link>
  );
}

function RecentVideoGroup({
  title,
  href,
  projects,
}: {
  title: string;
  href: string;
  projects: { id: string; title: string; detail: string; status: string; statusLabel: string; href: string }[];
}) {
  return (
    <div className="lm-card p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
            {title === 'Narrated videos' ? <Clapperboard className="h-[18px] w-[18px]" /> : <Film className="h-[18px] w-[18px]" />}
          </span>
          <h3 className="truncate font-semibold">{title}</h3>
        </div>
        <Link href={href} className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold text-indigo-700 transition-colors hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-white/5">View all <ArrowRight className="h-3.5 w-3.5" /></Link>
      </div>
      {projects.length ? (
        <ul className="divide-y divide-black/5 dark:divide-white/10">
          {projects.map((project) => (
            <li key={project.id}>
              <Link href={project.href} className="flex min-h-16 items-center justify-between gap-3 rounded-xl px-2 py-3 transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:bg-white/[0.03]">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{project.title}</span>
                  <span className="mt-1 block truncate text-xs text-neutral-500 dark:text-neutral-400">{project.detail}</span>
                </span>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${videoStatusStyle(project.status)}`}>{project.statusLabel}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl bg-neutral-50 px-3 py-4 text-sm text-neutral-500 dark:bg-white/[0.03] dark:text-neutral-400">No projects yet in this workflow.</p>
      )}
    </div>
  );
}

function videoStatusLabel(status: string) {
  if (status === 'succeeded') return 'Ready';
  if (status === 'failed') return 'Failed';
  if (status === 'cancelled') return 'Cancelled';
  return 'In progress';
}

function videoStatusStyle(status: string) {
  if (status === 'succeeded') return 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300';
  if (status === 'failed') return 'bg-red-50 text-red-800 dark:bg-red-500/15 dark:text-red-300';
  if (status === 'cancelled') return 'bg-neutral-100 text-neutral-600 dark:bg-white/10 dark:text-neutral-300';
  return 'bg-indigo-50 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-300';
}

function PageLink({ page, disabled, label }: { page: number; disabled: boolean; label: string }) {
  if (disabled) {
    return <span aria-disabled className="rounded-xl border border-black/8 px-3 py-2 text-neutral-400 dark:border-white/10">{label}</span>;
  }
  return <Link href={page <= 1 ? '/app' : `/app?page=${page}`} aria-label={label} className="rounded-xl border border-black/10 px-3 py-2 font-medium hover:bg-neutral-50 dark:border-white/15 dark:hover:bg-white/5">{label}</Link>;
}
