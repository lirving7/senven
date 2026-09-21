/**
 * V2 · LLM 用量闸门（Usage Gate）
 *
 * 硬性顺序（对应验收 T2-A4 / T2-A5）：
 *   1. 先查配额（**在 provider 之前**）
 *   2. 配额不足 → 记 QUOTA_REJECTED（配额事件，requestCount=0）→ 抛 429，**provider 一次都不调用**
 *   3. 配额足够 → 调用 provider → 无论成功/失败都落 LlmUsage（token/cost/status）
 *
 * 「每次调用留痕」= 每次**实际进入 LLM generation 流程**，不是每次 HTTP 请求；
 * 配额拒绝属于配额事件，绝不伪装成一次 provider 调用。
 */
import { appError, ERROR_CODE } from '../errors.ts';
import { LLM_USAGE_STATUS } from '../ports/index.ts';
import type { Clock, LlmFeature, LlmUsageRepository } from '../ports/index.ts';
import type { JsonRequest, LLMProvider, LlmTokenUsage } from './provider.ts';
import { computeCost, quotaLimitFor, quotaWindowMs } from './quota.ts';

export type UsageGateDeps = {
  usage: LlmUsageRepository;
  clock: Clock;
};

export type UsageGateInput = {
  userId: string;
  feature: LlmFeature;
  provider: LLMProvider;
  request: JsonRequest;
};

export async function generateJsonWithUsage<T>(deps: UsageGateDeps, input: UsageGateInput): Promise<T> {
  const { userId, feature, provider, request } = input;
  const windowMs = quotaWindowMs();
  const now = deps.clock.now();
  const since = new Date(now.getTime() - windowMs);

  // ① 配额检查（provider 之前）
  const { count, oldest } = await deps.usage.countSince(userId, feature, since);
  const limit = quotaLimitFor(feature);

  if (count >= limit) {
    // 配额事件：requestCount=0，未发生 provider 调用
    await deps.usage.record({
      userId,
      feature,
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cost: 0,
      status: LLM_USAGE_STATUS.QUOTA_REJECTED,
    });
    const releaseAt = oldest ? oldest.getTime() + windowMs : now.getTime() + windowMs;
    throw appError(ERROR_CODE.LLM_QUOTA_EXCEEDED, '调用次数已达上限，请稍后再试', {
      retryAfterSeconds: Math.max(1, Math.ceil((releaseAt - now.getTime()) / 1000)),
    });
  }

  const write = (status: string, usage?: LlmTokenUsage) =>
    deps.usage.record({
      userId,
      feature,
      requestCount: 1,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      cost: computeCost(usage?.totalTokens ?? 0),
      status,
    });

  // ② provider 调用（仅配额足够时）
  let usage: LlmTokenUsage | undefined;
  try {
    if (provider.jsonWithUsage) {
      const res = await provider.jsonWithUsage<T>(request);
      usage = res.usage;
      await write(LLM_USAGE_STATUS.OK, usage);
      return res.value;
    }
    const value = await provider.json<T>(request);
    await write(LLM_USAGE_STATUS.OK, undefined);
    return value;
  } catch (err) {
    // ③ 失败同样留痕（超时 / 结构错误 / 上游 5xx）
    await write(LLM_USAGE_STATUS.FAILED, usage).catch(() => undefined);
    throw err;
  }
}
