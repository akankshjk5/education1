'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Clapperboard, Film, LayoutDashboard, PanelLeftClose, Presentation } from 'lucide-react';

/**
 * The single sidebar: brand, sections, account.
 *
 * Everything here is backed by real data. Nav entries are added when the page
 * and its table exist — not before, so nothing in this shell is a button that
 * does nothing.
 */
const NAV_ITEMS = [
  { href: '/app', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/app#presentations', label: 'Presentations', icon: Presentation },
  { href: '/app/videos', label: 'Videos', icon: Clapperboard },
  { href: '/app/cloud-lessons', label: 'Lesson Video', icon: Film },
] as const;

export function Sidebar({
  onCollapse,
  account,
  themeToggle,
  mobile = false,
  onNavigate,
}: {
  onCollapse: () => void;
  account: React.ReactNode;
  themeToggle: React.ReactNode;
  mobile?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <aside
      className={`flex flex-col border-black/8 dark:border-white/10 ${
        mobile ? 'w-full' : 'h-full w-[248px] shrink-0 border-r border-[var(--line)] bg-[var(--surface)] px-3 py-5'
      }`}
    >
      {!mobile ? (
        <div className="flex items-center justify-between gap-1 px-2 py-1">
          <Link href="/app" className="flex min-w-0 items-center gap-2.5 text-[15px] font-semibold tracking-tight">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-800 text-sm font-bold text-white shadow-sm dark:bg-indigo-300 dark:text-indigo-950">
              L
            </span>
            <span className="truncate">Lumina</span>
          </Link>
          <div className="flex items-center gap-0.5">
            {themeToggle}
            <button
              type="button"
              onClick={onCollapse}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--muted)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
            >
              <PanelLeftClose className="mx-auto h-[18px] w-[18px]" strokeWidth={1.8} />
            </button>
          </div>
        </div>
      ) : null}

      {!mobile ? (
        <div className="px-3 pb-2 pt-8 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">
          Workspace
        </div>
      ) : null}
      <nav aria-label="Main navigation" className="flex flex-col gap-1">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = href === '/app#presentations'
            ? false
            : href === '/app'
              ? pathname === '/app'
              : pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              onClick={onNavigate}
              className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                active
                ? 'bg-[#eeecfb] font-semibold text-[#352d85] dark:bg-indigo-300/12 dark:text-indigo-200'
                : 'text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]'
              }`}
            >
            <Icon className={`h-[18px] w-[18px] shrink-0 ${active ? 'text-indigo-700 dark:text-indigo-200' : 'text-neutral-400'}`} strokeWidth={1.8} />
              {label}
            </Link>
          );
        })}
      </nav>

      {!mobile ? (
        <div className="mt-auto border-t border-[var(--line)] px-2 pt-4">
          {account}
        </div>
      ) : null}
    </aside>
  );
}
