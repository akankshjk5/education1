import { AudioLines, Clapperboard } from 'lucide-react';
import { LessonVideoStudio } from '@/components/videos/lesson-video-studio';
import { requireUserId } from '@/lib/auth/session';
import { listLessonVideoProjects } from '@/lib/data/lesson-videos';

export const metadata = { title: 'Videos · Lumina' };

export default async function VideosPage({ searchParams }: PageProps<'/app/videos'>) {
  const userId = await requireUserId();
  const params = await searchParams;
  const projects = await listLessonVideoProjects(userId);
  const requestedId = Array.isArray(params.video) ? params.video[0] : params.video;
  const initialId = projects.some((project) => project.id === requestedId) ? requestedId : undefined;

  return (
    <div className="lm-page">
      <header className="lm-page-header">
        <p className="lm-eyebrow inline-flex items-center gap-2">
          <AudioLines className="h-4 w-4" /> Narrated learning
        </p>
        <h1 className="lm-page-title flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-800 dark:bg-indigo-300/10 dark:text-indigo-200"><Clapperboard className="h-5 w-5" /></span>
          Narrated videos
        </h1>
        <p className="lm-page-description">
          Shape a class topic into a narrated lesson with scene visuals, voice-over and a video you can preview and download.
        </p>
      </header>
      <LessonVideoStudio initialProjects={projects} initialId={initialId} />
    </div>
  );
}
