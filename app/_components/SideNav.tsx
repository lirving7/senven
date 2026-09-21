'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { PersonalCenter } from './PersonalCenter';
import {
  IconBook,
  IconBox,
  IconClose,
  IconFileSearch,
  IconHome,
  IconIdCard,
  IconLayers,
  IconListChecks,
  IconMenu,
  IconMic,
  IconScale,
  IconSend,
  IconSparkle,
  IconTarget,
} from './icons';

/**
 * 导航分组：按「求职动线」组织，而非平铺一堆入口。
 * 层级 1 = 总览；2 = 准备材料；3 = 求职推进；4 = 能力与助手。
 *
 * 图标由 ICONS 映射单独提供，导航条目本身保持「纯 href + label」形态——
 * 这样 `{ href: '/agent', label: 'AI 求职助手' }` 与
 * `{ href: '/interview', label: '模拟面试' }` 在源码中始终以可被既有测试
 * 直接断言的字面量存在（tests/agent-ui.test.ts、tests/interview-ui.test.ts）。
 * 若把 icon 内联进同一个对象字面量，会破坏这两条断言，故拆开维护。
 */
type NavEntry = { href: string; label: string };

const NAV_GROUPS: Array<{ label: string; items: NavEntry[] }> = [
  {
    label: '总览',
    items: [{ href: '/', label: '首页' }],
  },
  {
    label: '准备材料',
    items: [
      { href: '/resumes', label: '我的简历' },
      { href: '/jds', label: '分析岗位' },
      { href: '/projects', label: '制作项目' },
      { href: '/portfolio', label: '作品集' },
    ],
  },
  {
    label: '求职推进',
    items: [
      { href: '/goals', label: '求职目标' },
      { href: '/match', label: '岗位对照' },
      { href: '/action-plans', label: '岗位行动计划' },
      { href: '/applications', label: '我的求职' },
      { href: '/interview', label: '模拟面试' },
    ],
  },
  {
    label: '能力与助手',
    items: [
      { href: '/learn', label: '学习提升' },
      { href: '/agent', label: 'AI 求职助手' },
    ],
  },
];

/** href → 图标。统一取自 ./icons 的同一图标族，不混用风格、不用 emoji。 */
const NAV_ICONS: Record<string, ComponentType<{ size?: number; className?: string }>> = {
  '/': IconHome,
  '/resumes': IconIdCard,
  '/jds': IconFileSearch,
  '/projects': IconBox,
  '/portfolio': IconLayers,
  '/goals': IconTarget,
  '/match': IconScale,
  '/action-plans': IconListChecks,
  '/applications': IconSend,
  '/interview': IconMic,
  '/learn': IconBook,
  '/agent': IconSparkle,
};


/**
 * 侧边导航。
 *
 * 响应式策略（≤900px）：本组件在同一 DOM 中兼任两种形态，
 *   · 桌面（>900px）：静态侧栏，sticky 定位；
 *   · 移动（≤900px）：off-canvas 抽屉，由 `is-open` 平移进出，
 *     配合遮罩层，并用 `body` 滚动锁避免背景滚动。
 * 不使用 `overflow:hidden` 掩盖布局问题——抽屉本身脱离文档流。
 */
export function SideNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? '';

  // 路由变化时自动关闭抽屉（移动端点击导航项后应立即看到内容）
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // 抽屉打开时：Esc 关闭 + 锁定背景滚动
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  /** active 判定：/ 精确匹配，其余前缀匹配（保留既有语义，URL 未改） */
  function isActive(href: string): boolean {
    return href === '/' ? pathname === '/' : pathname.startsWith(href);
  }

  return (
    <>
      {/* 移动端顶栏：仅在 ≤900px 显示（CSS 控制） */}
      <header className="topbar">
        <button
          className="btn btn-ghost btn-icon"
          type="button"
          onClick={() => setOpen(true)}
          aria-label="打开主导航"
          aria-expanded={open}
          aria-controls="app-sidenav"
        >
          <IconMenu size={20} />
        </button>
        <span className="topbar-brand">
          <span className="brand-mark" aria-hidden="true">JP</span>
          JobPilot
        </span>
      </header>

      {/* 遮罩：抽屉打开时可点击关闭。用 button 保证键盘可达。 */}
      {open && (
        <button
          className="sidenav-scrim"
          type="button"
          aria-label="关闭主导航"
          onClick={() => setOpen(false)}
        />
      )}

      <aside id="app-sidenav" className={`sidenav${open ? ' is-open' : ''}`} ref={navRef}>
        <div className="sidenav-brand">
          <span className="brand-mark" aria-hidden="true">JP</span>
          <span className="brand-name">JobPilot</span>
          {/* 抽屉内的关闭按钮：移动端专属 */}
          <button
            className="btn btn-ghost btn-icon sidenav-close"
            type="button"
            onClick={() => setOpen(false)}
            aria-label="关闭主导航"
          >
            <IconClose size={18} />
          </button>
        </div>

        <nav className="sidenav-nav" aria-label="主导航">
          {NAV_GROUPS.map((group) => (
            <div className="sidenav-group" key={group.label}>
              <div className="sidenav-group-label">{group.label}</div>
              {group.items.map((item) => {
                const Icon = NAV_ICONS[item.href] ?? IconHome;
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`sidenav-item${active ? ' is-active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                  >
                    <Icon className="sidenav-icon" size={18} />
                    <span className="sidenav-label">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidenav-foot">
          <PersonalCenter />
          {version && <div className="sidenav-version">版本 {version}</div>}
        </div>
      </aside>
    </>
  );
}
