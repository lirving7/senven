/**
 * V2 · LLM 配额配置（用户级 + 功能级 + 时间窗口）
 *
 * 原则：阈值一律走环境变量覆盖，**不写死在业务代码里**。
 * 默认值为保守估计，仅用于本地开发；生产以环境变量为准。
 */
import { LLM_FEATURE } from '../ports/index.ts';
import type { LlmFeature } from '../ports/index.ts';

/** 配额窗口：默认 24 小时 */
export const DEFAULT_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

const DEFAULT_DAILY_LIMIT: Record<LlmFeature, number> = {
  [LLM_FEATURE.RESUME]: 20,
  [LLM_FEATURE.JD]: 20,
  [LLM_FEATURE.MATCH]: 20,
  [LLM_FEATURE.ACTION_PLAN]: 5,
  [LLM_FEATURE.LEARNING]: 10,
  [LLM_FEATURE.PROJECT_MENTOR]: 10,
  [LLM_FEATURE.PORTFOLIO]: 5,
  [LLM_FEATURE.INTERVIEW]: 10,
  // T5-B-2B0：ADR-017 §3（T5B-F-10 / F-11）—— 第 9 槽，v1 初始 10 / rolling 24h。
  // 复用既有窗口与 gate 语义，未新增任何独立配额实现。
  [LLM_FEATURE.AGENT]: 10,
};

/** 每功能每日上限；环境变量 LLM_QUOTA_<FEATURE>_PER_DAY 优先 */
export function quotaLimitFor(feature: LlmFeature): number {
  const raw = process.env[`LLM_QUOTA_${feature}_PER_DAY`];
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  return DEFAULT_DAILY_LIMIT[feature];
}

/** 配额窗口长度；环境变量 LLM_QUOTA_WINDOW_MS 优先 */
export function quotaWindowMs(): number {
  const raw = process.env.LLM_QUOTA_WINDOW_MS;
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_QUOTA_WINDOW_MS;
}

/** 每 1K token 的单价（用于推算 cost）；未配置时为 0，token 仍如实记录 */
export function costPer1kTokens(): number {
  const raw = process.env.LLM_COST_PER_1K_TOKENS;
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function computeCost(totalTokens: number): number {
  return (totalTokens / 1000) * costPer1kTokens();
}
