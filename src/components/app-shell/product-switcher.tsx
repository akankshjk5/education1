'use client';

import { Clapperboard, Presentation } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const PRODUCTS = [
  { href: '/app', label: 'Presentation', description: 'Slides and PPTX', icon: Presentation },
  { href: '/app/videos', label: 'Video', description: 'AI learning clip', icon: Clapperboard },
] as const;

export function ProductSwitcher() {
  const pathname = usePathname();

  return (
    <nav aria-label="Create type" className="grid max-w-xl grid-cols-2 gap-2 rounded-xl bg-black/5 p-1.5 dark:bg-white/8">
      {PRODUCTS.map(({ href, label, description, icon: Icon }) => {
        const active = href === '/app' ? pathname === '/app' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-3 rounded-lg px-4 py-3 transition-colors ${
              active
                ? 'bg-white text-neutral-950 shadow-sm dark:bg-neutral-800 dark:text-white'
                : 'text-neutral-600 hover:bg-white/60 dark:text-neutral-300 dark:hover:bg-white/5'
            }`}
          >
            <Icon className="h-5 w-5 shrink-0 text-indigo-600 dark:text-indigo-400" strokeWidth={1.9} />
            <span className="text-left">
              <span className="block text-sm font-semibold">{label}</span>
              <span className="block text-[11px] text-neutral-500 dark:text-neutral-400">{description}</span>
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
