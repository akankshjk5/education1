'use client';

import { Clapperboard, Film, Presentation } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const PRODUCTS = [
  { href: '/app', label: 'Presentation', description: 'Slides and PPTX', icon: Presentation },
  { href: '/app/videos', label: 'Narrated video', description: 'Voice + scenes', icon: Clapperboard },
  { href: '/app/cloud-lessons', label: 'Lesson Video', description: 'Short visual lesson', icon: Film },
] as const;

export function ProductSwitcher() {
  const pathname = usePathname();
  const [videoRunning, setVideoRunning] = useState(false);

  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const response = await fetch('/api/lesson-videos/active', { cache: 'no-store' });
        if (!response.ok) return;
        const body = await response.json() as { project: { id: string } | null };
        if (!stopped) setVideoRunning(Boolean(body.project));
      } catch {
        // A transient status failure must not interrupt either product page.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <nav aria-label="Creation workflows" className="grid grid-cols-3 gap-1.5 rounded-2xl border border-black/5 bg-neutral-100/80 p-1.5 sm:max-w-3xl sm:gap-2 dark:border-white/5 dark:bg-white/[0.04]">
      {PRODUCTS.map(({ href, label, description, icon: Icon }) => {
        const active = href === '/app' ? pathname === '/app' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-12 min-w-0 items-center gap-2 rounded-xl px-2 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 sm:gap-3 sm:px-4 ${
              active
                ? 'bg-white text-neutral-950 shadow-sm dark:bg-neutral-800 dark:text-white'
                : 'text-neutral-600 hover:bg-white/70 dark:text-neutral-300 dark:hover:bg-white/5'
            }`}
          >
            <Icon className="h-4 w-4 shrink-0 text-indigo-600 sm:h-5 sm:w-5 dark:text-indigo-400" strokeWidth={1.9} />
            <span className="min-w-0 text-left">
              <span className="block truncate text-[11px] font-semibold sm:text-sm">{label}</span>
              <span className="hidden truncate text-[11px] text-neutral-500 dark:text-neutral-400 sm:block">{description}</span>
              {href === '/app/videos' && videoRunning ? <span className="hidden truncate text-[11px] font-semibold text-indigo-600 sm:block dark:text-indigo-300">Generating in background</span> : null}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
