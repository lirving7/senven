'use client';

import { useRouter } from 'next/navigation';
import { IconAlert, IconCheck, IconInbox, IconInfo, IconLoader } from './icons';

/**
 * 状态面板 —— 五种状态统一实现，页面不再各自重写一套。
 *
 * 状态：loading / empty / error / success / info
 * 语义：`is-*` 修饰类只改变图标底色与描边，不使用大面积色块
 *       （工作台里大面积染色会干扰对事实状态的判读）。
 * 无障碍：loading/info/success 用 role="status"（不打断朗读），
 *         error 用 role="alert"（立即播报）。
 */

const SKELETON_ROWS = [0, 1, 2, 3];

export function LoadingState({ rows = 3 }: { rows?: number }) {
  return (
    <div className="state-panel" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">正在加载</span>
      <div className="state-panel-skeleton" aria-hidden="true">
        {SKELETON_ROWS.slice(0, Math.max(1, rows)).map((i) => (
          <div key={i} className="skeleton" data-row={i} />
        ))}
      </div>
    </div>
  );
}

export function ProcessingState({
  steps,
  elapsed,
  title = '正在处理',
}: {
  steps: string[];
  elapsed?: number;
  title?: string;
}) {
  return (
    <div className="state-panel" role="status" aria-live="polite">
      <span className="icon is-spinning" aria-hidden="true">
        <IconLoader />
      </span>
      <div className="state-panel-title">{title}</div>
      {steps.length > 0 && (
        <ul className="state-panel-steps">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      )}
      {typeof elapsed === 'number' && (
        <div className="caption">已用时 {elapsed}s</div>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  /** 已废弃：图标由统一图标族决定，不再由调用方传字符串/emoji。 */
  icon?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="state-panel" role="status">
      <span className="icon" aria-hidden="true">
        <IconInbox />
      </span>
      <div className="state-panel-title">{title}</div>
      {description && <p className="state-panel-desc">{description}</p>}
      {action && <div className="state-panel-actions">{action}</div>}
    </div>
  );
}

export function ErrorState({
  message,
  requestId,
  onRetry,
}: {
  message: string;
  requestId?: string;
  onRetry?: () => void;
}) {
  const router = useRouter();
  const isAuth = message.includes('登录') || message.includes('请先登录');
  return (
    <div className="state-panel is-error" role="alert">
      <span className="icon" aria-hidden="true">
        <IconAlert />
      </span>
      <div className="state-panel-title">{message}</div>
      {requestId && <div className="caption">请求号：{requestId}</div>}
      <div className="state-panel-actions">
        {isAuth ? (
          <button className="btn btn-primary" type="button" onClick={() => router.push('/login')}>
            去登录
          </button>
        ) : onRetry ? (
          <button className="btn btn-secondary" type="button" onClick={onRetry}>
            重试
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 成功态：用于「操作完成但无需展示数据」的场景（提交成功、已保存等）。 */
export function SuccessState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="state-panel is-success" role="status">
      <span className="icon" aria-hidden="true">
        <IconCheck />
      </span>
      <div className="state-panel-title">{title}</div>
      {description && <p className="state-panel-desc">{description}</p>}
      {action && <div className="state-panel-actions">{action}</div>}
    </div>
  );
}

/** 信息态：用于「无错误，但需要提示背景/规则」的场景。 */
export function InfoState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="state-panel is-info" role="status">
      <span className="icon" aria-hidden="true">
        <IconInfo />
      </span>
      <div className="state-panel-title">{title}</div>
      {description && <p className="state-panel-desc">{description}</p>}
      {action && <div className="state-panel-actions">{action}</div>}
    </div>
  );
}
