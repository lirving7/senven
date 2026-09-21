import { createHash } from 'node:crypto';

export type ProjectResultStatus = 'DRAFT' | 'SUBMITTED' | 'REVOKED';

export type StepSnapshot = {
  sourceStepId: string;
  sourceStepTitle: string;
  sourceStepTargetRequirement: string | null;
};

/**
 * 规范化文本：NFKC + 统一换行为 LF + 去头尾空白。
 * 用于 contentFingerprint 与 excerpt-only 的 dedupeKey。
 */
export function normalizeFingerprintText(input: string): string {
  return input.normalize('NFKC').replace(/\r\n|\r/g, '\n').trim();
}

/**
 * URL canonicalization（Q10 正式契约）：
 * - 去首尾空白
 * - **只**对协议与 host/hostname 做 lowercase
 * - **保留** pathname 原始大小写（不得无条件 lowercase）
 * - **对 pathname 去除非根末尾斜杠**（先做；与 fragment / query 无关）
 * - **保留** query（不排序）
 * - **保留** fragment（不得删除；不得用 `url.hash` 判断空 fragment）
 * 正确顺序：**先对 pathname 去除非根 trailing slash，再保留 fragment**
 * （故 `https://h/a/#frag` → `https://h/a#frag`）。
 * 失败时回退到原字符串 trim。
 */
export function normalizeArtifactUrl(input: string): string {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    // 只动 pathname：避免「按完整 href 是否以 / 结尾判断」在带 fragment 时失效
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}

/**
 * Q8：Draft = NULL；提交时由服务端计算。
 * 确定性指纹：只依赖 sourceStepId / title / summary，不含 planId / userId / 时间戳 / UUID。
 */
export function computeContentFingerprint(sourceStepId: string, title: string, summary: string): string {
  const canonical = JSON.stringify({
    sourceStepId: normalizeFingerprintText(sourceStepId),
    title: normalizeFingerprintText(title),
    summary: normalizeFingerprintText(summary),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Q10：Artifact 去重键。
 * - 优先用 url（规范化后）作为 identity
 * - 无 url 时用 excerpt（NFKC / 换行统一 / trim）
 * - kind 统一大写参与哈希
 */
export function computeArtifactDedupeKey(
  kind: string,
  identity: { url?: string | null; excerpt?: string | null },
): string {
  const url = identity.url;
  const excerpt = identity.excerpt;
  const hasUrl = typeof url === 'string' && url.trim().length > 0;
  const identityValue = hasUrl ? normalizeArtifactUrl(url) : normalizeFingerprintText(excerpt ?? '');
  const canonical = JSON.stringify({
    kind: kind.toUpperCase(),
    identity: identityValue,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * 三态转换规则：Draft → Submitted → Revoked。
 * Revoked 为终态，不可恢复。
 */
export function canTransition(from: ProjectResultStatus, to: ProjectResultStatus): boolean {
  if (from === 'DRAFT' && to === 'SUBMITTED') return true;
  if (from === 'SUBMITTED' && to === 'REVOKED') return true;
  return false;
}

/**
 * 从 ActionStep 固化创建时快照。
 * sourceStepId 值保存，非 FK；regenerate 后允许悬空。
 */
export function snapshotFromStep(step: {
  id: string;
  title: string;
  targetRequirement?: string | null;
}): StepSnapshot {
  return {
    sourceStepId: step.id,
    sourceStepTitle: step.title,
    sourceStepTargetRequirement: step.targetRequirement ?? null,
  };
}

export function inferStatus(row: { submittedAt: Date | null; revokedAt: Date | null }): ProjectResultStatus {
  if (row.revokedAt) return 'REVOKED';
  if (row.submittedAt) return 'SUBMITTED';
  return 'DRAFT';
}
