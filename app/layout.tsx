import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from './_lib/auth';
import { Shell } from './_components/Shell';

export const metadata: Metadata = {
  title: 'JobPilot · AI 求职工作台',
  description: '简历解析 → 岗位对照 → 保守修改 → PDF 导出，全程事实可溯源。',
  manifest: '/manifest.webmanifest',
  applicationName: 'JobPilot',
  appleWebApp: { capable: true, title: 'JobPilot', statusBarStyle: 'default' },
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = {
  // 与 globals.css 的 --accent（浅色）保持一致，避免移动端浏览器 UI 与页面主色脱节
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#3d5bd9' },
    { media: '(prefers-color-scheme: dark)', color: '#0d0f13' },
  ],
  width: 'device-width',
  initialScale: 1,
  // 允许缩放（无障碍要求：不得用 maximumScale/user-scalable 阻止用户放大）
};

const themeScript = `
(function () {
  try {
    var t = localStorage.getItem('jp_theme') || 'light';
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
`;

const swScript = `
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <script dangerouslySetInnerHTML={{ __html: swScript }} />
      </head>
      <body>
        <AuthProvider>
          <Shell>{children}</Shell>
        </AuthProvider>
      </body>
    </html>
  );
}
