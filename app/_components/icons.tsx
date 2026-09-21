/**
 * JobPilot 统一图标族（唯一来源）。
 *
 * 规则（UI 第一阶段冻结）：
 *   · 全部为内联 SVG，**不引入图标库依赖**，也不自造风格混搭；
 *   · 统一 24×24 视框、`stroke="currentColor"`、`strokeWidth={1.75}`、
 *     圆角端点 —— 线性风格，与工作台的克制取向一致；
 *   · 尺寸统一由 CSS（width/height）控制，默认 1em 由上层的 font-size 决定；
 *   · **禁止 emoji 作为功能图标**（emoji 在不同平台渲染差异极大且无法统一描边）；
 *   · 纯装饰性图标必须 `aria-hidden`；独立图标按钮必须由使用方提供 aria-label。
 *
 * 增补新图标时：只允许按本风格追加线性图标，不得引入第二套风格。
 */

import type { SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  /** 逻辑尺寸（px）。默认 18，用于导航与行内图标。 */
  size?: number;
};

function Svg({ size = 18, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    />
  );
}

/* ─── 导航 ─────────────────────────────────────────────────────────── */

/** 首页 / 工作台总览 */
export function IconHome(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 10.5 12 3.5l9 7" />
      <path d="M5.5 9.5V20h13V9.5" />
      <path d="M9.75 20v-5.25h4.5V20" />
    </Svg>
  );
}

/** 分析岗位（JD） */
export function IconFileSearch(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <circle cx="11" cy="14" r="2.5" />
      <path d="m13 16 2 2" />
    </Svg>
  );
}

/** 我的简历 */
export function IconIdCard(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <circle cx="8.5" cy="11.5" r="2" />
      <path d="M5 16.25c.6-1.1 1.9-1.75 3.5-1.75s2.9.65 3.5 1.75" />
      <path d="M15 10.5h3.5M15 14h3.5" />
    </Svg>
  );
}

/** 岗位对照（Match） */
export function IconScale(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3v18" />
      <path d="M5 7h14" />
      <path d="M5 7 2 14h6z" />
      <path d="M19 7l-3 7h6z" />
      <path d="M8 21h8" />
    </Svg>
  );
}

/** 行动方案（ActionPlan） */
export function IconListChecks(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10 6h11M10 12h11M10 18h11" />
      <path d="m3 6 1.6 1.6L7.5 4.7" />
      <path d="m3 12 1.6 1.6L7.5 10.7" />
      <path d="M3.6 18.6 7.5 16.7" />
    </Svg>
  );
}

/** 求职目标 */
export function IconTarget(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </Svg>
  );
}

/** 我的求职（投递追踪） */
export function IconSend(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M21 3 10.5 13.5" />
      <path d="M21 3 14.5 21l-4-7.5L3 9.5z" />
    </Svg>
  );
}

/** 制作项目 */
export function IconBox(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 2.75 20.5 7.5v9L12 21.25 3.5 16.5v-9z" />
      <path d="M3.5 7.5 12 12.25l8.5-4.75" />
      <path d="M12 12.25V21.25" />
    </Svg>
  );
}

/** 作品集 */
export function IconLayers(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3 3 7.5l9 4.5 9-4.5z" />
      <path d="m3 12.5 9 4.5 9-4.5" />
      <path d="m3 17 9 4.5 9-4.5" />
    </Svg>
  );
}

/** 学习提升 */
export function IconBook(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v15H5.5A1.5 1.5 0 0 0 4 19.5z" />
      <path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H19" />
      <path d="M8 7.5h7M8 11h5" />
    </Svg>
  );
}

/** AI 求职助手 */
export function IconSparkle(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3.5l1.9 4.6L18.5 10l-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9z" />
      <path d="M18.5 16.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" />
    </Svg>
  );
}

/** 模拟面试 */
export function IconMic(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21M9 21h6" />
    </Svg>
  );
}

/* ─── 界面动作 ─────────────────────────────────────────────────────── */

export function IconMenu(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </Svg>
  );
}

export function IconClose(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

export function IconChevronRight(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m9 5 7 7-7 7" />
    </Svg>
  );
}

export function IconArrowRight(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </Svg>
  );
}

export function IconLogout(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.5 4.5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h3.5" />
      <path d="M15 8.5 18.5 12 15 15.5" />
      <path d="M18.5 12H9" />
    </Svg>
  );
}

export function IconUpload(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 16V4.5" />
      <path d="m7.5 9 4.5-4.5L16.5 9" />
      <path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />
    </Svg>
  );
}

export function IconUser(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="8.5" r="3.75" />
      <path d="M4.5 20.5c.9-3.4 3.9-5.5 7.5-5.5s6.6 2.1 7.5 5.5" />
    </Svg>
  );
}

export function IconSun(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </Svg>
  );
}

export function IconMoon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
    </Svg>
  );
}

export function IconMonitor(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M8.5 21h7M12 17v4" />
    </Svg>
  );
}

export function IconKey(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="7.5" cy="15.5" r="3.5" />
      <path d="m10 13 8.5-8.5" />
      <path d="m15 8 2.5 2.5M18.5 4.5 21 7" />
    </Svg>
  );
}

export function IconMail(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </Svg>
  );
}

export function IconAlert(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3.5 21.5 20H2.5z" />
      <path d="M12 9.5v4.5" />
      <path d="M12 17.25h.01" />
    </Svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m4.5 12.5 5 5 10-11" />
    </Svg>
  );
}

export function IconInfo(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.75h.01" />
    </Svg>
  );
}

export function IconInbox(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 13.5 6 5h12l2.5 8.5" />
      <path d="M3.5 13.5h4l1 2.5h7l1-2.5h4V18a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z" />
    </Svg>
  );
}

export function IconLoader(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3.5v4" />
      <path d="M12 16.5v4" />
      <path d="M5.99 5.99l2.83 2.83" />
      <path d="m15.18 15.18 2.83 2.83" />
      <path d="M3.5 12h4" />
      <path d="M16.5 12h4" />
      <path d="m5.99 18.01 2.83-2.83" />
      <path d="m15.18 8.82 2.83-2.83" />
    </Svg>
  );
}
