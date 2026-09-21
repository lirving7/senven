'use client';

import type { ReactNode } from 'react';

/**
 * 统一页面头部。
 *
 * 设计取向：**左对齐 + 明确层级**。工作台不需要居中标题。
 * 层级顺序（自上而下）：上下文（eyebrow）→ 页面标题 → 页面说明；
 * 操作按钮固定在右侧，移动端自动换行到标题下方并左对齐。
 *
 * 用法：
 * ```tsx
 * <PageHeader
 *   title="分析岗位"
 *   description="粘贴 JD，解析出分级要求清单"
 *   eyebrow={<><span>当前目标</span><span>·</span><span>AI 视频实习</span></>}
 *   actions={<Link className="btn btn-primary" href="/match">与简历对照</Link>}
 * />
 * ```
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** 当前上下文（如所属求职目标、页面所在层级）。渲染在标题之上，弱于标题。 */
  eyebrow?: ReactNode;
  /** 右侧操作区。移动端会换行到标题下方。 */
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        {eyebrow && <div className="page-header-eyebrow">{eyebrow}</div>}
        <h1 className="page-header-title">{title}</h1>
        {description && <p className="page-header-desc">{description}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}
