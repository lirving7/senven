import type { JdParseResult } from './types.ts';
import type { Criticality, RequirementCategory } from './types.ts';
import type { PreviewTokenPayload } from './preview-token.ts';

export type JobRequirementCreateInput = {
  text: string;
  category: RequirementCategory;
  criticality: Criticality;
};

export type JobDescriptionCreateInput = {
  userId: string;
  rawText: string;
  title: string | null;
  company: string | null;
  /** 归一化 JD 文本的 sha256，用于「重复 JD」去重（可选） */
  contentHash?: string | null;
  reqs: { create: JobRequirementCreateInput[] };
};

/**
 * 纯函数映射：解析结果 → Prisma 写入形态。
 * 便于在不连数据库的情况下单测写入结构与数据隔离约束。
 *
 * userId 必须由调用方从**会话**取得；此函数拒绝空值，
 * 以在类型与运行时两道关口拦住「从请求体取 userId」的写法。
 */
export function toJobDescriptionCreateInput(
  result: JdParseResult,
  args: { userId: string; rawText: string; contentHash?: string | null },
): JobDescriptionCreateInput {
  if (!args.userId || args.userId.trim().length === 0) {
    throw new Error('userId 必须来自会话，不能为空或来自请求体');
  }
  if (result.requirements.length === 0) {
    throw new Error('拒绝写入：要求条目为空，避免产生无意义的 JD 记录');
  }

  return {
    userId: args.userId,
    rawText: args.rawText,
    title: result.title,
    company: result.company,
    contentHash: args.contentHash ?? null,
    reqs: {
      create: result.requirements.map((r) => ({
        text: r.text,
        category: r.category,
        criticality: r.criticality,
      })),
    },
  };
}

/**
 * 纯函数映射：preview token 载荷 → Prisma 写入形态。
 * 用户传入的 title/company 优先于解析结果；空字符串按 null 处理。
 */
export function toJobDescriptionCreateInputFromPreview(
  payload: PreviewTokenPayload,
  args: { userId: string; rawText: string; contentHash?: string | null; title?: string | null; company?: string | null },
): JobDescriptionCreateInput {
  if (!args.userId || args.userId.trim().length === 0) {
    throw new Error('userId 必须来自会话，不能为空或来自请求体');
  }
  if (payload.requirements.length === 0) {
    throw new Error('拒绝写入：要求条目为空，避免产生无意义的 JD 记录');
  }

  const title = args.title !== undefined ? args.title : payload.title;
  const company = args.company !== undefined ? args.company : payload.company;

  return {
    userId: args.userId,
    rawText: args.rawText,
    title,
    company,
    contentHash: args.contentHash ?? null,
    reqs: {
      create: payload.requirements.map((r) => ({
        text: r.text,
        category: r.category,
        criticality: r.criticality,
      })),
    },
  };
}
