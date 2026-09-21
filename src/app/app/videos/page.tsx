import { Clapperboard } from 'lucide-react';

import { ProductSwitcher } from '@/components/app-shell/product-switcher';
import { VideoStudio } from '@/components/videos/video-studio';
import { requireUserId } from '@/lib/auth/session';
import { listVideoProjects } from '@/lib/data/videos';
import { VideoProjectSchema } from '@/lib/videos/contracts';

export const metadata = { title: 'Videos · Lumina' };

export default async function VideosPage() {
  const userId = await requireUserId();
  const projects = await listVideoProjects(userId);

  return (
    <div className="px-8 py-6">
      <ProductSwitcher />
      <header className="mt-6">
        <h1 className="flex items-center gap-2.5 text-xl font-bold"><Clapperboard className="h-5 w-5" />Videos</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">Enter the class, subject and topic. Lumina handles the visual and animation stages.</p>
      </header>
      <VideoStudio initialProjects={VideoProjectSchema.array().parse(projects)} />
    </div>
  );
}
