import type { Clock, Counter, FailureLimiter } from '../ports/index.ts';
import { systemClock } from '../ports/index.ts';

/**
 * 内存实现。⚠️ 已知局限：多实例部署时计数不共享，会被放大。
 * V1 单实例可接受；横向扩展前必须替换为 DB 或 Redis 实现（见 ADR-007）。
 * 进程重启后计数清空 —— 同样标记为 V1 已接受的取舍。
 */

export function createInMemoryCounter(clock: Clock = systemClock): Counter {
  const hits = new Map<string, number[]>();

  return {
    async consume(key, limit, windowMs) {
      const now = clock.now().getTime();
      const windowStart = now - windowMs;
      const kept = (hits.get(key) ?? []).filter((t) => t > windowStart);
      if (kept.length >= limit) {
        const oldest = kept[0];
        hits.set(key, kept);
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
        };
      }
      kept.push(now);
      hits.set(key, kept);
      return { allowed: true, remaining: limit - kept.length, retryAfterSeconds: 0 };
    },
  };
}

/**
 * 每小时 LLM 调用配额的**环境变量覆盖**（2026-09-21，用户报告 429 后新增）。
 *
 * 背景：`/api/matches`、`/api/jds`、`/api/suggestions` 使用同一把进程内内存计数器
 * （`createInMemoryCounter`），键为 `llm:<userId>`，窗口 1 小时。各 handler 的取值形式是
 * `deps.llmQuotaPerHour ?? 内置常量`，而 `deps.ts` 从未注入 `llmQuotaPerHour`，
 * 导致该阈值在运行时恒为硬编码常量（20），且**没有任何环境变量开关** ——
 * 与 `src/llm/quota.ts` 自陈的原则「阈值一律走环境变量覆盖，不写死在业务代码里」不一致。
 *
 * 本函数**只提供读取**，不改变计量语义、不改变默认值：
 *  - 未设置 / 空 / 非有限数 / 负数 → 返回 undefined → 调用方回落到原内置常量（默认行为不变）；
 *  - 合法非负整数 → 作为该阈值的显式覆盖。
 *
 * ⚠️ 计量粒度：`/api/matches` 按「每条未确定性命中的 JD 要求」逐次 `consume`，
 * 单次操作的消耗量 = 该 JD 走语义匹配的要求条数（实测某 JD 为 18 条），不是 1。
 * 因此调高阈值应按此倍数量级估算，而非按「点击次数」估算。
 */
export function hourlyQuotaFromEnv(): number | undefined {
  const raw = process.env.LLM_QUOTA_PER_HOUR;
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

export function createInMemoryFailureLimiter(
  clock: Clock = systemClock,
  maxFailures = 5,
  windowMs = 15 * 60 * 1000,
): FailureLimiter {
  const failures = new Map<string, number[]>();

  return {
    async check(key) {
      const now = clock.now().getTime();
      const kept = (failures.get(key) ?? []).filter((t) => t > now - windowMs);
      failures.set(key, kept);
      if (kept.length < maxFailures) return { blocked: false, retryAfterSeconds: 0 };
      return {
        blocked: true,
        retryAfterSeconds: Math.max(1, Math.ceil((kept[0] + windowMs - now) / 1000)),
      };
    },
    async record(key) {
      const now = clock.now().getTime();
      const kept = (failures.get(key) ?? []).filter((t) => t > now - windowMs);
      kept.push(now);
      failures.set(key, kept);
    },
    async reset(key) {
      failures.delete(key);
    },
  };
}
