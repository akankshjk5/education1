import { Film } from 'lucide-react';
import { requireUserId } from '@/lib/auth/session';
import { listCloudLessons } from '@/lib/data/cloud-lessons';
import { CloudLessonStudio } from '@/components/videos/cloud-lesson-studio';
import { serverEnv } from '@/lib/env';
import type { CloudLessonProject } from '@/lib/videos/cloud-lesson-contracts';
export const metadata = { title: 'Lesson Video · Lumina' };
export default async function CloudLessonsPage({ searchParams }: { searchParams: Promise<{ lesson?: string }> }) {
  const ownerId = await requireUserId();
  let projects: CloudLessonProject[] = []; let setupError: string | undefined;
  try { projects = await listCloudLessons(ownerId); }
  catch { setupError = 'Cloud lessons could not be loaded. Check that the cloud database migrations are applied and your session is connected.'; }
  const { lesson } = await searchParams;
  return (
    <div className="lm-page">
      <header className="lm-page-header">
        <p className="lm-eyebrow">Classroom stories</p>
        <h1 className="lm-page-title flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-violet-800 dark:bg-violet-300/10 dark:text-violet-200"><Film className="h-5 w-5" /></span>
          Lesson Video
        </h1>
        <p className="lm-page-description">
          Turn a curriculum topic into a short narrated video with a visual style chosen for your classroom.
        </p>
      </header>
      <CloudLessonStudio
        initialProjects={projects}
        initialId={projects.some((project) => project.id === lesson) ? lesson : undefined}
        setupError={setupError}
        animationAllowance={30 * serverEnv.cloudLessonHiggsfieldUsdPerSecond}
      />
    </div>
  );
}
