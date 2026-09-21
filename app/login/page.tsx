'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiRequestError, errorText } from '../_lib/api';
import { useAuth } from '../_lib/auth';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { setUser, user } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);

  const redirect = params.get('redirect') || '/';

  useEffect(() => {
    if (user) router.replace(redirect);
  }, [user, redirect, router]);

  useEffect(() => {
    if (retryAfter === null) return;
    const t = setTimeout(() => setRetryAfter((v) => (v && v > 1 ? v - 1 : null)), 1000);
    return () => clearTimeout(t);
  }, [retryAfter]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setFieldErr({});
    setSubmitting(true);
    try {
      const res = await api<{ data: { user: { id: string; email: string; displayName: string | null; avatarUrl: string | null } } }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setUser(res.data.user);
      router.replace(redirect);
    } catch (e) {
      const ex = e as ApiRequestError;
      if (ex.code === 'RATE_LIMITED') {
        setRetryAfter(ex.retryAfterSeconds ?? 900);
        setErr(ex.message);
      } else if (ex.code === 'INVALID_CREDENTIALS') {
        setErr('邮箱或密码不正确');
        setPassword('');
      } else if (ex.code === 'VALIDATION_FAILED') {
        setFieldErr({ email: '邮箱格式不正确', password: '请输入密码' });
      } else {
        setErr(errorText(ex));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const locked = retryAfter !== null;

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={onSubmit} noValidate>
        <h1>登录</h1>
        <div className="auth-sub">继续你的求职工作台</div>

        {err && <div className="banner banner-error mb-16">{err}</div>}

        <div className="field">
          <label htmlFor="email">邮箱</label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          {fieldErr.email && <span className="field-error">{fieldErr.email}</span>}
        </div>

        <div className="field">
          <label htmlFor="password">密码</label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {fieldErr.password && <span className="field-error">{fieldErr.password}</span>}
        </div>

        <button className="btn btn-primary btn-block" type="submit" disabled={submitting || locked}>
          {locked ? `请 ${retryAfter}s 后再试` : submitting ? '登录中…' : '登录'}
        </button>

        <div className="auth-switch">
          还没有账号？<Link href="/register">注册</Link>
        </div>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
