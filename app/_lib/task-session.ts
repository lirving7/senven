'use client';

/**
 * G-4 · task-session —— 页面级长任务的最小状态保持模块（纯前端，非全局任务系统）。
 *
 * 背景：路由切换 = 页面组件 unmount，进行中的 LLM 请求与结果只存在页面 useState 中，
 * 跳页即丢；`suggest` 还会在重挂载时**重复发起 LLM**（重复消耗配额）。
 * 本模块把 `match/page.tsx` 已验证的 O-4 模式（模块级 matchSession/lastOutcome）抽成通用实现。
 *
 * 设计约束（DSH 审查 C2–C6）：
 *   - 纯内存 Map，**无持久化**、无跨标签同步；权威结果一律以服务端资源为准（JD ?jdId=、Agent runId 等）；
 *   - `startTask` 按 key **去重**：同 key 在途时返回同一 promise（不重复请求/计费，天然免疫 StrictMode 双执行）；
 *   - **禁止导航/unmount 取消**：本模块不提供 abort（取消只能由调用方自己实现按钮语义）；
 *   - key 必须含 userId（`${kind}:${userId}:${context}`），同浏览器换账号不串数据；
 *   - `elapsed` 一律由 `startedAt` 推导（不把计时器状态当任务状态）；
 *   - 已完成任务 outcome 保留供重挂载恢复，Map 超过上限时清理最旧条目（防内存增长）；
 *   - **不持久化敏感内容**（不写 localStorage/sessionStorage）。
 */

export type TaskOutcome<T> =
  | { kind: 'result'; data: T }
  | { kind: 'error'; message: string };

type TaskRecord = {
  promise: Promise<unknown> | null;
  startedAt: number;
  outcome: TaskOutcome<unknown> | null;
};

const tasks = new Map<string, TaskRecord>();
/** 已完成任务的保留上限（超过则清理最旧条目） */
const MAX_RETAINED = 20;

function evictOldest(): void {
  // Map 迭代顺序 = 插入顺序；清理最旧的已完成条目
  for (const [key, rec] of tasks) {
    if (!rec.promise) {
      tasks.delete(key);
      if (tasks.size <= MAX_RETAINED) return;
    }
  }
}

/** 该 key 是否有在途任务 */
export function isTaskRunning(key: string): boolean {
  return tasks.get(key)?.promise != null;
}

/** 在途任务的开始时间（无在途任务返回 null）；elapsed = Date.now() - startedAt */
export function getTaskStartedAt(key: string): number | null {
  const rec = tasks.get(key);
  return rec?.promise ? rec.startedAt : null;
}

/** 已完成任务的结果（无则 null）；供重挂载恢复展示 */
export function getTaskOutcome<T>(key: string): TaskOutcome<T> | null {
  const rec = tasks.get(key);
  return rec && !rec.promise ? ((rec.outcome as TaskOutcome<T> | null) ?? null) : null;
}

/**
 * 启动（或复用）一个任务：
 * - 同 key 已在途 → 返回**同一个** promise（去重，不重复执行 run）；
 * - 否则执行 run()，完成后记录 outcome 并清理在途标记。
 * `run` 自己负责把异常转换为 outcome（与既有页面 catch → setErr 的模式一致）。
 */
export function startTask<T>(key: string, run: () => Promise<TaskOutcome<T>>): Promise<TaskOutcome<T>> {
  const existing = tasks.get(key);
  if (existing?.promise) return existing.promise as Promise<TaskOutcome<T>>;

  const startedAt = Date.now();
  const promise = run();
  const rec: TaskRecord = { promise: promise as Promise<unknown>, startedAt, outcome: null };
  tasks.set(key, rec);

  return promise.then((outcome) => {
    rec.promise = null;
    rec.outcome = outcome;
    if (tasks.size > MAX_RETAINED) evictOldest();
    return outcome;
  });
}

/** 清除已完成任务的结果（用于「重新生成」强制刷新；对在途任务无效） */
export function clearTask(key: string): void {
  const rec = tasks.get(key);
  if (rec && !rec.promise) tasks.delete(key);
}
