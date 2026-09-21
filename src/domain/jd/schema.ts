import { z } from 'zod';

/** LLM 输出结构：服务端不信任模型输出，必须逐字段校验后才可使用 */
export const jdRequirementSchema = z.object({
  text: z.string().trim().min(1),
  category: z.enum(['HARD', 'TECH', 'DUTY', 'PLUS', 'EDUCATION', 'MAJOR', 'OTHER']),
  criticality: z.enum(['MUST', 'SHOULD', 'BONUS']),
});

export const jdLlmOutputSchema = z.object({
  title: z.string().nullish(),
  company: z.string().nullish(),
  requirements: z.array(jdRequirementSchema),
});

export type JdLlmOutput = z.infer<typeof jdLlmOutputSchema>;

/** 传给模型的 JSON schema 描述（用于 prompt 约束，不依赖厂商 strict 模式） */
export const JD_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: ['string', 'null'], description: '岗位名称，取不到填 null' },
    company: { type: ['string', 'null'], description: '公司名称，取不到填 null' },
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '逐字引用 JD 原文片段，不得改写或翻译' },
          category: {
            type: 'string',
            enum: ['HARD', 'TECH', 'DUTY', 'PLUS', 'EDUCATION', 'MAJOR', 'OTHER'],
          },
          criticality: { type: 'string', enum: ['MUST', 'SHOULD', 'BONUS'] },
        },
        required: ['text', 'category', 'criticality'],
      },
    },
  },
  required: ['requirements'],
};
