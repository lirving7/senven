'use client';

import type { ReactNode } from 'react';

export const FACT_LABEL: Record<string, string> = {
  CONFIRMED: '已确认',
  INFERRED: '推断（待确认）',
  UNCONFIRMED: '待确认',
  MISSING: '缺失',
};

const MATCH_LABEL: Record<string, string> = {
  HAVE: '已覆盖',
  ENHANCE: '待增强',
  MISSING: '缺失',
};

/**
 * 状态标记 —— Fact Safety 的视觉底线。
 *
 * 四种事实状态在**三个维度**上同时区分，任一维度失效都不至于误读：
 *   CONFIRMED   实心圆 + 白勾（"已完成"隐喻）
 *   INFERRED    半圆（左空右实，表达"部分成立"）
 *   UNCONFIRMED 空心圆 + 问号
 *   MISSING     空心圆 + 叉
 * 颜色只是第三个维度，绝不作为唯一依据（满足「不以颜色为唯一状态依据」）。
 */
function Mark({ kind }: { kind: string }) {
  const stroke = 'currentColor';
  if (kind === 'CONFIRMED' || kind === 'HAVE') {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <circle cx="6" cy="6" r="5" fill="var(--fill-confirmed)" />
        <path d="M3.5 6.2l1.8 1.8 3.2-3.4" stroke="#fff" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === 'INFERRED' || kind === 'ENHANCE') {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <circle cx="6" cy="6" r="5" fill="none" stroke={stroke} strokeWidth="1.4" />
        <path d="M6 1 a5 5 0 0 1 0 10 z" fill="var(--fill-inferred)" />
      </svg>
    );
  }
  if (kind === 'UNCONFIRMED') {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <circle cx="6" cy="6" r="5" fill="none" stroke={stroke} strokeWidth="1.4" />
        <text x="6" y="8.6" textAnchor="middle" fontSize="7" fill={stroke}>?</text>
      </svg>
    );
  }
  // MISSING
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <circle cx="6" cy="6" r="5" fill="none" stroke={stroke} strokeWidth="1.4" />
      <path d="M4 4 l4 4" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
      <path d="M8 4 l-4 4" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function factLabel(status: string): string {
  return FACT_LABEL[status] ?? MATCH_LABEL[status] ?? status;
}

const CHIP_CLASS: Record<string, string> = {
  CONFIRMED: 'chip-confirmed',
  INFERRED: 'chip-inferred',
  UNCONFIRMED: 'chip-unconfirmed',
  MISSING: 'chip-missing',
  HAVE: 'chip-confirmed',
  ENHANCE: 'chip-inferred',
};

/**
 * 事实状态芯片。
 * 语义与视觉均与既有口径一致：CONFIRMED / INFERRED / UNCONFIRMED / MISSING。
 * `aria-label` 保证屏幕阅读器读到完整状态名（不依赖颜色或图形）。
 */
export function FactChip({ status, children }: { status: string; children?: ReactNode }) {
  const cls = CHIP_CLASS[status] ?? 'chip-missing';
  return (
    <span className={`chip ${cls}`} aria-label={`状态：${factLabel(status)}`}>
      <Mark kind={status} />
      {children ?? factLabel(status)}
    </span>
  );
}
