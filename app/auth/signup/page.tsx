'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

import { supabase } from '@/lib/supabase/client';

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email || !password) {
      setError('请填写邮箱和密码');
      return;
    }

    setLoading(true);
    setError('');
    setNotice('');

    const { data, error } = await supabase.auth.signUp({
      email,
      password
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setLoading(false);
    if (data.session) {
      router.replace('/today');
      return;
    }

    setNotice('注册成功，请先查收验证邮件后登录。');
  };

  return (
    <main className='flex min-h-screen items-center justify-center bg-slate-100 p-6'>
      <section className='w-full max-w-md rounded-2xl bg-white p-6 shadow-sm'>
        <h1 className='text-2xl font-bold text-slate-900'>注册</h1>
        <p className='mt-2 text-sm text-slate-500'>先创建账号后可同步管理任务</p>

        <form onSubmit={handleSubmit} className='mt-6 space-y-4'>
          <label className='block'>
            <span className='mb-1 block text-sm text-slate-600'>邮箱</span>
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type='email'
              autoComplete='email'
              className='w-full rounded-lg border border-slate-200 p-2 focus:border-slate-500 focus:outline-none'
              placeholder='you@example.com'
            />
          </label>

          <label className='block'>
            <span className='mb-1 block text-sm text-slate-600'>密码</span>
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type='password'
              autoComplete='new-password'
              className='w-full rounded-lg border border-slate-200 p-2 focus:border-slate-500 focus:outline-none'
              placeholder='至少 6 位'
            />
          </label>

          {error && <p className='text-sm text-rose-600'>{error}</p>}
          {notice && <p className='text-sm text-emerald-700'>{notice}</p>}

          <button
            type='submit'
            disabled={loading}
            className='w-full rounded-lg bg-slate-900 py-2 font-medium text-white disabled:opacity-50'
          >
            {loading ? '注册中...' : '注册'}
          </button>
        </form>

        <p className='mt-4 text-sm text-slate-600'>
          已有账号？
          <Link href='/auth/login' className='ml-1 text-slate-900 underline'>
            去登录
          </Link>
        </p>
      </section>
    </main>
  );
}
