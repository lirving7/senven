/**
 * T3-A2-4 · Phase 0 —— ActionStep → ProjectResult 提交入口（纯逻辑层）
 *
 * 设计边界（已授权范围）：
 *   - **零新增 API / 零新增实体 / 零 migration**：只负责构造既有 API 所需的 body；
 *   - 写操作**必须由用户显式点击触发**（本模块不含任何副作用，也不含任何自动触发逻辑）；
 *   - `ActionStep.status = DONE` **不得**成为创建 ProjectResult 的条件 —— 本模块
 *     完全不读取步骤状态，从构造上排除「DONE 自动生成成果」；
 *   - 不产生 CapabilityEvidence、不写 CONFIRMED（那属于「制作项目」页的显式声明/确认链路）。
 *
 * 与 C4 的分工：`step-entry.ts` 管「学什么 / 怎么查」的展示与指引（纯展示）；
 * 本模块管「如何把该步骤的成果提交为 ProjectResult」（构造请求体，仍不直接发请求）。
 */

import { parseStepKind, type StepKind } from './step-entry.ts';

/** 允许提交成果的步骤类型（A2-4 授权：优先支持 [学习] / [项目]） */
export const RESULT_ENTRY_KINDS: readonly StepKind[] = ['LEARN', 'PROJECT'];

/** 该步骤类型是否显示「提交成果」入口 */
export function canSubmitResultForKind(kind: StepKind): boolean {
  return RESULT_ENTRY_KINDS.includes(kind);
}

/** 由标题前缀判断是否显示入口（不修改标题本身） */
export function canSubmitResultForTitle(title: string): boolean {
  return canSubmitResultForKind(parseStepKind(title));
}

/** 标题前缀（与服务端 STEP_TYPE_LABEL 折叠进标题的形式一致） */
const TITLE_PREFIXES = ['[学习]', '[实践]', '[项目]'] as const;

/**
 * 成果标题预填：去掉步骤标题的类型前缀，去掉首尾空白。
 * 若去掉前缀后为空（如标题仅 `[项目]`），退回原始标题，避免预填成空串。
 */
export function buildResultTitlePrefill(stepTitle: string): string {
  const raw = (stepTitle ?? '').trim();
  for (const prefix of TITLE_PREFIXES) {
    if (raw.startsWith(prefix)) {
      const stripped = raw.slice(prefix.length).trim();
      return stripped.length > 0 ? stripped : raw;
    }
  }
  return raw;
}

export type CreateResultBody = {
  planId: string;
  sourceStepId: string;
  title: string;
  summary: string;
};

/**
 * 构造 `POST /api/project-results` 的 body。
 * 字段与 `CreateBodySchema`（strict）逐字对应 —— 只含 4 个键，**绝不**附带 userId 等字段。
 * planId / sourceStepId 必须来自当前页面上下文（不来自任何用户自由输入）。
 */
export function buildCreateResultBody(input: {
  planId: string;
  sourceStepId: string;
  title: string;
  summary: string;
}): CreateResultBody {
  return {
    planId: input.planId.trim(),
    sourceStepId: input.sourceStepId.trim(),
    title: input.title.trim(),
    summary: input.summary.trim(),
  };
}

export const ARTIFACT_KINDS = ['REPO', 'DEPLOY', 'DOC', 'SCREENSHOT', 'OTHER'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export type ArtifactBody = { kind: ArtifactKind; url?: string; excerpt?: string };

/**
 * 构造 `POST /api/project-results/:id/artifacts` 的 body。
 * - url / excerpt 均为空 → 返回 **null**（调用方据此跳过添加凭据，而不是发一个必然 400 的请求）；
 * - 只带非空字段；不夹带其他键（schema 为 strict）。
 */
export function buildArtifactBody(input: {
  kind: string;
  url?: string | null;
  excerpt?: string | null;
}): ArtifactBody | null {
  const url = (input.url ?? '').trim();
  const excerpt = (input.excerpt ?? '').trim();
  if (url.length === 0 && excerpt.length === 0) return null;

  const kind = (ARTIFACT_KINDS as readonly string[]).includes(input.kind)
    ? (input.kind as ArtifactKind)
    : 'OTHER';

  return {
    kind,
    ...(url.length === 0 ? {} : { url }),
    ...(excerpt.length === 0 ? {} : { excerpt }),
  };
}

/** 前置校验：标题与说明必填（与 A2-1/A2-2 无关，仅本地提示，服务端仍会再校验一次） */
export function validateResultDraftInput(title: string, summary: string): { ok: true } | { ok: false; reason: string } {
  if (title.trim().length === 0) return { ok: false, reason: '请填写成果标题' };
  if (summary.trim().length === 0) return { ok: false, reason: '请填写成果说明' };
  return { ok: true };
}

/**
 * 「提交」而非「存草稿」时，必须先有至少一条凭据 —— 否则服务端会以
 * `RESULT_HAS_NO_ARTIFACT`(422) 拒绝。这里提前给出可读提示，避免无意义请求。
 */
export function canSubmitImmediately(hasArtifactInput: boolean): boolean {
  return hasArtifactInput;
}
