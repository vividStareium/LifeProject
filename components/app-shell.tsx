'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

const navigation = [
  { href: '/today', label: '今日' },
  { href: '/habits', label: '习惯' },
  { href: '/heatmap', label: '热力图' },
  { href: '/import', label: '导入' },
  { href: '/export', label: '导出' }
] as const;

type AppShellProps = {
  title: string;
  description: string;
  activeHref: string;
  children: ReactNode;
  actions?: ReactNode;
  signOutLabel?: string;
  onSignOut?: () => void | Promise<void>;
};

export function AppShell({
  title,
  description,
  activeHref,
  children,
  actions,
  signOutLabel = '退出登录',
  onSignOut
}: AppShellProps) {
  return (
    <main className='min-h-screen bg-slate-50 px-3 py-3 text-slate-900 sm:px-6 lg:px-8'>
      <div className='mx-auto flex w-full max-w-7xl flex-col gap-4'>
        <header className='rounded-2xl border border-slate-100 bg-white px-4 py-4 shadow-sm sm:px-5'>
          <div className='flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between'>
            <div className='max-w-2xl'>
              <p className='text-xs font-semibold text-sky-700'>
                Life Project
              </p>
              <h1 className='mt-2 text-2xl font-semibold sm:text-3xl'>{title}</h1>
              <p className='mt-2 max-w-xl text-sm leading-6 text-slate-600'>{description}</p>
            </div>

            <div className='flex flex-wrap items-center gap-3'>
              {actions}
              {onSignOut && (
                <button
                  type='button'
                  onClick={onSignOut}
                  className='rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800'
                >
                  {signOutLabel}
                </button>
              )}
            </div>
          </div>

          <nav className='mt-5 grid grid-cols-5 gap-2 overflow-x-auto text-center sm:flex sm:flex-wrap'>
            {navigation.map((item) => {
              const isActive = activeHref === item.href || activeHref.startsWith(`${item.href}?`);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? 'page' : undefined}
                  className={`whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium transition sm:px-4 ${
                    isActive
                      ? 'bg-slate-900 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </header>

        {children}
      </div>
    </main>
  );
}

type PanelProps = {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
};

export function Panel({ title, description, children, className = '', actions }: PanelProps) {
  return (
    <section
      className={`rounded-2xl border border-slate-100 bg-white p-4 shadow-sm ${className}`}
    >
      {(title || description || actions) && (
        <div className='mb-4 flex flex-wrap items-end justify-between gap-3'>
          <div>
            {title && <h2 className='text-lg font-semibold text-slate-900'>{title}</h2>}
            {description && <p className='mt-1 text-sm leading-6 text-slate-500'>{description}</p>}
          </div>
          {actions}
        </div>
      )}

      {children}
    </section>
  );
}

type StatCardProps = {
  label: string;
  value: string | number;
  hint?: string;
};

export function StatCard({ label, value, hint }: StatCardProps) {
  return (
    <div className='rounded-2xl border border-slate-100 bg-slate-50/80 p-4'>
      <p className='text-sm text-slate-500'>{label}</p>
      <p className='mt-2 text-2xl font-semibold text-slate-900'>{value}</p>
      {hint && <p className='mt-1 text-xs text-slate-500'>{hint}</p>}
    </div>
  );
}
