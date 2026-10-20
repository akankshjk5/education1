'use client';

import { useEffect, useRef, useState } from 'react';
import { Menu, PanelLeftOpen, X } from 'lucide-react';
import Link from 'next/link';

import { Sidebar } from './sidebar';

export const SIDEBAR_COOKIE = 'lumina_sidebar';

/**
 * Client wrapper that owns sidebar open/closed state.
 *
 * The preference is persisted in a cookie, not localStorage, so the server
 * already knows it at render time (see src/app/app/layout.tsx). localStorage
 * would mean rendering "open" on the server and correcting after mount — a
 * hydration mismatch and a visible flicker on every load.
 *
 * `children` and `account` are server-rendered content passed through this
 * client boundary, which keeps them server-rendered.
 */
export function AppShell({
  defaultOpen,
  account,
  themeToggle,
  children,
}: {
  defaultOpen: boolean;
  account: React.ReactNode;
  themeToggle: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileNavigationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mobileOpen) return;

    const previousOverflow = document.body.style.overflow;
    const menuButton = menuButtonRef.current;
    document.body.style.overflow = 'hidden';
    mobileNavigationRef.current?.querySelector<HTMLAnchorElement>('a[href]')?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMobileOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = mobileNavigationRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      );
      if (!focusable?.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      menuButton?.focus();
    };
  }, [mobileOpen]);

  function toggle() {
    setOpen((previous) => {
      const next = !previous;
      // One year, site-wide. Not sensitive — a UI preference.
      document.cookie = `${SIDEBAR_COOKIE}=${next ? 'open' : 'closed'}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  }

  return (
    <div className="flex min-h-dvh bg-[var(--background)] text-[var(--foreground)] lg:h-dvh lg:overflow-hidden">
      <div className="hidden h-dvh lg:block">
        {open ? (
          <Sidebar onCollapse={toggle} account={account} themeToggle={themeToggle} />
        ) : (
          <div className="flex h-full w-16 shrink-0 flex-col items-center gap-4 border-r border-[var(--line)] bg-[var(--surface)] py-4">
            <button
              type="button"
              onClick={toggle}
              aria-label="Open sidebar"
              aria-expanded={false}
              title="Open sidebar"
              className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--muted)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
            >
              <PanelLeftOpen className="mx-auto h-[18px] w-[18px]" strokeWidth={1.8} />
            </button>
            {themeToggle}
            <div className="mt-auto">{account}</div>
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-[var(--line)] bg-[var(--surface)]/95 px-4 backdrop-blur lg:hidden">
          <Link href="/app" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-800 text-sm font-bold text-white dark:bg-indigo-300 dark:text-indigo-950">L</span>
            <span>Lumina</span>
          </Link>
          <div className="flex items-center gap-2">
            {themeToggle}
            {account}
            <button
              ref={menuButtonRef}
              type="button"
              aria-label={mobileOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={mobileOpen}
              aria-controls="mobile-navigation"
              onClick={() => setMobileOpen((current) => !current)}
              className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--foreground)] transition-colors hover:bg-[var(--surface-muted)]"
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </header>

        {mobileOpen ? (
          <div className="fixed inset-0 top-16 z-40 bg-neutral-950/35 lg:hidden">
            <button
              type="button"
              aria-label="Close navigation menu"
              className="absolute inset-0 h-full w-full cursor-default"
              onClick={() => setMobileOpen(false)}
            />
            <div
              id="mobile-navigation"
              ref={mobileNavigationRef}
              role="dialog"
              aria-modal="true"
              aria-label="Main navigation"
              className="relative border-b border-[var(--line)] bg-[var(--surface)] p-4 shadow-xl"
            >
              <Sidebar
                mobile
                onNavigate={() => setMobileOpen(false)}
                onCollapse={() => setMobileOpen(false)}
                account={account}
                themeToggle={themeToggle}
              />
            </div>
          </div>
        ) : null}

        <main className="min-h-[calc(100dvh-4rem)] min-w-0 lg:h-dvh lg:overflow-y-auto">
          <div className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
