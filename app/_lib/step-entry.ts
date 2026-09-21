/**
 * V2 · T2→T3 桥接 · C4 —— ActionStep 学习 / 项目入口（纯逻辑层）
 *
 * 设计边界（已冻结）：
 *   - 纯前端：零落库、零新增 API、零新增实体；
 *   - 不修改 Capability / ActionPlan / ActionStep 数据；
 *   - 站外检索仅为**辅助入口**，其结果不得被当作"用户已掌握的能力"；
 *   - 文案只描述"要做什么"，**绝不**断言用户已具备 / 已完成（事实安全）。
 *
 * 类型来源：3A 已把 LLM 的 type 折叠进标题前缀（[学习] / [实践] / [项目]）。
 * 前缀缺失或无法识别时必须**降级**为 GENERIC，不得报错、不得漏渲染。
 */

import { STEP_TYPE_BRACKET, STEP_TYPE_LABEL, STEP_TYPES } from '../../src/domain/action-plan/step-type.ts';

export type StepKind = 'LEARN' | 'PRACTICE' | 'PROJECT' | 'GENERIC';

/**
 * T3-A2-4 Phase 1：前缀映射**由共享契约派生**（`src/domain/action-plan/step-type.ts`），
 * 不再手写第二份拷贝 —— 服务端与前端因此不可能出现映射漂移。
 * 顺序 = `STEP_TYPES` 顺序（LEARN → PRACTICE → PROJECT），与契约前逐字一致。
 */
const PREFIX_TO_KIND: Array<readonly [string, StepKind]> = STEP_TYPES.map(
  (t) => [STEP_TYPE_BRACKET[t], t] as const,
);

/** 三种合法类型的标签直接来自共享契约；仅 GENERIC 是前端专有的降级类别 */
export const STEP_KIND_LABEL: Record<StepKind, string> = {
  ...STEP_TYPE_LABEL,
  GENERIC: '提升',
};

/**
 * 「下一步做什么」的静态指引。
 * 事实安全：只描述行动建议，不得出现"已掌握 / 已完成 / 你已经…"之类断言。
 */
export const STEP_KIND_GUIDANCE: Record<StepKind, string> = {
  LEARN: '建议系统学习该主题：选一门课程或官方文档，边学边动手写最小示例，不必追求一次学完。',
  PRACTICE: '建议动手实践：把上面的动作完整做一遍，保留可复现的步骤记录，遇到问题先记录再求解。',
  PROJECT: '建议做一个最小可展示的项目：挑一个小切口做完整，产出可复现的代码或文档，便于日后作为凭据。',
  GENERIC: '建议围绕这项要求补齐动作：先明确目标，再完成一个最小闭环，做完后回填可核验的证据。',
};

/** 站外检索仅作辅助资料入口；如需更换搜索引擎，只改这一处 */
export const SEARCH_ENGINE = 'https://www.bing.com/search?q=';

/**
 * 解析标题前缀得到步骤类型；无法识别时降级为 GENERIC。
 * 不修改标题本身（保持既有渲染不变）。
 */
export function parseStepKind(title: string): StepKind {
  const t = (title ?? '').trimStart();
  for (const [prefix, kind] of PREFIX_TO_KIND) {
    if (t.startsWith(prefix)) return kind;
  }
  return 'GENERIC';
}

/**
 * 由岗位要求生成站外资料检索链接。
 * 无有效要求时返回 null（不渲染该入口），避免产出空查询或误导性入口。
 */
export function buildSearchUrl(requirement: string | null | undefined): string | null {
  const q = (requirement ?? '').trim();
  if (q.length === 0) return null;
  return `${SEARCH_ENGINE}${encodeURIComponent(q)}`;
}
