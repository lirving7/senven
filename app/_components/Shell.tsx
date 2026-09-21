'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { SideNav } from './SideNav';
import { useAuth } from '../_lib/auth';

/** 全屏页面：不套用 App Shell（自带居中布局） */
const FULLSCREEN = new Set(['/login', '/register']);

/**
 * App Shell
 *
 * 结构：
 *   App Shell
 *   ├── SideNav（>900px 静态侧栏 / ≤900px off-canvas 抽屉 + 顶栏）
 *   └── Main
 *       ├── Header（由各页面的 <PageHeader> 提供，或 ≤900px 由顶栏承担）
 *       └── Content
 *
 * 布局用 min-height（dvh）而非固定 height:100vh，内容超出时正常滚动。
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading } = useAuth();

  // 未登录访问受保护页面时跳转登录页。
  // 背景：AuthProvider 拿到 /api/auth/me 的 401 后只会置 user=null，
  // 各页面在 !user 时仅渲染 LoadingState 骨架，没有任何跳转逻辑；
  // 客户端因此会永久停留在「只有骨架」的中间态 —— 在 Android WebView
  // 首次启动（无会话 Cookie）时即表现为「白屏只剩顶栏」。
  useEffect(() => {
    if (!loading && !user && !FULLSCREEN.has(pathname)) {
      router.replace('/login');
    }
  }, [loading, user, pathname, router]);

  if (FULLSCREEN.has(pathname)) {
    return <main>{children}</main>;
  }

  return (
    <div className="app-shell">
      {/* 键盘用户的跳转链接：首个可聚焦元素，仅在获得焦点时可见 */}
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <SideNav />
      <main className="app-main" id="main-content" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
