'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiRequestError, errorText } from '../_lib/api';
import { useAuth } from '../_lib/auth';

function RegisterForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { setUser, user } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const redirect = params.get('redirect') || '/';

  useEffect(() => {
    if (user) router.replace(redirect);
  }, [user, redirect, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setFieldErr({});
    if (password.length < 8) {
      setFieldErr({ password: '密码至少 8 位' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await api<{ data: { user: { id: string; email: string; displayName: string | null; avatarUrl: string | null } } }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setUser(res.data.user);
      router.replace(redirect);
    } catch (e) {
      const ex = e as ApiRequestError;
      if (ex.code === 'EMAIL_TAKEN') {
        setErr('该邮箱已被注册');
      } else if (ex.code === 'VALIDATION_FAILED') {
        setFieldErr({ email: '邮箱格式不正确', password: '密码至少 8 位' });
      } else {
        setErr(errorText(ex));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={onSubmit} noValidate>
        <h1>注册</h1>
        <div className="auth-sub">创建账号，开始整理你的求职资料</div>

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
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {fieldErr.password && <span className="field-error">{fieldErr.password}</span>}
        </div>

        <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
          {submitting ? '注册中…' : '注册并登录'}
        </button>

        <div className="auth-switch">
          已有账号？<Link href="/login">登录</Link>
        </div>
      </form>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}
