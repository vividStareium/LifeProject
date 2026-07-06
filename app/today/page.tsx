import { Suspense } from 'react';

import TodayClient from './today-client';

export default function TodayPage() {
  return (
    <Suspense fallback={<div className='min-h-screen bg-slate-50' />}>
      <TodayClient />
    </Suspense>
  );
}
