/**
 * T3-A2-1：ProjectResult → Candidate Capability 回流的**纯函数层**。
 *
 * 事实安全铁律（与 Architecture Freeze v1.1 的 D1 / D3 / D4 / D6-a 及 R4 对齐）：
 *   1. 回流**只能**产生 UNCONFIRMED 候选能力；CONFIRMED 依旧只能由用户经**唯一** confirm 入口产生。
 *   2. 可作为确认依据的来源必须「可验证」：凭据需有非空 URL，**不能仅凭 excerpt**。
 *   3. 已 revoke 的成果不再构成**当前有效**的确认依据（revoke 不删数据，只使其失效）。
 *   4. **来源分域（R3）**：存在 PROJECT_RESULT_EVIDENCE 的能力走项目闸门；
 *      不存在的能力**沿用既有 Resume 判据**，以保证既有简历来源语义不被扩大或破坏。
 *
 * 刻意做成不依赖数据库的纯函数：上述规则必须能被独立、廉价地验证。
 */

import { PROJECT_RESULT_EVIDENCE_TYPE } from '../capability/project.ts';

/** 可作为回流来源的成果状态：**仅 SUBMITTED**（Draft 未定稿、Revoked 已失效） */
export function canDeclareFromStatus(status: string): boolean {
  return status === 'SUBMITTED';
}

/** 可验证凭据判据：URL 去首尾空白后非空 */
export function isUrlBacked(url: string | null | undefined): boolean {
  return (url ?? '').trim().length > 0;
}

/** 供闸门求值的单条证据视图 */
export type ConfirmGateEvidence = {
  /** CapabilityEvidence.type */
  type: string;
  /** Resume 侧字段 */
  url: string | null;
  excerpt: string | null;
  /** Project 侧：所属 ResultArtifact.url */
  artifactUrl: string | null;
  /** Project 侧：所属 ProjectResult.revokedAt（null = 未撤销） */
  resultRevokedAt: Date | null;
};

/**
 * R3 确认闸门（来源分域）。
 *
 * - **存在** PROJECT_RESULT_EVIDENCE → 必须至少有一条满足：
 *     `ResultArtifact.url 非空` **且** `所属 ProjectResult.revokedAt IS NULL`
 * - **不存在** PROJECT_RESULT_EVIDENCE → 沿用既有 Resume 判据：`url ∥ excerpt` 非空
 *
 * 注意：本项目当前 26 条既有能力的证据**全部**为 RESUME_EVIDENCE，
 * 故一律走 Resume 分支，其确认语义与本改动前**完全一致**。
 */
export function evaluateConfirmGate(evidence: ConfirmGateEvidence[]): boolean {
  const projectEvidence = evidence.filter((e) => e.type === PROJECT_RESULT_EVIDENCE_TYPE);
  if (projectEvidence.length > 0) {
    return projectEvidence.some((e) => isUrlBacked(e.artifactUrl) && e.resultRevokedAt === null);
  }
  return evidence.some((e) => isUrlBacked(e.url) || (e.excerpt ?? '').trim().length > 0);
}
