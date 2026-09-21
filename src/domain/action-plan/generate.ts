import { z } from 'zod';

import { LLMFormatError } from '../../llm/provider.ts';
import type { CapabilityRecord } from '../../ports/index.ts';
import type { MatchItemOutput } from '../match/types.ts';

/**
 * V2 · T2 岗位行动计划 —— LLM 生成契约与事实派生。
 *
 * 事实安全铁律（对应验收 A5）：
 *   - `have`（已有能力）**只能来自 CONFIRMED 用户事实**，由服务端从 Capability 计算，绝不信任 LLM。
 *   - `gaps`（能力缺口）**只能来自 MatchRun 的缺口**，由服务端计算，绝不信任 LLM。
 *   - `actions`（建议行动）才是 LLM 的创造性输出；LLM 即便在 have/gaps 里编造，也会被服务端覆盖。
 */

export const ACTION_PLAN_SYSTEM_PROMPT = [
  '你是求职能力规划助手。根据用户已确认的能力与岗位缺口，生成可执行的提升行动计划。',
  '',
  '硬性约束：',
  '1. have 字段必须直接回显下方给出的「用户已确认能力」，不得新增、改写或编造任何能力。',
  '2. gaps 字段必须直接回显下方给出的「岗位缺口」，不得新增或改写。',
  '3. actions 是你唯一可以创造性产出的部分：针对缺口给出具体提升建议。',
  '4. actions 每条必须含 title（简短动作）、desc（具体做法）、type（LEARN 学习 / PRACTICE 实践 / PROJECT 项目）、targetRequirement（对应的岗位要求原文，可空）。',
  '5. 只输出 JSON，不要输出解释性文字或 Markdown 代码块。',
  '6. 字段名必须严格是 have / gaps / actions，不要用别的名字。',
  '',
  '输出示例：',
  '{"have":[{"id":"c1","key":"python","label":"Python","level":"熟练"}],"gaps":[{"requirement":"熟悉 Kubernetes","category":"TECH","criticality":"NICE"}],"actions":[{"title":"完成 K8s 实战课程","desc":"用 minikube 部署一个含 3 个服务的 demo","type":"LEARN","targetRequirement":"熟悉 Kubernetes"}]}',
].join('\n');

export const ACTION_PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    have: { type: 'array', items: { type: 'object' } },
    gaps: { type: 'array', items: { type: 'object' } },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          desc: { type: 'string' },
          type: { type: 'string' },
          targetRequirement: { type: 'string' },
        },
        required: ['title', 'desc'],
      },
    },
  },
  required: ['have', 'gaps', 'actions'],
};

const actionItemSchema = z.object({
  title: z.string().trim().min(1),
  desc: z.string().trim().min(1),
  type: z.string().trim().optional(),
  targetRequirement: z.string().trim().optional(),
});

export const actionPlanOutputSchema = z.object({
  // have / gaps 一律由服务端从 CONFIRMED 事实与 MatchRun 缺口派生并覆盖（A5），
  // LLM 这两个字段不参与落库，因此**不设结构卡口**：
  // 提示词要求 LLM「原样回显」上下文里的对象，而 confirmedHave 只含 key/label/level（无 id）；
  // 若此处强制 id/key/label，会把一次完全正常的回显误判为结构错误 → 502。
  have: z.array(z.unknown()).optional().default([]),
  gaps: z.array(z.unknown()).optional().default([]),
  // actions 才是 LLM 的创造性产出，也是唯一落库的部分 —— 必须严格校验。
  actions: z.array(actionItemSchema).min(1, '至少需要一条建议行动'),
});

export type ActionPlanLLMOutput = z.infer<typeof actionPlanOutputSchema>;

export type ActionPlanContext = {
  goal: string;
  confirmedHave: Array<{ key: string; label: string; level: string | null }>;
  gaps: Array<{ requirement: string; category: string; criticality: string }>;
};

export function buildActionPlanPrompt(ctx: ActionPlanContext): string {
  return [
    `目标岗位：${ctx.goal}`,
    '',
    `用户已确认的能力（事实来源，原样放进 have）：\n${JSON.stringify(ctx.confirmedHave, null, 2)}`,
    '',
    `岗位缺口（原样放进 gaps）：\n${JSON.stringify(ctx.gaps, null, 2)}`,
    '',
    '请基于以上生成提升行动计划，只输出 JSON：{ "have": [...], "gaps": [...], "actions": [...] }。',
    'have 与 gaps 直接回显上面给出的值，不要改写或编造；actions 针对缺口给出可执行的提升建议。',
  ].join('\n');
}

/**
 * 服务端事实派生：have 只来自 CONFIRMED 能力，gaps 只来自 MatchRun 缺口（MISSING / ENHANCE）。
 * 这是 A5 事实安全的最终防线 —— LLM 的输出在此被覆盖。
 */
export function deriveHaveGaps(
  confirmedCapabilities: CapabilityRecord[],
  matchItems: MatchItemOutput[],
): { have: unknown[]; gaps: unknown[] } {
  const have = confirmedCapabilities
    .filter((c) => c.status === 'CONFIRMED')
    .map((c) => ({ id: c.id, key: c.key, label: c.label, level: c.level }));

  const gaps = matchItems
    .filter((i) => i.status === 'MISSING' || i.status === 'ENHANCE')
    .map((i) => ({ requirement: i.requirement, category: i.category, criticality: i.criticality }));

  return { have, gaps };
}

/** 校验 LLM 原始输出；结构不符抛 LLMFormatError（→ 502，且不写库，满足 A3） */
export function parseActionPlanOutput(raw: unknown, providerName: string): ActionPlanLLMOutput {
  const parsed = actionPlanOutputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LLMFormatError(
      `行动计划返回结构不符：${parsed.error.issues.map((i) => i.message).join('；')}`,
      providerName,
    );
  }
  return parsed.data;
}
