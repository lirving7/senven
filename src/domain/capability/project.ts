/**
 * V2 · T2→T3 桥接 —— Skill → Capability 投影（纯函数层）
 *
 * 事实安全铁律（对应验收 B7）：
 *   1. 只投影 **CONFIRMED** 的简历事实条目（Skill）；UNCONFIRMED / INFERRED / MISSING 一律返回 null；
 *   2. 必须存在 ≥1 条**可用证据**（locator 与 excerpt 均非空），否则返回 null —— **fail closed**，
 *      宁可少显示一条 have，也绝不凭空制造一个 CONFIRMED 事实；
 *   3. 投影是**单向**的 Skill → Capability，不产生源条目之外的任何新事实；
 *   4. 证据按 (source, excerpt) 去重，保证重复投影不堆积。
 *
 * 这里刻意做成不依赖数据库的纯函数：事实安全规则必须能被独立、廉价地验证。
 */

export const PROJECTION_SOURCE = 'RESUME_PROJECTION';
export const PROJECTION_EVIDENCE_TYPE = 'RESUME_EVIDENCE';

/**
 * T3-A2-1 / R4：项目成果回流的来源与证据类型**正式常量**。
 * 禁止在代码中散落硬编码这些 token。
 * 注：`PROJECT_RESULT_EVIDENCE` 与活库 CHECK `ce_type_pointer_consistent` 的取值必须一致
 * （type='PROJECT_RESULT_EVIDENCE' ⇔ resultArtifactId 非空）。
 */
export const PROJECT_RESULT_SOURCE = 'PROJECT_RESULT';
export const PROJECT_RESULT_EVIDENCE_TYPE = 'PROJECT_RESULT_EVIDENCE';

export type ProjectableEvidence = {
  /** 源 Evidence 记录的主键，用于 provenance 回填 resumeEvidenceId */
  id: string;
  source: string;
  locator: string;
  excerpt: string | null;
};

export type ProjectableSkill = {
  key: string;
  label: string;
  level: string | null;
  /** 源条目的状态；只有 CONFIRMED 才可投影 */
  status: string;
  evidence: ProjectableEvidence[];
};

export type ProjectionEvidenceInput = {
  type: string;
  source: string;
  url: string | null;
  excerpt: string;
  /** provenance 指针：指向来源 Evidence.id（DMD §4.3 / Q-2） */
  resumeEvidenceId: string;
};

export type CapabilityProjectionInput = {
  key: string;
  label: string;
  level: string | null;
  status: 'CONFIRMED';
  source: string;
  evidence: ProjectionEvidenceInput[];
};

/** 可用证据：定位符与摘录都非空（与 confirmItem 的判定保持一致） */
export function usableEvidence(evidence: ProjectableEvidence[]): ProjectableEvidence[] {
  return evidence.filter((e) => e.locator.trim().length > 0 && (e.excerpt ?? '').trim().length > 0);
}

/** 证据去重键：同时用于写入去重与幂等比较（含源类型，避免跨源误判为同一条） */
export function evidenceKey(e: { source: string; excerpt: string | null }): string {
  return `${e.source}\u0000${(e.excerpt ?? '').trim()}`;
}

/**
 * 生成一条 Capability 的投影输入。
 * 返回 **null 表示不投影**（源条目非 CONFIRMED，或没有可用证据）—— fail closed。
 */
export function buildCapabilityProjection(skill: ProjectableSkill): CapabilityProjectionInput | null {
  if (skill.status !== 'CONFIRMED') return null;

  const usable = usableEvidence(skill.evidence);
  if (usable.length === 0) return null;

  const seen = new Set<string>();
  const evidence: ProjectionEvidenceInput[] = [];
  for (const e of usable) {
    const k = evidenceKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    evidence.push({
      type: PROJECTION_EVIDENCE_TYPE,
      source: e.source,
      url: null,
      excerpt: (e.excerpt ?? '').trim(),
      resumeEvidenceId: e.id,
    });
  }

  return {
    key: skill.key,
    label: skill.label,
    level: skill.level,
    status: 'CONFIRMED',
    source: PROJECTION_SOURCE,
    evidence,
  };
}
